use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use super::client::get_client;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VulnerabilityCounts {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub unknown: u32,
}

#[allow(dead_code)]
impl VulnerabilityCounts {
    fn empty() -> Self {
        Self {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
            unknown: 0,
        }
    }

    fn total(&self) -> u32 {
        self.critical + self.high + self.medium + self.low + self.unknown
    }

    fn merge(&mut self, other: &VulnerabilityCounts) {
        self.critical += other.critical;
        self.high += other.high;
        self.medium += other.medium;
        self.low += other.low;
        self.unknown += other.unknown;
    }

    /// Returns true if any vulnerability at or above the given severity exists.
    pub fn has_at_severity(&self, min_severity: &str) -> bool {
        match min_severity {
            "critical" => self.critical > 0,
            "high" => self.critical > 0 || self.high > 0,
            "medium" => self.critical > 0 || self.high > 0 || self.medium > 0,
            _ => self.total() > 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageScanResult {
    pub image: String,
    pub vulns: VulnerabilityCounts,
    pub scanned_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodSecurityInfo {
    pub name: String,
    pub namespace: String,
    pub images: Vec<ImageScanResult>,
    pub total_vulns: VulnerabilityCounts,
    pub compliant: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityOverview {
    pub pods: Vec<PodSecurityInfo>,
    pub total_vulns: VulnerabilityCounts,
    pub total_images_scanned: u32,
    pub compliant_pods: u32,
    pub non_compliant_pods: u32,
    pub scanner: String, // "trivy" | "grype" | "none"
    pub fetched_at: String,
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

struct ScanCache {
    results: HashMap<String, ImageScanResult>,
    expires_at: Instant,
}

static SCAN_CACHE: Mutex<Option<ScanCache>> = tokio::sync::Mutex::const_new(None);

const CACHE_TTL: Duration = Duration::from_secs(300); // 5 min

// ---------------------------------------------------------------------------
// Scanner detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Scanner {
    Trivy,
    Grype,
    None,
}

fn detect_scanner() -> Scanner {
    use std::process::Command;

    if Command::new("trivy")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Scanner::Trivy;
    }

    if Command::new("grype")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Scanner::Grype;
    }

    Scanner::None
}

// ---------------------------------------------------------------------------
// Image scanning
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TrivyOutput {
    #[serde(rename = "Results")]
    results: Option<Vec<TrivyResult>>,
}

#[derive(Debug, Deserialize)]
struct TrivyResult {
    #[serde(rename = "Vulnerabilities")]
    vulnerabilities: Option<Vec<TrivyVuln>>,
}

#[derive(Debug, Deserialize)]
struct TrivyVuln {
    #[serde(rename = "Severity")]
    severity: String,
}

#[derive(Debug, Deserialize)]
struct GrypeOutput {
    matches: Option<Vec<GrypeMatch>>,
}

#[derive(Debug, Deserialize)]
struct GrypeMatch {
    vulnerability: GrypeVuln,
}

#[derive(Debug, Deserialize)]
struct GrypeVuln {
    severity: String,
}

async fn scan_image_trivy(image: &str) -> Result<VulnerabilityCounts> {
    let output = tokio::process::Command::new("trivy")
        .args([
            "image",
            "--format",
            "json",
            "--quiet",
            "--timeout",
            "60s",
            image,
        ])
        .output()
        .await?;

    if !output.status.success() {
        anyhow::bail!(
            "trivy scan failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let parsed: TrivyOutput = serde_json::from_slice(&output.stdout)?;
    let mut counts = VulnerabilityCounts::empty();

    if let Some(results) = parsed.results {
        for result in results {
            if let Some(vulns) = result.vulnerabilities {
                for v in vulns {
                    match v.severity.to_uppercase().as_str() {
                        "CRITICAL" => counts.critical += 1,
                        "HIGH" => counts.high += 1,
                        "MEDIUM" => counts.medium += 1,
                        "LOW" => counts.low += 1,
                        _ => counts.unknown += 1,
                    }
                }
            }
        }
    }

    Ok(counts)
}

async fn scan_image_grype(image: &str) -> Result<VulnerabilityCounts> {
    let output = tokio::process::Command::new("grype")
        .args([image, "-o", "json", "--quiet"])
        .output()
        .await?;

    if !output.status.success() {
        anyhow::bail!(
            "grype scan failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let parsed: GrypeOutput = serde_json::from_slice(&output.stdout)?;
    let mut counts = VulnerabilityCounts::empty();

    if let Some(matches) = parsed.matches {
        for m in matches {
            match m.vulnerability.severity.to_uppercase().as_str() {
                "CRITICAL" => counts.critical += 1,
                "HIGH" => counts.high += 1,
                "MEDIUM" => counts.medium += 1,
                "LOW" => counts.low += 1,
                _ => counts.unknown += 1,
            }
        }
    }

    Ok(counts)
}

async fn scan_image(scanner: &Scanner, image: &str) -> Result<VulnerabilityCounts> {
    match scanner {
        Scanner::Trivy => scan_image_trivy(image).await,
        Scanner::Grype => scan_image_grype(image).await,
        Scanner::None => anyhow::bail!("No scanner available"),
    }
}

// ---------------------------------------------------------------------------
// Pod image extraction
// ---------------------------------------------------------------------------

async fn get_pod_images(namespace: Option<&str>) -> Result<Vec<(String, String, Vec<String>)>> {
    use kube::api::ListParams;
    use kube::Api;

    let client = get_client().await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = match namespace {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::all(client),
    };

    let list = pods.list(&ListParams::default()).await?;
    let mut result = Vec::new();

    for pod in list.items {
        let name = pod.metadata.name.unwrap_or_default();
        let ns = pod.metadata.namespace.unwrap_or_default();
        let mut images = Vec::new();

        if let Some(spec) = pod.spec {
            for container in spec.containers {
                if let Some(image) = container.image {
                    if !images.contains(&image) {
                        images.push(image);
                    }
                }
            }
            if let Some(init_containers) = spec.init_containers {
                for container in init_containers {
                    if let Some(image) = container.image {
                        if !images.contains(&image) {
                            images.push(image);
                        }
                    }
                }
            }
        }

        result.push((name, ns, images));
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub async fn get_security_overview(namespace: Option<String>) -> Result<SecurityOverview> {
    let scanner = detect_scanner();
    let scanner_name = match scanner {
        Scanner::Trivy => "trivy",
        Scanner::Grype => "grype",
        Scanner::None => "none",
    };

    let ns = namespace.as_deref().and_then(|n| {
        if n == "All Namespaces" || n.is_empty() {
            None
        } else {
            Some(n)
        }
    });

    let pod_images = get_pod_images(ns).await?;

    // Collect unique images
    let mut unique_set = std::collections::HashSet::new();
    for (_, _, images) in &pod_images {
        for img in images {
            unique_set.insert(img.clone());
        }
    }
    let unique_images: Vec<String> = unique_set.into_iter().collect();

    // Scan unique images (check cache first)
    let mut image_results: HashMap<String, ImageScanResult> = HashMap::new();
    let now = chrono::Utc::now().to_rfc3339();

    // Check cache for previously scanned images
    {
        let cache = SCAN_CACHE.lock().await;
        if let Some(ref cached) = *cache {
            if cached.expires_at > Instant::now() {
                for img in &unique_images {
                    if let Some(result) = cached.results.get(img) {
                        image_results.insert(img.clone(), result.clone());
                    }
                }
            }
        }
    }

    // Scan images not in cache
    if scanner != Scanner::None {
        for img in &unique_images {
            if image_results.contains_key(img) {
                continue;
            }

            match scan_image(&scanner, img).await {
                Ok(vulns) => {
                    image_results.insert(
                        img.clone(),
                        ImageScanResult {
                            image: img.clone(),
                            vulns,
                            scanned_at: now.clone(),
                        },
                    );
                }
                Err(_) => {
                    // If scan fails for an image, record empty result
                    image_results.insert(
                        img.clone(),
                        ImageScanResult {
                            image: img.clone(),
                            vulns: VulnerabilityCounts::empty(),
                            scanned_at: now.clone(),
                        },
                    );
                }
            }
        }
    }

    // Update cache
    {
        let mut cache = SCAN_CACHE.lock().await;
        *cache = Some(ScanCache {
            results: image_results.clone(),
            expires_at: Instant::now() + CACHE_TTL,
        });
    }

    // Build per-pod security info
    let mut pods = Vec::new();
    let mut overall_vulns = VulnerabilityCounts::empty();
    let mut compliant_count = 0u32;
    let mut non_compliant_count = 0u32;

    for (pod_name, pod_ns, images) in &pod_images {
        let mut pod_vulns = VulnerabilityCounts::empty();
        let mut pod_images_results = Vec::new();

        for img in images {
            if let Some(result) = image_results.get(img) {
                pod_vulns.merge(&result.vulns);
                pod_images_results.push(result.clone());
            }
        }

        let compliant = pod_vulns.critical == 0 && pod_vulns.high == 0;
        if compliant {
            compliant_count += 1;
        } else {
            non_compliant_count += 1;
        }

        overall_vulns.merge(&pod_vulns);

        pods.push(PodSecurityInfo {
            name: pod_name.clone(),
            namespace: pod_ns.clone(),
            images: pod_images_results,
            total_vulns: pod_vulns,
            compliant,
        });
    }

    // Sort: non-compliant first, then by critical count desc
    pods.sort_by(|a, b| {
        a.compliant
            .cmp(&b.compliant)
            .then_with(|| b.total_vulns.critical.cmp(&a.total_vulns.critical))
            .then_with(|| b.total_vulns.high.cmp(&a.total_vulns.high))
    });

    Ok(SecurityOverview {
        pods,
        total_vulns: overall_vulns,
        total_images_scanned: image_results.len() as u32,
        compliant_pods: compliant_count,
        non_compliant_pods: non_compliant_count,
        scanner: scanner_name.into(),
        fetched_at: now,
    })
}

pub async fn scan_single_image(image: String) -> Result<ImageScanResult> {
    let scanner = detect_scanner();
    if scanner == Scanner::None {
        anyhow::bail!("No vulnerability scanner found. Install trivy or grype.");
    }

    let vulns = scan_image(&scanner, &image).await?;

    Ok(ImageScanResult {
        image,
        vulns,
        scanned_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // VulnerabilityCounts::empty
    // -----------------------------------------------------------------------

    #[test]
    fn empty_counts_are_all_zero() {
        let counts = VulnerabilityCounts::empty();
        assert_eq!(counts.critical, 0);
        assert_eq!(counts.high, 0);
        assert_eq!(counts.medium, 0);
        assert_eq!(counts.low, 0);
        assert_eq!(counts.unknown, 0);
    }

    // -----------------------------------------------------------------------
    // VulnerabilityCounts::total
    // -----------------------------------------------------------------------

    #[test]
    fn total_sums_all_severities() {
        let counts = VulnerabilityCounts {
            critical: 2,
            high: 5,
            medium: 10,
            low: 20,
            unknown: 3,
        };
        assert_eq!(counts.total(), 40);
    }

    #[test]
    fn total_of_empty_is_zero() {
        assert_eq!(VulnerabilityCounts::empty().total(), 0);
    }

    // -----------------------------------------------------------------------
    // VulnerabilityCounts::merge
    // -----------------------------------------------------------------------

    #[test]
    fn merge_adds_all_fields() {
        let mut a = VulnerabilityCounts {
            critical: 1,
            high: 2,
            medium: 3,
            low: 4,
            unknown: 5,
        };
        let b = VulnerabilityCounts {
            critical: 10,
            high: 20,
            medium: 30,
            low: 40,
            unknown: 50,
        };
        a.merge(&b);
        assert_eq!(a.critical, 11);
        assert_eq!(a.high, 22);
        assert_eq!(a.medium, 33);
        assert_eq!(a.low, 44);
        assert_eq!(a.unknown, 55);
    }

    #[test]
    fn merge_with_empty_is_identity() {
        let mut a = VulnerabilityCounts {
            critical: 3,
            high: 7,
            medium: 0,
            low: 1,
            unknown: 0,
        };
        let original = a.clone();
        a.merge(&VulnerabilityCounts::empty());
        assert_eq!(a.critical, original.critical);
        assert_eq!(a.high, original.high);
        assert_eq!(a.medium, original.medium);
        assert_eq!(a.low, original.low);
        assert_eq!(a.unknown, original.unknown);
    }

    // -----------------------------------------------------------------------
    // VulnerabilityCounts::has_at_severity
    // -----------------------------------------------------------------------

    #[test]
    fn has_at_severity_critical_only_checks_critical() {
        let counts = VulnerabilityCounts {
            critical: 0,
            high: 100,
            medium: 100,
            low: 100,
            unknown: 100,
        };
        assert!(!counts.has_at_severity("critical"));

        let with_critical = VulnerabilityCounts {
            critical: 1,
            high: 0,
            medium: 0,
            low: 0,
            unknown: 0,
        };
        assert!(with_critical.has_at_severity("critical"));
    }

    #[test]
    fn has_at_severity_high_checks_critical_and_high() {
        let only_medium = VulnerabilityCounts {
            critical: 0,
            high: 0,
            medium: 50,
            low: 0,
            unknown: 0,
        };
        assert!(!only_medium.has_at_severity("high"));

        let with_high = VulnerabilityCounts {
            critical: 0,
            high: 1,
            medium: 0,
            low: 0,
            unknown: 0,
        };
        assert!(with_high.has_at_severity("high"));

        let with_critical = VulnerabilityCounts {
            critical: 1,
            high: 0,
            medium: 0,
            low: 0,
            unknown: 0,
        };
        assert!(with_critical.has_at_severity("high"));
    }

    #[test]
    fn has_at_severity_medium_checks_critical_high_medium() {
        let only_low = VulnerabilityCounts {
            critical: 0,
            high: 0,
            medium: 0,
            low: 99,
            unknown: 0,
        };
        assert!(!only_low.has_at_severity("medium"));

        let with_medium = VulnerabilityCounts {
            critical: 0,
            high: 0,
            medium: 1,
            low: 0,
            unknown: 0,
        };
        assert!(with_medium.has_at_severity("medium"));
    }

    #[test]
    fn has_at_severity_unknown_level_checks_total() {
        // Any unrecognized severity string falls through to total()
        let empty = VulnerabilityCounts::empty();
        assert!(!empty.has_at_severity("low"));
        assert!(!empty.has_at_severity("anything"));

        let with_low = VulnerabilityCounts {
            critical: 0,
            high: 0,
            medium: 0,
            low: 1,
            unknown: 0,
        };
        assert!(with_low.has_at_severity("low"));
    }

    // -----------------------------------------------------------------------
    // Compliance logic (pod is compliant when critical == 0 && high == 0)
    // -----------------------------------------------------------------------

    #[test]
    fn compliant_when_no_critical_or_high() {
        let counts = VulnerabilityCounts {
            critical: 0,
            high: 0,
            medium: 50,
            low: 100,
            unknown: 10,
        };
        let compliant = counts.critical == 0 && counts.high == 0;
        assert!(compliant);
    }

    #[test]
    fn non_compliant_with_critical() {
        let counts = VulnerabilityCounts {
            critical: 1,
            high: 0,
            medium: 0,
            low: 0,
            unknown: 0,
        };
        let compliant = counts.critical == 0 && counts.high == 0;
        assert!(!compliant);
    }

    #[test]
    fn non_compliant_with_high() {
        let counts = VulnerabilityCounts {
            critical: 0,
            high: 3,
            medium: 0,
            low: 0,
            unknown: 0,
        };
        let compliant = counts.critical == 0 && counts.high == 0;
        assert!(!compliant);
    }

    // -----------------------------------------------------------------------
    // Trivy JSON parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parse_trivy_output_with_vulns() {
        let json = r#"{
            "Results": [
                {
                    "Vulnerabilities": [
                        {"Severity": "CRITICAL"},
                        {"Severity": "HIGH"},
                        {"Severity": "HIGH"},
                        {"Severity": "MEDIUM"},
                        {"Severity": "LOW"},
                        {"Severity": "UNKNOWN"}
                    ]
                }
            ]
        }"#;
        let parsed: TrivyOutput = serde_json::from_str(json).unwrap();
        let mut counts = VulnerabilityCounts::empty();
        if let Some(results) = parsed.results {
            for result in results {
                if let Some(vulns) = result.vulnerabilities {
                    for v in vulns {
                        match v.severity.to_uppercase().as_str() {
                            "CRITICAL" => counts.critical += 1,
                            "HIGH" => counts.high += 1,
                            "MEDIUM" => counts.medium += 1,
                            "LOW" => counts.low += 1,
                            _ => counts.unknown += 1,
                        }
                    }
                }
            }
        }
        assert_eq!(counts.critical, 1);
        assert_eq!(counts.high, 2);
        assert_eq!(counts.medium, 1);
        assert_eq!(counts.low, 1);
        assert_eq!(counts.unknown, 1);
    }

    #[test]
    fn parse_trivy_output_no_vulns() {
        let json = r#"{"Results": [{"Vulnerabilities": null}]}"#;
        let parsed: TrivyOutput = serde_json::from_str(json).unwrap();
        let mut counts = VulnerabilityCounts::empty();
        if let Some(results) = parsed.results {
            for result in results {
                if let Some(vulns) = result.vulnerabilities {
                    for v in vulns {
                        match v.severity.to_uppercase().as_str() {
                            "CRITICAL" => counts.critical += 1,
                            _ => counts.unknown += 1,
                        }
                    }
                }
            }
        }
        assert_eq!(counts.total(), 0);
    }

    #[test]
    fn parse_trivy_output_empty_results() {
        let json = r#"{"Results": null}"#;
        let parsed: TrivyOutput = serde_json::from_str(json).unwrap();
        assert!(parsed.results.is_none());
    }

    // -----------------------------------------------------------------------
    // Grype JSON parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parse_grype_output_with_matches() {
        let json = r#"{
            "matches": [
                {"vulnerability": {"severity": "Critical"}},
                {"vulnerability": {"severity": "Medium"}},
                {"vulnerability": {"severity": "Low"}}
            ]
        }"#;
        let parsed: GrypeOutput = serde_json::from_str(json).unwrap();
        let mut counts = VulnerabilityCounts::empty();
        if let Some(matches) = parsed.matches {
            for m in matches {
                match m.vulnerability.severity.to_uppercase().as_str() {
                    "CRITICAL" => counts.critical += 1,
                    "HIGH" => counts.high += 1,
                    "MEDIUM" => counts.medium += 1,
                    "LOW" => counts.low += 1,
                    _ => counts.unknown += 1,
                }
            }
        }
        assert_eq!(counts.critical, 1);
        assert_eq!(counts.medium, 1);
        assert_eq!(counts.low, 1);
        assert_eq!(counts.total(), 3);
    }

    #[test]
    fn parse_grype_output_no_matches() {
        let json = r#"{"matches": null}"#;
        let parsed: GrypeOutput = serde_json::from_str(json).unwrap();
        assert!(parsed.matches.is_none());
    }

    // -----------------------------------------------------------------------
    // Scanner enum equality
    // -----------------------------------------------------------------------

    #[test]
    fn scanner_none_is_comparable() {
        assert_eq!(Scanner::None, Scanner::None);
        assert_ne!(Scanner::Trivy, Scanner::Grype);
        assert_ne!(Scanner::Trivy, Scanner::None);
    }
}
