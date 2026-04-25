//! Pricing resolver backed by the daily-refreshed dataset published as
//! GitHub release assets (see `.github/workflows/update-pricing.yml`).
//!
//! Strategy:
//! 1. For each unique provider in the requested nodes, ensure the provider's
//!    dataset is loaded (memory → disk cache → network fetch, in that order).
//! 2. Resolve `(provider, region, instance_type) -> $/hour` purely in-memory.
//!
//! Cache layers:
//! - In-memory `HashMap<provider, ProviderDataset>` with 24h TTL — survives the
//!   process lifetime, refreshed lazily.
//! - Disk cache at `~/.kdashboard/pricing/<provider>.json` with the same TTL —
//!   survives restarts and offline boots.
//!
//! Failure mode: if both network and disk fail, returns `None` and the caller
//! falls back to hardcoded rates. If the network fails but a stale disk cache
//! exists, we use the stale cache rather than nothing.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::Mutex;

use super::types::NodeInfo;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRICING_BASE_URL: &str =
    "https://github.com/folio-pro/kdashboard/releases/download/pricing-data";

const SUPPORTED_PROVIDERS: &[&str] = &["aws", "azure", "gcp"];

const DATASET_TTL: Duration = Duration::from_secs(86400); // 24 hours

const DISK_CACHE_DIR: &str = ".kdashboard/pricing";

// ---------------------------------------------------------------------------
// Dataset shape (matches scripts/fetch-pricing.ts output)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct InstancePrice {
    #[allow(dead_code)]
    vcpu: f64,
    #[allow(dead_code)]
    memory_gb: f64,
    ondemand_usd_hour: Option<f64>,
    #[allow(dead_code)]
    spot_usd_hour: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct RawDataset {
    #[allow(dead_code)]
    version: String,
    #[allow(dead_code)]
    generated_at: String,
    /// region -> instance_type -> price entry
    instances: HashMap<String, HashMap<String, InstancePrice>>,
}

struct ProviderDataset {
    /// region -> instance_type -> on-demand $/hour
    prices: HashMap<String, HashMap<String, f64>>,
    expires_at: Instant,
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

static DATASET_CACHE: Mutex<Option<HashMap<String, ProviderDataset>>> =
    tokio::sync::Mutex::const_new(None);

fn http_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|e| {
                tracing::error!(error = %e, "pricing http client init failed, using default");
                reqwest::Client::new()
            })
    })
}

fn pricing_base_url() -> String {
    std::env::var("KDASHBOARD_PRICING_URL").unwrap_or_else(|_| PRICING_BASE_URL.to_string())
}

fn disk_cache_path(provider: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(DISK_CACHE_DIR).join(format!("{provider}.json")))
}

// ---------------------------------------------------------------------------
// Disk cache helpers
// ---------------------------------------------------------------------------

async fn read_disk_cache(provider: &str) -> Option<(String, bool)> {
    let path = disk_cache_path(provider)?;
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    let modified = metadata.modified().ok()?;
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or(Duration::ZERO);
    let fresh = age < DATASET_TTL;

    let contents = tokio::fs::read_to_string(&path).await.ok()?;
    Some((contents, fresh))
}

