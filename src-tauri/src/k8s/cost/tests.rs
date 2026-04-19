use std::collections::{BTreeMap, HashMap};

use super::calculations::HOURS_PER_MONTH;
use super::metrics::{parse_cpu, parse_memory};
use super::nodes::{detect_provider, resolve_node_rates, FALLBACK_CPU_RATE, FALLBACK_MEM_RATE};
use super::types::{NodeInfo, ResourceCost};

// -----------------------------------------------------------------------
// parse_cpu
// -----------------------------------------------------------------------

#[test]
fn parse_cpu_nanocores() {
    let result = parse_cpu("250000000n");
    assert!((result - 0.25).abs() < 1e-9);
}

#[test]
fn parse_cpu_microcores() {
    let result = parse_cpu("500000u");
    assert!((result - 0.5).abs() < 1e-9);
}

#[test]
fn parse_cpu_millicores() {
    assert!((parse_cpu("100m") - 0.1).abs() < 1e-9);
    assert!((parse_cpu("1000m") - 1.0).abs() < 1e-9);
    assert!((parse_cpu("2500m") - 2.5).abs() < 1e-9);
}

#[test]
fn parse_cpu_whole_cores() {
    assert!((parse_cpu("1") - 1.0).abs() < 1e-9);
    assert!((parse_cpu("4") - 4.0).abs() < 1e-9);
    assert!((parse_cpu("0.5") - 0.5).abs() < 1e-9);
}

#[test]
fn parse_cpu_empty_and_invalid() {
    assert!((parse_cpu("")).abs() < 1e-9);
    assert!((parse_cpu("abc")).abs() < 1e-9);
    assert!((parse_cpu("m")).abs() < 1e-9); // suffix with no number
}

// -----------------------------------------------------------------------
// parse_memory
// -----------------------------------------------------------------------

#[test]
fn parse_memory_kibibytes() {
    let result = parse_memory("1024Ki");
    assert!((result - 1024.0 * 1024.0).abs() < 1.0);
}

#[test]
fn parse_memory_mebibytes() {
    let result = parse_memory("256Mi");
    assert!((result - 256.0 * 1024.0 * 1024.0).abs() < 1.0);
}

#[test]
fn parse_memory_gibibytes() {
    let result = parse_memory("2Gi");
    assert!((result - 2.0 * 1024.0 * 1024.0 * 1024.0).abs() < 1.0);
}

#[test]
fn parse_memory_si_kilobytes() {
    let result = parse_memory("1000k");
    assert!((result - 1_000_000.0).abs() < 1.0);
}

#[test]
fn parse_memory_si_megabytes() {
    let result = parse_memory("512M");
    assert!((result - 512_000_000.0).abs() < 1.0);
}

#[test]
fn parse_memory_si_gigabytes() {
    let result = parse_memory("4G");
    assert!((result - 4_000_000_000.0).abs() < 1.0);
}

#[test]
fn parse_memory_bare_bytes() {
    let result = parse_memory("1048576");
    assert!((result - 1048576.0).abs() < 1.0);
}

#[test]
fn parse_memory_empty_and_invalid() {
    assert!((parse_memory("")).abs() < 1e-9);
    assert!((parse_memory("abc")).abs() < 1e-9);
}

// -----------------------------------------------------------------------
// detect_provider
// -----------------------------------------------------------------------

#[test]
fn detect_provider_aws_by_eks_label() {
    let mut labels = BTreeMap::new();
    labels.insert("eks.amazonaws.com/nodegroup".into(), "ng-1".into());
    assert_eq!(detect_provider(&labels, "m5.xlarge"), "aws");
}

#[test]
fn detect_provider_aws_by_instance_type_dot() {
    let labels = BTreeMap::new();
    // Instance types containing a dot are treated as AWS
    assert_eq!(detect_provider(&labels, "m5.xlarge"), "aws");
    assert_eq!(detect_provider(&labels, "c6i.2xlarge"), "aws");
}

#[test]
fn detect_provider_gcp_by_gke_label() {
    let mut labels = BTreeMap::new();
    labels.insert(
        "cloud.google.com/gke-nodepool".into(),
        "default-pool".into(),
    );
    assert_eq!(detect_provider(&labels, "n1-standard-4"), "gcp");
}

#[test]
fn detect_provider_gcp_by_instance_prefix() {
    let labels = BTreeMap::new();
    assert_eq!(detect_provider(&labels, "e2-medium"), "gcp");
    assert_eq!(detect_provider(&labels, "n2-standard-8"), "gcp");
    assert_eq!(detect_provider(&labels, "c3-standard-4"), "gcp");
    assert_eq!(detect_provider(&labels, "t2d-standard-1"), "gcp");
}

#[test]
fn detect_provider_azure_by_label() {
    let mut labels = BTreeMap::new();
    labels.insert("kubernetes.azure.com/cluster".into(), "my-aks".into());
    assert_eq!(detect_provider(&labels, "Standard_D2s_v3"), "azure");
}

#[test]
fn detect_provider_azure_by_instance_prefix() {
    let labels = BTreeMap::new();
    assert_eq!(detect_provider(&labels, "Standard_D4s_v5"), "azure");
}

#[test]
fn detect_provider_unknown_fallback() {
    let labels = BTreeMap::new();
    assert_eq!(detect_provider(&labels, "custom-type"), "unknown");
    assert_eq!(detect_provider(&labels, ""), "unknown");
}

// -----------------------------------------------------------------------
// resolve_node_rates
// -----------------------------------------------------------------------

