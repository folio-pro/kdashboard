//! Pricing resolver backed by the daily-refreshed dataset published as
//! GitHub release assets (see `.github/workflows/update-pricing.yml`).
//!
//! Strategy:
//! 1. For each unique provider in the requested nodes, ensure the provider's
//!    dataset is loaded (memory → fresh disk → conditional fetch → stale disk).
//! 2. Resolve `(provider, region, instance_type) -> $/hour` purely in-memory.
//!
//! Cache layers:
//! - In-memory `HashMap<provider, ProviderDataset>` with 24h TTL.
//! - Disk: `~/.kdashboard/pricing/<provider>.json` (the body) plus
//!   `~/.kdashboard/pricing/<provider>.meta.json` (`{ etag, fetched_at }`).
//!
//! Bandwidth optimisation: every network refresh sends `If-None-Match: <etag>`.
//! GitHub release assets honour this and return 304 when the file is unchanged,
//! so a daily revalidation of an unchanged dataset costs ~0 bytes of body.
//!
//! A background task started via [`spawn_periodic_refresh`] revalidates every
//! provider currently in the memory cache once every 24h, so a long-running
//! app never goes more than a day without a freshness check.
//!
//! Failure mode: if both network and disk fail, returns `None` and the caller
//! falls back to hardcoded rates. If the network fails but a stale disk cache
//! exists, we use the stale cache rather than nothing.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use super::types::NodeInfo;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRICING_BASE_URL: &str =
    "https://github.com/folio-pro/kdashboard/releases/download/pricing-data";

const SUPPORTED_PROVIDERS: &[&str] = &["aws", "azure", "gcp"];

const DATASET_TTL: Duration = Duration::from_secs(86400); // 24h
/// TTL applied when we install a dataset whose freshness we could NOT validate
/// (network down + only a stale disk cache available). Short so the next
/// `resolve_pricing` call retries the network instead of serving the
/// unvalidated bytes for a full day.
const STALE_RETRY_TTL: Duration = Duration::from_secs(300); // 5 minutes
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

#[derive(Debug, Default, Serialize, Deserialize)]
struct DatasetMeta {
    etag: Option<String>,
    /// epoch seconds — used to compute disk cache freshness.
    fetched_at: u64,
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

fn cache_root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(DISK_CACHE_DIR))
}

fn dataset_path(provider: &str) -> Option<PathBuf> {
    Some(cache_root()?.join(format!("{provider}.json")))
}

