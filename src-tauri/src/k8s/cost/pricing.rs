use anyhow::Result;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use super::types::{NodeInfo, PricingResolveRequest, PricingResolveResponse, ResolvedPricing};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRICING_RESOLVE_URL: &str = "https://www.kdashboard.app/api/pricing/resolve";

pub(super) static RESOLVED_PRICING: Mutex<Option<ResolvedPricing>> =
    tokio::sync::Mutex::const_new(None);

const RESOLVED_PRICING_TTL: Duration = Duration::from_secs(86400); // 24 hours

// ---------------------------------------------------------------------------
// HTTP client singleton
// ---------------------------------------------------------------------------

fn http_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|e| {
                tracing::error!(
                    "Failed to create HTTP client with timeout: {}, falling back to default",
                    e
                );
                reqwest::Client::new()
            })
    })
}

// ---------------------------------------------------------------------------
// Resolve pricing via server API
// ---------------------------------------------------------------------------

/// Resolve pricing for a set of nodes by calling the server API.
/// Only sends the unique instance types — response is < 1 KB typically.
pub(super) async fn resolve_pricing(nodes: &[NodeInfo]) -> Option<HashMap<String, f64>> {
    // Check cache
    {
        let cache = RESOLVED_PRICING.lock().await;
        if let Some(ref cached) = *cache {
            if cached.expires_at > Instant::now() {
                return Some(cached.prices.clone());
            }
        }
    }

    // Build unique node specs
    let mut seen = std::collections::HashSet::new();
    let mut specs = Vec::new();
    for node in nodes {
        let key = format!("{}/{}/{}", node.provider, node.region, node.instance_type);
        if seen.insert(key) {
            specs.push(PricingResolveRequest {
                provider: node.provider.clone(),
                region: node.region.clone(),
                instance_type: node.instance_type.clone(),
            });
        }
    }

    if specs.is_empty() {
        return None;
    }

    let http = http_client();

    let resp = match http.post(PRICING_RESOLVE_URL).json(&specs).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Failed to resolve pricing: {}", e);
            return None;
        }
    };

    if !resp.status().is_success() {
        tracing::warn!("Pricing resolve API returned {}", resp.status());
        return None;
    }

    match resp.json::<PricingResolveResponse>().await {
        Ok(data) => {
            let mut prices = HashMap::new();
            for item in &data.results {
                prices.insert(item.key.clone(), item.price_per_hour);
            }
            tracing::info!(
                resolved = data.resolved,
                total = data.total,
                "pricing_resolved"
            );

            // Cache results
            let mut cache = RESOLVED_PRICING.lock().await;
            *cache = Some(ResolvedPricing {
                prices: prices.clone(),
                expires_at: Instant::now() + RESOLVED_PRICING_TTL,
            });

            Some(prices)
        }
        Err(e) => {
            tracing::warn!("Failed to parse pricing response: {}", e);
            None
        }
    }
}

/// Force-refresh pricing by clearing cache and re-resolving.
pub async fn refresh_pricing() -> Result<()> {
    {
        let mut cache = RESOLVED_PRICING.lock().await;
        *cache = None;
    }
    {
        let mut cache = super::calculations::COST_CACHE.lock().await;
        *cache = None;
    }
    Ok(())
}