#[test]
fn resolve_node_rates_from_pricing() {
    let nodes = vec![NodeInfo {
        name: "node-1".into(),
        instance_type: "m5.xlarge".into(),
        provider: "aws".into(),
        region: "us-east-1".into(),
        cpu_capacity: 4.0,
        memory_capacity_bytes: 16.0 * 1024.0 * 1024.0 * 1024.0, // 16 GiB
    }];
    let mut pricing = HashMap::new();
    pricing.insert("aws/us-east-1/m5.xlarge".into(), 0.192); // $/hr

    let (cpu_rate, mem_rate) = resolve_node_rates(&nodes, &pricing);

    // 60% of $0.192 / 4 cores = $0.0288
    assert!((cpu_rate - 0.0288).abs() < 1e-6);
    // 40% of $0.192 / 16 GB = $0.0048
    assert!((mem_rate - 0.0048).abs() < 1e-6);
}

#[test]
fn resolve_node_rates_falls_back_when_no_match() {
    let nodes = vec![NodeInfo {
        name: "node-1".into(),
        instance_type: "m5.xlarge".into(),
        provider: "aws".into(),
        region: "us-east-1".into(),
        cpu_capacity: 4.0,
        memory_capacity_bytes: 16.0 * 1024.0 * 1024.0 * 1024.0,
    }];
    let pricing = HashMap::new(); // empty — no matches

    let (cpu_rate, mem_rate) = resolve_node_rates(&nodes, &pricing);
    assert!((cpu_rate - FALLBACK_CPU_RATE).abs() < 1e-9);
    assert!((mem_rate - FALLBACK_MEM_RATE).abs() < 1e-9);
}

#[test]
fn resolve_node_rates_skips_zero_capacity() {
    let nodes = vec![
        NodeInfo {
            name: "broken-node".into(),
            instance_type: "m5.xlarge".into(),
            provider: "aws".into(),
            region: "us-east-1".into(),
            cpu_capacity: 0.0, // zero capacity — should skip
            memory_capacity_bytes: 0.0,
        },
        NodeInfo {
            name: "good-node".into(),
            instance_type: "m5.large".into(),
            provider: "aws".into(),
            region: "us-east-1".into(),
            cpu_capacity: 2.0,
            memory_capacity_bytes: 8.0 * 1024.0 * 1024.0 * 1024.0,
        },
    ];
    let mut pricing = HashMap::new();
    pricing.insert("aws/us-east-1/m5.xlarge".into(), 0.192);
    pricing.insert("aws/us-east-1/m5.large".into(), 0.096);

    let (cpu_rate, mem_rate) = resolve_node_rates(&nodes, &pricing);
    // Should use the good node's pricing: 0.096 $/hr, 2 cores, 8 GiB
    assert!((cpu_rate - 0.096 * 0.6 / 2.0).abs() < 1e-6);
    assert!((mem_rate - 0.096 * 0.4 / 8.0).abs() < 1e-6);
}

// -----------------------------------------------------------------------
// Additional tests
// -----------------------------------------------------------------------

#[test]
fn parse_cpu_specific_nanocores_100n() {
    let result = parse_cpu("100n");
    assert!((result - 0.0000001).abs() < 1e-15);
}

#[test]
fn parse_cpu_500m() {
    assert!((parse_cpu("500m") - 0.5).abs() < 1e-9);
}

#[test]
fn parse_cpu_zero() {
    assert!((parse_cpu("0")).abs() < 1e-9);
}

#[test]
fn parse_cpu_2_whole_cores() {
    assert!((parse_cpu("2") - 2.0).abs() < 1e-9);
}

#[test]
fn parse_memory_zero() {
    assert!((parse_memory("0")).abs() < 1e-9);
}

#[test]
fn parse_memory_large_gi() {
    // 64 GiB
    let result = parse_memory("64Gi");
    assert!((result - 64.0 * 1024.0 * 1024.0 * 1024.0).abs() < 1.0);
}

#[test]
fn parse_memory_fractional_gi() {
    let result = parse_memory("1.5Gi");
    assert!((result - 1.5 * 1024.0 * 1024.0 * 1024.0).abs() < 1.0);
}

#[test]
fn detect_provider_aws_by_eksctl_label() {
    let mut labels = BTreeMap::new();
    labels.insert("alpha.eksctl.io/nodegroup-name".into(), "workers".into());
    assert_eq!(detect_provider(&labels, ""), "aws");
}

#[test]
fn detect_provider_gcp_c2d_prefix() {
    let labels = BTreeMap::new();
    assert_eq!(detect_provider(&labels, "c2d-standard-8"), "gcp");
}

#[test]
fn detect_provider_gcp_n2d_prefix() {
    let labels = BTreeMap::new();
    assert_eq!(detect_provider(&labels, "n2d-standard-4"), "gcp");
}

#[test]
fn hours_per_month_is_730() {
    assert!((HOURS_PER_MONTH - 730.0).abs() < 1e-9);
}

// -----------------------------------------------------------------------
// ResourceCost monthly calculation sanity
// -----------------------------------------------------------------------

#[test]
fn resource_cost_monthly_equals_hourly_times_730() {
    let hourly = 0.05;
    let cost = ResourceCost {
        name: "test-pod".into(),
        namespace: "default".into(),
        kind: "Pod".into(),
        cpu_cores: 0.5,
        memory_bytes: 512.0 * 1024.0 * 1024.0,
        cpu_cost_hourly: 0.03,
        memory_cost_hourly: 0.02,
        total_cost_hourly: hourly,
        total_cost_monthly: hourly * HOURS_PER_MONTH,
    };
    assert!((cost.total_cost_monthly - 36.5).abs() < 1e-9);
}
