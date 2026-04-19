use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use k8s_openapi::api::core::v1::Pod;
use kube::api::ObjectMeta;
use std::collections::BTreeMap;

/// Build a realistic Pod with N containers for benchmarking.
fn make_pod(n_containers: usize) -> Pod {
    use k8s_openapi::api::core::v1::*;

    let containers: Vec<Container> = (0..n_containers)
        .map(|i| Container {
            name: format!("container-{}", i),
            image: Some(format!("nginx:{}.0", i)),
            ports: Some(vec![ContainerPort {
                container_port: 8080 + i as i32,
                protocol: Some("TCP".into()),
                ..Default::default()
            }]),
            env: Some(vec![
                EnvVar {
                    name: "APP_ENV".into(),
                    value: Some("production".into()),
                    ..Default::default()
                },
                EnvVar {
                    name: "APP_VERSION".into(),
                    value: Some(format!("{}", i)),
                    ..Default::default()
                },
            ]),
            resources: Some(ResourceRequirements {
                limits: Some(BTreeMap::from([
                    (
                        "cpu".into(),
                        k8s_openapi::apimachinery::pkg::api::resource::Quantity("500m".into()),
                    ),
                    (
                        "memory".into(),
                        k8s_openapi::apimachinery::pkg::api::resource::Quantity("256Mi".into()),
                    ),
                ])),
                requests: Some(BTreeMap::from([
                    (
                        "cpu".into(),
                        k8s_openapi::apimachinery::pkg::api::resource::Quantity("100m".into()),
                    ),
                    (
                        "memory".into(),
                        k8s_openapi::apimachinery::pkg::api::resource::Quantity("128Mi".into()),
                    ),
                ])),
                ..Default::default()
            }),
            ..Default::default()
        })
        .collect();

    let mut labels = BTreeMap::new();
    labels.insert("app".into(), "benchmark-pod".into());
    labels.insert("env".into(), "production".into());
    labels.insert("tier".into(), "frontend".into());
    labels.insert("version".into(), "v1".into());

    let mut annotations = BTreeMap::new();
    annotations.insert(
        "kubectl.kubernetes.io/last-applied-configuration".into(),
        "{}".into(),
    );
    annotations.insert("prometheus.io/scrape".into(), "true".into());

    Pod {
        metadata: ObjectMeta {
            name: Some("benchmark-pod".into()),
            namespace: Some("default".into()),
            uid: Some("abc-123-def-456".into()),
            resource_version: Some("12345".into()),
            labels: Some(labels),
            annotations: Some(annotations),
            creation_timestamp: Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::Time(
                chrono::Utc::now(),
            )),
            owner_references: Some(vec![
                k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
                    api_version: "apps/v1".into(),
                    kind: "ReplicaSet".into(),
                    name: "benchmark-rs-abc123".into(),
                    uid: "rs-uid-123".into(),
                    controller: Some(true),
                    block_owner_deletion: Some(true),
                },
            ]),
            ..Default::default()
        },
        spec: Some(PodSpec {
            containers,
            restart_policy: Some("Always".into()),
            dns_policy: Some("ClusterFirst".into()),
            service_account_name: Some("default".into()),
            ..Default::default()
        }),
        status: Some(PodStatus {
            phase: Some("Running".into()),
            conditions: Some(vec![
                PodCondition {
                    type_: "Ready".into(),
                    status: "True".into(),
                    ..Default::default()
                },
                PodCondition {
                    type_: "ContainersReady".into(),
                    status: "True".into(),
                    ..Default::default()
                },
            ]),
            container_statuses: Some(
                (0..n_containers)
                    .map(|i| ContainerStatus {
                        name: format!("container-{}", i),
                        ready: true,
                        restart_count: 0,
                        image: format!("nginx:{}.0", i),
                        image_id: format!("docker-pullable://nginx@sha256:abc{}", i),
                        started: Some(true),
                        ..Default::default()
                    })
                    .collect(),
            ),
            host_ip: Some("10.0.0.1".into()),
            pod_ip: Some("172.17.0.5".into()),
            ..Default::default()
        }),
    }
}

/// OLD approach: serialize entire object, then extract fields.
fn old_serialize_pod(pod: &Pod) -> (serde_json::Value, serde_json::Value) {
    let raw = serde_json::to_value(pod).unwrap_or_default();
    let spec = raw.get("spec").cloned().unwrap_or_default();
    let status = raw.get("status").cloned().unwrap_or_default();
    (spec, status)
}

/// NEW approach: serialize only the fields we need.
fn new_serialize_pod(pod: &Pod) -> (serde_json::Value, serde_json::Value) {
    let spec = serde_json::to_value(&pod.spec).unwrap_or_default();
    let status = serde_json::to_value(&pod.status).unwrap_or_default();
    (spec, status)
}

/// Benchmark meta_from conversion.
fn bench_meta_from(pod: &Pod) -> BTreeMap<String, Option<String>> {
    let m = &pod.metadata;
    let mut result = BTreeMap::new();
    result.insert("name".into(), m.name.clone());
    result.insert("namespace".into(), m.namespace.clone());
    result.insert("uid".into(), m.uid.clone());
    result.insert(
        "creation_timestamp".into(),
        m.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
    );
    result
}

fn criterion_benchmark(c: &mut Criterion) {
    let pod_1 = make_pod(1);
    let pod_3 = make_pod(3);

    let mut group = c.benchmark_group("pod_serialization");

    // --- Single-container pod ---
    group.bench_with_input(
        BenchmarkId::new("old_full_serialize", "1_container"),
        &pod_1,
        |b, pod| b.iter(|| old_serialize_pod(black_box(pod))),
    );
    group.bench_with_input(
        BenchmarkId::new("new_field_serialize", "1_container"),
        &pod_1,
        |b, pod| b.iter(|| new_serialize_pod(black_box(pod))),
    );

    // --- Three-container pod ---
    group.bench_with_input(
        BenchmarkId::new("old_full_serialize", "3_containers"),
        &pod_3,
        |b, pod| b.iter(|| old_serialize_pod(black_box(pod))),
    );
    group.bench_with_input(
        BenchmarkId::new("new_field_serialize", "3_containers"),
        &pod_3,
        |b, pod| b.iter(|| new_serialize_pod(black_box(pod))),
    );

    group.finish();

    // --- Batch vs individual: simulate list of 100 pods ---
    let pods: Vec<Pod> = (0..100).map(|_| make_pod(2)).collect();

    let mut list_group = c.benchmark_group("list_100_pods");
    list_group.bench_function("old_full_serialize", |b| {
        b.iter(|| {
            for pod in black_box(&pods) {
                old_serialize_pod(pod);
            }
        })
    });
    list_group.bench_function("new_field_serialize", |b| {
        b.iter(|| {
            for pod in black_box(&pods) {
                new_serialize_pod(pod);
            }
        })
    });
    list_group.finish();

    // --- meta_from ---
    c.bench_function("meta_from_conversion", |b| {
        b.iter(|| bench_meta_from(black_box(&pod_3)))
    });
}

criterion_group!(benches, criterion_benchmark);
criterion_main!(benches);