async fn write_disk_cache(provider: &str, contents: &str) -> Result<()> {
    let path = disk_cache_path(provider).context("home dir unavailable")?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .with_context(|| format!("create_dir_all {dir:?}"))?;
    }
    tokio::fs::write(&path, contents)
        .await
        .with_context(|| format!("write {path:?}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

async fn fetch_dataset_from_network(provider: &str) -> Result<String> {
    let url = format!("{}/{}.json", pricing_base_url(), provider);
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("pricing fetch returned {}", resp.status());
    }
    let body = resp.text().await.context("read pricing body")?;
    Ok(body)
}

fn parse_dataset(json: &str) -> Result<ProviderDataset> {
    let raw: RawDataset = serde_json::from_str(json).context("parse pricing dataset")?;
    let mut prices: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for (region, types) in raw.instances {
        let mut region_prices: HashMap<String, f64> = HashMap::new();
        for (instance_type, price) in types {
            if let Some(p) = price.ondemand_usd_hour {
                if p > 0.0 {
                    region_prices.insert(instance_type, p);
                }
            }
        }
        if !region_prices.is_empty() {
            prices.insert(region, region_prices);
        }
    }
    Ok(ProviderDataset {
        prices,
        expires_at: Instant::now() + DATASET_TTL,
    })
}

// ---------------------------------------------------------------------------
// Ensure a dataset is available for a provider.
// Order: memory cache → fresh disk → network → stale disk fallback.
// ---------------------------------------------------------------------------

async fn ensure_dataset_loaded(provider: &str) -> bool {
    {
        let cache = DATASET_CACHE.lock().await;
        if let Some(map) = cache.as_ref() {
            if let Some(ds) = map.get(provider) {
                if ds.expires_at > Instant::now() {
                    return true;
                }
            }
        }
    }

    // Try fresh disk cache
    if let Some((contents, fresh)) = read_disk_cache(provider).await {
        if fresh {
            match parse_dataset(&contents) {
                Ok(ds) => {
                    install_dataset(provider, ds).await;
                    return true;
                }
                Err(e) => {
                    tracing::warn!(provider, error = %e, "disk cache corrupt, will refetch");
                }
            }
        }
    }

    // Network fetch
    match fetch_dataset_from_network(provider).await {
        Ok(body) => match parse_dataset(&body) {
            Ok(ds) => {
                if let Err(e) = write_disk_cache(provider, &body).await {
                    tracing::warn!(provider, error = %e, "disk cache write failed");
                }
                install_dataset(provider, ds).await;
                return true;
            }
            Err(e) => {
                tracing::warn!(provider, error = %e, "pricing dataset parse failed");
            }
        },
        Err(e) => {
            tracing::warn!(provider, error = %e, "pricing dataset fetch failed");
        }
    }

    // Last resort: stale disk cache
    if let Some((contents, _)) = read_disk_cache(provider).await {
        match parse_dataset(&contents) {
            Ok(ds) => {
                tracing::info!(provider, "using stale disk cache (network unreachable)");
                install_dataset(provider, ds).await;
                return true;
            }
            Err(e) => {
                tracing::warn!(provider, error = %e, "stale disk cache also unreadable");
            }
        }
    }

    false
}

async fn install_dataset(provider: &str, ds: ProviderDataset) {
    let mut cache = DATASET_CACHE.lock().await;
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(provider.to_string(), ds);
}

// ---------------------------------------------------------------------------
// Public API: same signature as before — keys are "provider/region/instance_type".
// ---------------------------------------------------------------------------

pub(super) async fn resolve_pricing(nodes: &[NodeInfo]) -> Option<HashMap<String, f64>> {
    if nodes.is_empty() {
        return None;
    }

    let mut providers: Vec<&str> = nodes
        .iter()
        .map(|n| n.provider.as_str())
        .filter(|p| SUPPORTED_PROVIDERS.contains(p))
        .collect();
    providers.sort_unstable();
    providers.dedup();

    if providers.is_empty() {
        return None;
    }

    for provider in &providers {
        ensure_dataset_loaded(provider).await;
    }

    let cache = DATASET_CACHE.lock().await;
    let map = cache.as_ref()?;

    let mut prices: HashMap<String, f64> = HashMap::new();
    for node in nodes {
        let Some(ds) = map.get(&node.provider) else {
            continue;
        };
        let Some(by_region) = ds.prices.get(&node.region) else {
            continue;
        };
        let Some(price) = by_region.get(&node.instance_type) else {
            continue;
        };
        let key = format!("{}/{}/{}", node.provider, node.region, node.instance_type);
        prices.insert(key, *price);
    }

    if prices.is_empty() {
        tracing::info!(
            providers_loaded = providers.len(),
            "pricing dataset loaded but no nodes matched any region/instance_type"
        );
        None
    } else {
        Some(prices)
    }
}

/// Force-refresh pricing by clearing in-memory caches. Disk cache is left in
/// place — next call will refetch from network and overwrite it.
pub async fn refresh_pricing() -> Result<()> {
    {
        let mut cache = DATASET_CACHE.lock().await;
        *cache = None;
    }
    {
        let mut cache = super::calculations::COST_CACHE.lock().await;
        *cache = None;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_JSON: &str = r#"{
        "version": "2026-04-25",
        "generated_at": "2026-04-25T20:17:18Z",
        "source": "https://example.test",
        "provider": "aws",
        "region_count": 1,
        "instance_count": 2,
        "instances": {
            "us-east-1": {
                "m5.large": { "vcpu": 2, "memory_gb": 8, "ondemand_usd_hour": 0.096, "spot_usd_hour": 0.04 },
                "broken": { "vcpu": 1, "memory_gb": 1, "ondemand_usd_hour": null, "spot_usd_hour": null }
            }
        }
    }"#;

    #[test]
    fn parse_dataset_skips_null_prices() {
        let ds = parse_dataset(SAMPLE_JSON).expect("parses");
        let region = ds.prices.get("us-east-1").expect("region");
        assert_eq!(region.get("m5.large").copied(), Some(0.096));
        assert!(region.get("broken").is_none(), "null prices must be filtered");
    }

    #[test]
    fn parse_dataset_drops_zero_priced_entries() {
        let json = r#"{
            "version": "x", "generated_at": "x", "source": "x", "provider": "aws",
            "region_count": 1, "instance_count": 1,
            "instances": { "r": { "i": { "vcpu": 1, "memory_gb": 1, "ondemand_usd_hour": 0, "spot_usd_hour": null } } }
        }"#;
        let ds = parse_dataset(json).expect("parses");
        assert!(
            ds.prices.get("r").is_none(),
            "regions with zero-priced entries become empty and are dropped"
        );
    }

    #[test]
    fn parse_dataset_rejects_invalid_json() {
        match parse_dataset("{ not json") {
            Ok(_) => panic!("expected parse error"),
            Err(e) => assert!(e.to_string().contains("parse"), "unexpected error: {e}"),
        }
    }

    #[tokio::test]
    async fn resolve_pricing_returns_none_when_unsupported_provider() {
        let nodes = vec![NodeInfo {
            name: "n1".into(),
            instance_type: "x".into(),
            provider: "openstack".into(),
            region: "r".into(),
            cpu_capacity: 1.0,
            memory_capacity_bytes: 1.0,
        }];
        assert!(resolve_pricing(&nodes).await.is_none());
    }

    #[tokio::test]
    async fn resolve_pricing_returns_none_for_empty_input() {
        assert!(resolve_pricing(&[]).await.is_none());
    }

    /// Live network test against the actual GitHub release. Ignored by default —
    /// run with `cargo test --lib cost::pricing -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn resolve_pricing_against_real_release() {
        let nodes = vec![
            NodeInfo {
                name: "aws-1".into(),
                instance_type: "m5.large".into(),
                provider: "aws".into(),
                region: "us-east-1".into(),
                cpu_capacity: 2.0,
                memory_capacity_bytes: 8.0 * 1024.0 * 1024.0 * 1024.0,
            },
            NodeInfo {
                name: "gcp-1".into(),
                instance_type: "e2-standard-4".into(),
                provider: "gcp".into(),
                region: "us-central1".into(),
                cpu_capacity: 4.0,
                memory_capacity_bytes: 16.0 * 1024.0 * 1024.0 * 1024.0,
            },
        ];

        let prices = resolve_pricing(&nodes).await.expect("got prices");
        assert!(
            prices.contains_key("aws/us-east-1/m5.large"),
            "missing aws m5.large: {prices:?}"
        );
        assert!(
            prices.contains_key("gcp/us-central1/e2-standard-4"),
            "missing gcp e2-standard-4: {prices:?}"
        );
        for (k, v) in &prices {
            assert!(*v > 0.0 && *v < 100.0, "implausible price for {k}: {v}");
        }
    }
}
