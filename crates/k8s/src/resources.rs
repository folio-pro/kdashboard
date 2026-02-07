use crate::types::{OwnerReference, Resource, ResourceList, ResourceMetadata, ResourceType};
use anyhow::{Context, Result};
use kube::api::{Api, DeleteParams, ListParams, LogParams, Patch, PatchParams};
use kube::Client;
use serde_json::Value;

fn opt_time_to_string(
    time: Option<k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>,
) -> Option<String> {
    time.map(|t| t.0.to_rfc3339())
}

fn metadata_from<T: kube::Resource<DynamicType = ()>>(
    obj: &T,
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> ResourceMetadata {
    let owner_references = meta.owner_references.as_ref().map(|refs| {
        refs.iter().map(|r| OwnerReference {
            api_version: r.api_version.clone(),
            kind: r.kind.clone(),
            name: r.name.clone(),
            uid: r.uid.clone(),
        }).collect()
    });

    ResourceMetadata {
        name: meta.name.clone().unwrap_or_default(),
        namespace: meta.namespace.clone(),
        uid: meta.uid.clone().unwrap_or_default(),
        resource_version: meta.resource_version.clone().unwrap_or_default(),
        labels: meta.labels.clone(),
        annotations: meta.annotations.clone(),
        creation_timestamp: opt_time_to_string(meta.creation_timestamp.clone()),
        owner_references,
    }
}

pub async fn list_resources(
    client: &Client,
    resource_type: ResourceType,
    namespace: Option<&str>,
) -> Result<ResourceList> {
    match resource_type {
        ResourceType::Pods => list_pods(client, namespace).await,
        ResourceType::Deployments => list_deployments(client, namespace).await,
        ResourceType::Services => list_services(client, namespace).await,
        ResourceType::ConfigMaps => list_configmaps(client, namespace).await,
        ResourceType::Secrets => list_secrets(client, namespace).await,
        ResourceType::Ingresses => list_ingresses(client, namespace).await,
        ResourceType::StatefulSets => list_statefulsets(client, namespace).await,
        ResourceType::DaemonSets => list_daemonsets(client, namespace).await,
        ResourceType::Jobs => list_jobs(client, namespace).await,
        ResourceType::CronJobs => list_cronjobs(client, namespace).await,
        ResourceType::ReplicaSets => list_replicasets(client, namespace).await,
        ResourceType::Nodes => list_nodes(client).await,
        ResourceType::Namespaces => list_namespace_resources(client).await,
    }
}

async fn list_pods(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::core::v1::Pod;

    let api: Api<Pod> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list pods")?;

    let items = list
        .items
        .into_iter()
        .map(|p| {
            let metadata = metadata_from(&p, &p.metadata);
            Resource {
                api_version: "v1".to_string(),
                kind: "Pod".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&p.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&p.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "pods".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_deployments(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::apps::v1::Deployment;

    let api: Api<Deployment> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list deployments")?;

    let items = list
        .items
        .into_iter()
        .map(|d| {
            let metadata = metadata_from(&d, &d.metadata);
            Resource {
                api_version: "apps/v1".to_string(),
                kind: "Deployment".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&d.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&d.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "deployments".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_services(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::core::v1::Service;

    let api: Api<Service> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list services")?;

    let items = list
        .items
        .into_iter()
        .map(|s| {
            let metadata = metadata_from(&s, &s.metadata);
            Resource {
                api_version: "v1".to_string(),
                kind: "Service".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&s.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&s.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "services".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_configmaps(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::core::v1::ConfigMap;

    let api: Api<ConfigMap> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list configmaps")?;

    let items = list
        .items
        .into_iter()
        .map(|cm| {
            let metadata = metadata_from(&cm, &cm.metadata);
            Resource {
                api_version: "v1".to_string(),
                kind: "ConfigMap".to_string(),
                metadata,
                spec: None,
                status: None,
                data: Some(serde_json::to_value(&cm.data).unwrap_or_default()),
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "configmaps".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_secrets(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::core::v1::Secret;

    let api: Api<Secret> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list secrets")?;

    let items = list
        .items
        .into_iter()
        .map(|s| {
            let metadata = metadata_from(&s, &s.metadata);
            let secret_type = s.type_.clone();
            let data_map: Option<std::collections::BTreeMap<String, String>> = s.data.map(|d| {
                d.into_iter()
                    .map(|(k, v)| {
                        use base64::Engine;
                        (k, base64::engine::general_purpose::STANDARD.encode(&v.0))
                    })
                    .collect()
            });
            Resource {
                api_version: "v1".to_string(),
                kind: "Secret".to_string(),
                metadata,
                spec: None,
                status: None,
                data: Some(serde_json::to_value(&data_map).unwrap_or_default()),
                type_: secret_type,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "secrets".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_ingresses(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::networking::v1::Ingress;

    let api: Api<Ingress> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list ingresses")?;

    let items = list
        .items
        .into_iter()
        .map(|i| {
            let metadata = metadata_from(&i, &i.metadata);
            Resource {
                api_version: "networking.k8s.io/v1".to_string(),
                kind: "Ingress".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&i.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&i.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "ingresses".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_statefulsets(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::apps::v1::StatefulSet;

    let api: Api<StatefulSet> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list statefulsets")?;

    let items = list
        .items
        .into_iter()
        .map(|ss| {
            let metadata = metadata_from(&ss, &ss.metadata);
            Resource {
                api_version: "apps/v1".to_string(),
                kind: "StatefulSet".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&ss.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&ss.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "statefulsets".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_daemonsets(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::apps::v1::DaemonSet;

    let api: Api<DaemonSet> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list daemonsets")?;

    let items = list
        .items
        .into_iter()
        .map(|ds| {
            let metadata = metadata_from(&ds, &ds.metadata);
            Resource {
                api_version: "apps/v1".to_string(),
                kind: "DaemonSet".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&ds.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&ds.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "daemonsets".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_jobs(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::batch::v1::Job;

    let api: Api<Job> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list jobs")?;

    let items = list
        .items
        .into_iter()
        .map(|j| {
            let metadata = metadata_from(&j, &j.metadata);
            Resource {
                api_version: "batch/v1".to_string(),
                kind: "Job".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&j.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&j.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "jobs".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_cronjobs(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::batch::v1::CronJob;

    let api: Api<CronJob> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list cronjobs")?;

    let items = list
        .items
        .into_iter()
        .map(|cj| {
            let metadata = metadata_from(&cj, &cj.metadata);
            Resource {
                api_version: "batch/v1".to_string(),
                kind: "CronJob".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&cj.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&cj.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "cronjobs".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_replicasets(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::apps::v1::ReplicaSet;

    let api: Api<ReplicaSet> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list replicasets")?;

    let items = list
        .items
        .into_iter()
        .map(|rs| {
            let metadata = metadata_from(&rs, &rs.metadata);
            Resource {
                api_version: "apps/v1".to_string(),
                kind: "ReplicaSet".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&rs.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&rs.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "replicasets".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_nodes(client: &Client) -> Result<ResourceList> {
    use k8s_openapi::api::core::v1::Node;

    let api: Api<Node> = Api::all(client.clone());

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list nodes")?;

    let items = list
        .items
        .into_iter()
        .map(|n| {
            let metadata = metadata_from(&n, &n.metadata);
            Resource {
                api_version: "v1".to_string(),
                kind: "Node".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&n.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&n.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "nodes".to_string(),
        namespace: None,
        items,
    })
}

async fn list_namespace_resources(client: &Client) -> Result<ResourceList> {
    use k8s_openapi::api::core::v1::Namespace;

    let api: Api<Namespace> = Api::all(client.clone());

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list namespaces")?;

    let items = list
        .items
        .into_iter()
        .map(|ns| {
            let metadata = metadata_from(&ns, &ns.metadata);
            Resource {
                api_version: "v1".to_string(),
                kind: "Namespace".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&ns.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&ns.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "namespaces".to_string(),
        namespace: None,
        items,
    })
}

pub async fn get_resource(
    client: &Client,
    resource_type: ResourceType,
    name: &str,
    namespace: Option<&str>,
) -> Result<Resource> {
    match resource_type {
        ResourceType::Pods => {
            use k8s_openapi::api::core::v1::Pod;
            let api: Api<Pod> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let pod = api.get(name).await.context("Failed to get pod")?;
            let metadata = metadata_from(&pod, &pod.metadata);
            Ok(Resource {
                api_version: "v1".to_string(),
                kind: "Pod".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&pod.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&pod.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::Deployments => {
            use k8s_openapi::api::apps::v1::Deployment;
            let api: Api<Deployment> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let dep = api.get(name).await.context("Failed to get deployment")?;
            let metadata = metadata_from(&dep, &dep.metadata);
            Ok(Resource {
                api_version: "apps/v1".to_string(),
                kind: "Deployment".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&dep.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&dep.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        _ => anyhow::bail!("Get resource not implemented for {:?}", resource_type),
    }
}

pub async fn delete_resource(
    client: &Client,
    resource_type: ResourceType,
    name: &str,
    namespace: Option<&str>,
) -> Result<()> {
    match resource_type {
        ResourceType::Pods => {
            use k8s_openapi::api::core::v1::Pod;
            let api: Api<Pod> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete pod")?;
            Ok(())
        }
        ResourceType::Deployments => {
            use k8s_openapi::api::apps::v1::Deployment;
            let api: Api<Deployment> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete deployment")?;
            Ok(())
        }
        _ => anyhow::bail!("Delete resource not implemented for {:?}", resource_type),
    }
}

pub async fn scale_resource(
    client: &Client,
    resource_type: ResourceType,
    name: &str,
    replicas: i32,
    namespace: Option<&str>,
) -> Result<()> {
    match resource_type {
        ResourceType::Deployments => {
            use k8s_openapi::api::apps::v1::Deployment;
            let api: Api<Deployment> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let patch = serde_json::json!({ "spec": { "replicas": replicas } });
            api.patch(name, &PatchParams::default(), &Patch::Merge(patch))
                .await
                .context("Failed to scale deployment")?;
            Ok(())
        }
        ResourceType::StatefulSets => {
            use k8s_openapi::api::apps::v1::StatefulSet;
            let api: Api<StatefulSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let patch = serde_json::json!({ "spec": { "replicas": replicas } });
            api.patch(name, &PatchParams::default(), &Patch::Merge(patch))
                .await
                .context("Failed to scale statefulset")?;
            Ok(())
        }
        _ => anyhow::bail!("Scale not supported for {:?}", resource_type),
    }
}

pub async fn get_pod_logs(
    client: &Client,
    pod_name: &str,
    container: Option<&str>,
    namespace: &str,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
) -> Result<String> {
    use k8s_openapi::api::core::v1::Pod;

    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = api.get(pod_name).await.context("Failed to get pod")?;

    let container_name = container
        .map(|c| c.to_string())
        .or_else(|| {
            pod.spec
                .as_ref()
                .and_then(|spec| spec.containers.first().map(|c| c.name.clone()))
        })
        .context("No container found")?;

    let lp = LogParams {
        container: Some(container_name),
        tail_lines,
        since_seconds,
        follow: false,
        timestamps: true,
        ..Default::default()
    };

    let logs = api
        .logs(pod_name, &lp)
        .await
        .context("Failed to get pod logs")?;

    Ok(logs)
}

pub async fn get_pod_events(client: &Client, pod_name: &str, namespace: &str) -> Result<Vec<crate::types::Event>> {
    use k8s_openapi::api::core::v1::Event;

    let api: Api<Event> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default()
        .fields(&format!(
            "involvedObject.name={},involvedObject.kind=Pod",
            pod_name
        ))
        .timeout(30);

    let events = api
        .list(&lp)
        .await
        .context("Failed to get pod events")?;

    Ok(events
        .items
        .into_iter()
        .map(|e| crate::types::Event {
            name: e.metadata.name.unwrap_or_default(),
            namespace: e.metadata.namespace.unwrap_or_default(),
            reason: e.reason.unwrap_or_default(),
            message: e.message.unwrap_or_default(),
            event_type: e.type_.unwrap_or_default(),
            count: e.count.unwrap_or(0),
            first_timestamp: e.first_timestamp.map(|t| t.0.to_string()),
            last_timestamp: e.last_timestamp.map(|t| t.0.to_string()),
            source: e.source.map(|s| s.component.unwrap_or_default()).unwrap_or_default(),
        })
        .collect())
}