fn meta_path(provider: &str) -> Option<PathBuf> {
    Some(cache_root()?.join(format!("{provider}.meta.json")))
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn meta_is_fresh(meta: &DatasetMeta) -> bool {
    let now = now_epoch_seconds();
    let age = now.saturating_sub(meta.fetched_at);
    age < DATASET_TTL.as_secs()
}

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

async fn read_disk_meta(provider: &str) -> Option<DatasetMeta> {
    let path = meta_path(provider)?;
    let raw = tokio::fs::read_to_string(&path).await.ok()?;
    serde_json::from_str(&raw).ok()
}

async fn write_disk_meta(provider: &str, meta: &DatasetMeta) -> Result<()> {
    let path = meta_path(provider).context("home dir unavailable")?;
    let body = serde_json::to_string(meta).context("serialise meta")?;
    atomic_write(&path, body.as_bytes()).await
}

async fn read_disk_body(provider: &str) -> Option<String> {
    tokio::fs::read_to_string(dataset_path(provider)?).await.ok()
}

async fn write_disk_body(provider: &str, body: &str) -> Result<()> {
    let path = dataset_path(provider).context("home dir unavailable")?;
    atomic_write(&path, body.as_bytes()).await
}

/// Crash-safe replacement of `path` with `contents`. Writes to a uniquely-named
/// temp sibling first, then atomically renames it onto the target. If the
/// process dies mid-write, the previous file at `path` is untouched and the
/// orphaned temp file can be ignored or cleaned up later — it never partially
/// replaces real cache content. Multiple concurrent callers writing to the
/// same `path` get distinct temp names (process id + monotonic counter), so
/// they don't clobber each other's intermediate writes.
async fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .with_context(|| format!("create_dir_all {dir:?}"))?;
    }

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let tmp_path = {
        let mut name = path.as_os_str().to_os_string();
        name.push(format!(
            ".tmp.{}.{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        PathBuf::from(name)
    };

    if let Err(e) = tokio::fs::write(&tmp_path, contents).await {
        return Err(anyhow::Error::from(e))
            .with_context(|| format!("write temp {tmp_path:?} for {path:?}"));
    }

    if let Err(e) = tokio::fs::rename(&tmp_path, path).await {
        // Best-effort cleanup; the orphan temp is harmless if this also fails.
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(anyhow::Error::from(e))
            .with_context(|| format!("rename {tmp_path:?} -> {path:?}"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Network: conditional fetch with If-None-Match.
// Returns Ok(None) when the server replies 304 Not Modified.
// ---------------------------------------------------------------------------

struct FetchedDataset {
    body: String,
    etag: Option<String>,
}

async fn fetch_dataset_conditional(
    provider: &str,
    prev_etag: Option<&str>,
) -> Result<Option<FetchedDataset>> {
    let url = format!("{}/{}.json", pricing_base_url(), provider);
    let mut req = http_client().get(&url);
    if let Some(etag) = prev_etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }

    let resp = req.send().await.with_context(|| format!("GET {url}"))?;
    let status = resp.status();

    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !status.is_success() {
        anyhow::bail!("pricing fetch returned {status}");
    }

    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp.text().await.context("read pricing body")?;
    Ok(Some(FetchedDataset { body, etag }))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

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
// Memory cache helpers
// ---------------------------------------------------------------------------

async fn install_dataset(provider: &str, ds: ProviderDataset) {
    let mut cache = DATASET_CACHE.lock().await;
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(provider.to_string(), ds);
}

async fn extend_memory_expiry(provider: &str) {
    let mut cache = DATASET_CACHE.lock().await;
    if let Some(map) = cache.as_mut() {
        if let Some(ds) = map.get_mut(provider) {
            ds.expires_at = Instant::now() + DATASET_TTL;
        }
    }
}

async fn memory_has_fresh(provider: &str) -> bool {
    let cache = DATASET_CACHE.lock().await;
    cache
        .as_ref()
        .and_then(|m| m.get(provider))
        .map(|ds| ds.expires_at > Instant::now())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// ensure_dataset_loaded — main path
// ---------------------------------------------------------------------------

async fn ensure_dataset_loaded(provider: &str) -> bool {
    if memory_has_fresh(provider).await {
        return true;
    }

    let meta = read_disk_meta(provider).await.unwrap_or_default();

    // Fresh disk cache → load directly, no network.
    if meta_is_fresh(&meta) {
        if let Some(body) = read_disk_body(provider).await {
            match parse_dataset(&body) {
                Ok(ds) => {
                    install_dataset(provider, ds).await;
                    return true;
                }
                Err(e) => {
                    tracing::warn!(provider, error = %e, "fresh disk cache corrupt, will refetch");
                }
            }
        }
    }

    // Stale or missing disk → conditional fetch.
    match fetch_dataset_conditional(provider, meta.etag.as_deref()).await {
        Ok(Some(fetched)) => {
            // 200 — body changed (or first fetch). Persist new body + meta.
            if let Err(e) = write_disk_body(provider, &fetched.body).await {
                tracing::warn!(provider, error = %e, "disk body write failed");
            }
            let new_meta = DatasetMeta {
                etag: fetched.etag.clone(),
                fetched_at: now_epoch_seconds(),
            };
            if let Err(e) = write_disk_meta(provider, &new_meta).await {
                tracing::warn!(provider, error = %e, "disk meta write failed");
            }
            match parse_dataset(&fetched.body) {
                Ok(ds) => {
                    tracing::info!(provider, etag = ?new_meta.etag, "pricing dataset updated");
                    install_dataset(provider, ds).await;
                    return true;
                }
                Err(e) => {
                    tracing::warn!(provider, error = %e, "downloaded dataset failed to parse");
                }
            }
        }
        Ok(None) => {
            // 304 — body unchanged. Touch the meta so we don't revalidate again
            // for another 24h, and reload from disk.
            tracing::debug!(provider, "pricing dataset unchanged (304)");
            let touched = DatasetMeta {
                etag: meta.etag.clone(),
                fetched_at: now_epoch_seconds(),
            };
            if let Err(e) = write_disk_meta(provider, &touched).await {
                tracing::warn!(provider, error = %e, "touch disk meta failed");
            }
            if let Some(body) = read_disk_body(provider).await {
                match parse_dataset(&body) {
                    Ok(ds) => {
                        install_dataset(provider, ds).await;
                        return true;
                    }
                    Err(e) => {
                        tracing::warn!(provider, error = %e, "disk body unreadable after 304");
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(provider, error = %e, "pricing dataset fetch failed");
        }
    }

    // Last resort: stale disk body. We could not validate freshness against
    // either the meta TTL or the network, so apply a short TTL — the next
    // resolve_pricing call (5 minutes from now) will retry the network instead
    // of serving these unvalidated bytes for a full day.
    if let Some(body) = read_disk_body(provider).await {
        if let Ok(mut ds) = parse_dataset(&body) {
            ds.expires_at = Instant::now() + STALE_RETRY_TTL;
            tracing::info!(
                provider,
                retry_in_secs = STALE_RETRY_TTL.as_secs(),
                "using stale disk cache (network unreachable), short TTL"
            );
            install_dataset(provider, ds).await;
            return true;
        }
    }
    false
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

/// Force-clear the in-memory pricing cache and the cost overview cache. Disk
/// state is left in place — the next call refetches conditionally and a 304 is
/// usually free.
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

/// Revalidate one provider's dataset against the network (uses ETag — usually a
/// 304 once a day). Returns `Ok(true)` when the body changed, `Ok(false)` on
/// 304. Errors propagate so the periodic loop can log them.
async fn revalidate_provider(provider: &str) -> Result<bool> {
    let meta = read_disk_meta(provider).await.unwrap_or_default();
    match fetch_dataset_conditional(provider, meta.etag.as_deref()).await? {
        Some(fetched) => {
            write_disk_body(provider, &fetched.body).await?;
            let new_meta = DatasetMeta {
                etag: fetched.etag.clone(),
                fetched_at: now_epoch_seconds(),
            };
            write_disk_meta(provider, &new_meta).await?;
            let ds = parse_dataset(&fetched.body)?;
            install_dataset(provider, ds).await;
            tracing::info!(provider, etag = ?new_meta.etag, "pricing dataset refreshed");
            Ok(true)
        }
        None => {
            let touched = DatasetMeta {
                etag: meta.etag.clone(),
                fetched_at: now_epoch_seconds(),
            };
            write_disk_meta(provider, &touched).await?;
            extend_memory_expiry(provider).await;
            tracing::debug!(provider, "pricing dataset unchanged on revalidation");
            Ok(false)
        }
    }
}

async fn known_providers() -> Vec<String> {
    let cache = DATASET_CACHE.lock().await;
    match cache.as_ref() {
        Some(map) => map.keys().cloned().collect(),
        None => Vec::new(),
    }
}

/// Spawn a background task that revalidates every provider in the in-memory
/// cache once every 24h. Cheap on the wire because each revalidation is a
/// conditional GET — typical case is 304 with no body. Idempotent: calling
/// twice spawns two loops; the cost is one extra HTTP request per day.
pub fn spawn_periodic_refresh() {
    tauri::async_runtime::spawn(async {
        let mut interval = tokio::time::interval(DATASET_TTL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Consume the immediate first tick — startup path already loads via
        // `ensure_dataset_loaded`. The next tick fires after 24h.
        interval.tick().await;

        loop {
            interval.tick().await;
            let providers = known_providers().await;
            if providers.is_empty() {
                tracing::debug!("periodic pricing refresh: nothing cached, skipping");
                continue;
            }
            for provider in providers {
                match revalidate_provider(&provider).await {
                    Ok(true) => tracing::info!(provider, "periodic refresh: updated"),
                    Ok(false) => tracing::debug!(provider, "periodic refresh: 304 unchanged"),
                    Err(e) => tracing::warn!(provider, error = %e, "periodic refresh failed"),
                }
            }
        }
    });
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
        assert!(
            region.get("broken").is_none(),
            "null prices must be filtered"
        );
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

    #[test]
    fn meta_is_fresh_within_ttl() {
        let meta = DatasetMeta {
            etag: Some("abc".into()),
            fetched_at: now_epoch_seconds() - 60, // 1 min ago
        };
        assert!(meta_is_fresh(&meta));
    }

    #[test]
    fn meta_is_stale_past_ttl() {
        let meta = DatasetMeta {
            etag: Some("abc".into()),
            fetched_at: now_epoch_seconds() - DATASET_TTL.as_secs() - 60,
        };
        assert!(!meta_is_fresh(&meta));
    }

    #[test]
    fn stale_retry_ttl_is_much_shorter_than_dataset_ttl() {
        // Guards against a future change that accidentally equates the two —
        // which would re-introduce the bug where unvalidated stale-disk loads
        // are kept for a full day after a transient network failure.
        assert!(STALE_RETRY_TTL > Duration::ZERO);
        assert!(
            STALE_RETRY_TTL * 10 < DATASET_TTL,
            "STALE_RETRY_TTL ({:?}) must be << DATASET_TTL ({:?})",
            STALE_RETRY_TTL,
            DATASET_TTL,
        );
    }

    #[test]
    fn meta_default_is_stale() {
        let meta = DatasetMeta::default();
        assert_eq!(meta.fetched_at, 0);
        assert!(!meta_is_fresh(&meta), "epoch-zero meta must be treated as stale");
    }

    #[test]
    fn meta_roundtrips_json() {
        let meta = DatasetMeta {
            etag: Some("\"0xABCDEF\"".into()),
            fetched_at: 1_700_000_000,
        };
        let s = serde_json::to_string(&meta).unwrap();
        let back: DatasetMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(back.etag, meta.etag);
        assert_eq!(back.fetched_at, meta.fetched_at);
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

    fn unique_tmp_dir(label: &str) -> PathBuf {
        let unique = format!(
            "kdashboard-pricing-{}-{}-{}",
            label,
            std::process::id(),
            TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        std::env::temp_dir().join(unique)
    }

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[tokio::test]
    async fn atomic_write_creates_file_and_parent_dirs() {
        let dir = unique_tmp_dir("create");
        let path = dir.join("nested").join("a.json");
        atomic_write(&path, b"hello").await.expect("write ok");
        let got = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(got, "hello");
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn atomic_write_replaces_existing_content() {
        let dir = unique_tmp_dir("replace");
        let path = dir.join("a.json");
        atomic_write(&path, b"first").await.expect("first write");
        atomic_write(&path, b"second").await.expect("second write");
        let got = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(got, "second");
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn atomic_write_leaves_no_temp_files_behind() {
        let dir = unique_tmp_dir("notemp");
        let path = dir.join("a.json");
        atomic_write(&path, b"x").await.expect("write");

        let mut entries = tokio::fs::read_dir(&dir).await.expect("read_dir");
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await.expect("next_entry") {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        assert_eq!(
            names,
            vec!["a.json".to_string()],
            "expected only the target file, found {names:?}"
        );
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn atomic_write_concurrent_callers_do_not_clobber_temp() {
        // Many concurrent writes to the same path must each succeed (each gets
        // its own temp name) and the final content must be one of the inputs.
        let dir = unique_tmp_dir("concurrent");
        let path = dir.join("a.json");
        let mut handles = Vec::new();
        for i in 0..16u8 {
            let p = path.clone();
            handles.push(tokio::spawn(async move {
                let payload = vec![i; 64];
                atomic_write(&p, &payload).await.map(|_| payload)
            }));
        }
        let mut payloads = Vec::new();
        for h in handles {
            payloads.push(h.await.unwrap().expect("write ok"));
        }
        let final_bytes = tokio::fs::read(&path).await.unwrap();
        assert!(payloads.contains(&final_bytes), "final content must be one of the writes");
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    /// Live network test against the actual GitHub release. Ignored by default —
    /// run with `cargo test --lib cost::pricing -- --ignored --nocapture`.
    /// Verifies both the initial 200 fetch and the conditional 304 path.
    #[tokio::test]
    #[ignore]
    async fn revalidate_uses_etag_for_304() {
        // First call: loads via ensure_dataset_loaded (probably 200 if cache empty).
        let nodes = vec![NodeInfo {
            name: "aws-1".into(),
            instance_type: "m5.large".into(),
            provider: "aws".into(),
            region: "us-east-1".into(),
            cpu_capacity: 2.0,
            memory_capacity_bytes: 8.0 * 1024.0 * 1024.0 * 1024.0,
        }];
        let prices = resolve_pricing(&nodes).await.expect("got prices");
        assert!(prices.contains_key("aws/us-east-1/m5.large"));

        // Now revalidate — meta on disk has a fresh etag, so this MUST come back
        // as Ok(false) (304). If GitHub regenerated the asset between our two
        // calls we'd get Ok(true), but in a same-second test that's impossible.
        let changed = revalidate_provider("aws")
            .await
            .expect("revalidate succeeds");
        assert!(!changed, "second call should be 304 not modified");
    }
}
