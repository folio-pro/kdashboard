use crate::types::{OwnerReference, Resource, ResourceList, ResourceMetadata, ResourceType};
use anyhow::{Context, Result};
use kube::Client;
use kube::api::{Api, DeleteParams, ListParams, LogParams, Patch, PatchParams};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc::Sender};
fn opt_time_to_string(
    time: Option<k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>,
) -> Option<String> {
    time.map(|t| t.0.to_rfc3339())
}

pub(crate) fn metadata_from<T: kube::Resource<DynamicType = ()>>(
    _obj: &T,
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> ResourceMetadata {
    let owner_references = meta.owner_references.as_ref().map(|refs| {
        refs.iter()
            .map(|r| OwnerReference {
                api_version: r.api_version.clone(),
                kind: r.kind.clone(),
                name: r.name.clone(),
                uid: r.uid.clone(),
            })
            .collect()
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
        ResourceType::HorizontalPodAutoscalers => list_hpas(client, namespace).await,
        ResourceType::VerticalPodAutoscalers => list_vpas(client, namespace).await,
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

async fn list_hpas(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;

    let api: Api<HorizontalPodAutoscaler> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list HPAs")?;

    let items = list
        .items
        .into_iter()
        .map(|hpa| {
            let metadata = metadata_from(&hpa, &hpa.metadata);
            Resource {
                api_version: "autoscaling/v2".to_string(),
                kind: "HorizontalPodAutoscaler".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&hpa.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&hpa.status).unwrap_or_default()),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "horizontalpodautoscalers".to_string(),
        namespace: namespace.map(|s| s.to_string()),
        items,
    })
}

async fn list_vpas(client: &Client, namespace: Option<&str>) -> Result<ResourceList> {
    use kube::api::DynamicObject;
    use kube::discovery::ApiResource;

    let ar = ApiResource {
        group: "autoscaling.k8s.io".to_string(),
        version: "v1".to_string(),
        kind: "VerticalPodAutoscaler".to_string(),
        api_version: "autoscaling.k8s.io/v1".to_string(),
        plural: "verticalpodautoscalers".to_string(),
    };

    let api: Api<DynamicObject> = match namespace {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };

    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list VPAs")?;

    let items = list
        .items
        .into_iter()
        .map(|vpa| {
            let meta = &vpa.metadata;
            let metadata = ResourceMetadata {
                name: meta.name.clone().unwrap_or_default(),
                namespace: meta.namespace.clone(),
                uid: meta.uid.clone().unwrap_or_default(),
                resource_version: meta.resource_version.clone().unwrap_or_default(),
                labels: meta.labels.clone(),
                annotations: meta.annotations.clone(),
                creation_timestamp: meta.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
                owner_references: meta.owner_references.as_ref().map(|refs| {
                    refs.iter()
                        .map(|r| OwnerReference {
                            api_version: r.api_version.clone(),
                            kind: r.kind.clone(),
                            name: r.name.clone(),
                            uid: r.uid.clone(),
                        })
                        .collect()
                }),
            };
            Resource {
                api_version: "autoscaling.k8s.io/v1".to_string(),
                kind: "VerticalPodAutoscaler".to_string(),
                metadata,
                spec: vpa.data.get("spec").cloned(),
                status: vpa.data.get("status").cloned(),
                data: None,
                type_: None,
            }
        })
        .collect();

    Ok(ResourceList {
        resource_type: "verticalpodautoscalers".to_string(),
        namespace: namespace.map(|s| s.to_string()),
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
        ResourceType::Services => {
            use k8s_openapi::api::core::v1::Service;
            let api: Api<Service> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let svc = api.get(name).await.context("Failed to get service")?;
            let metadata = metadata_from(&svc, &svc.metadata);
            Ok(Resource {
                api_version: "v1".to_string(),
                kind: "Service".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&svc.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&svc.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::ConfigMaps => {
            use k8s_openapi::api::core::v1::ConfigMap;
            let api: Api<ConfigMap> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let cm = api.get(name).await.context("Failed to get configmap")?;
            let metadata = metadata_from(&cm, &cm.metadata);
            Ok(Resource {
                api_version: "v1".to_string(),
                kind: "ConfigMap".to_string(),
                metadata,
                spec: None,
                status: None,
                data: Some(serde_json::to_value(&cm.data).unwrap_or_default()),
                type_: None,
            })
        }
        ResourceType::Secrets => {
            use k8s_openapi::api::core::v1::Secret;
            let api: Api<Secret> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let secret = api.get(name).await.context("Failed to get secret")?;
            let metadata = metadata_from(&secret, &secret.metadata);
            let secret_type = secret.type_.clone();
            let data_map: Option<std::collections::BTreeMap<String, String>> =
                secret.data.map(|d| {
                    d.into_iter()
                        .map(|(k, v)| {
                            use base64::Engine;
                            (k, base64::engine::general_purpose::STANDARD.encode(&v.0))
                        })
                        .collect()
                });
            Ok(Resource {
                api_version: "v1".to_string(),
                kind: "Secret".to_string(),
                metadata,
                spec: None,
                status: None,
                data: Some(serde_json::to_value(&data_map).unwrap_or_default()),
                type_: secret_type,
            })
        }
        ResourceType::Ingresses => {
            use k8s_openapi::api::networking::v1::Ingress;
            let api: Api<Ingress> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let ing = api.get(name).await.context("Failed to get ingress")?;
            let metadata = metadata_from(&ing, &ing.metadata);
            Ok(Resource {
                api_version: "networking.k8s.io/v1".to_string(),
                kind: "Ingress".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&ing.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&ing.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::StatefulSets => {
            use k8s_openapi::api::apps::v1::StatefulSet;
            let api: Api<StatefulSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let ss = api.get(name).await.context("Failed to get statefulset")?;
            let metadata = metadata_from(&ss, &ss.metadata);
            Ok(Resource {
                api_version: "apps/v1".to_string(),
                kind: "StatefulSet".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&ss.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&ss.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::DaemonSets => {
            use k8s_openapi::api::apps::v1::DaemonSet;
            let api: Api<DaemonSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let ds = api.get(name).await.context("Failed to get daemonset")?;
            let metadata = metadata_from(&ds, &ds.metadata);
            Ok(Resource {
                api_version: "apps/v1".to_string(),
                kind: "DaemonSet".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&ds.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&ds.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::Jobs => {
            use k8s_openapi::api::batch::v1::Job;
            let api: Api<Job> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let job = api.get(name).await.context("Failed to get job")?;
            let metadata = metadata_from(&job, &job.metadata);
            Ok(Resource {
                api_version: "batch/v1".to_string(),
                kind: "Job".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&job.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&job.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::CronJobs => {
            use k8s_openapi::api::batch::v1::CronJob;
            let api: Api<CronJob> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let cj = api.get(name).await.context("Failed to get cronjob")?;
            let metadata = metadata_from(&cj, &cj.metadata);
            Ok(Resource {
                api_version: "batch/v1".to_string(),
                kind: "CronJob".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&cj.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&cj.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::ReplicaSets => {
            use k8s_openapi::api::apps::v1::ReplicaSet;
            let api: Api<ReplicaSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let rs = api.get(name).await.context("Failed to get replicaset")?;
            let metadata = metadata_from(&rs, &rs.metadata);
            Ok(Resource {
                api_version: "apps/v1".to_string(),
                kind: "ReplicaSet".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&rs.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&rs.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::Nodes => {
            use k8s_openapi::api::core::v1::Node;
            let api: Api<Node> = Api::all(client.clone());
            let node = api.get(name).await.context("Failed to get node")?;
            let metadata = metadata_from(&node, &node.metadata);
            Ok(Resource {
                api_version: "v1".to_string(),
                kind: "Node".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&node.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&node.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::Namespaces => {
            use k8s_openapi::api::core::v1::Namespace;
            let api: Api<Namespace> = Api::all(client.clone());
            let ns = api.get(name).await.context("Failed to get namespace")?;
            let metadata = metadata_from(&ns, &ns.metadata);
            Ok(Resource {
                api_version: "v1".to_string(),
                kind: "Namespace".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&ns.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&ns.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::HorizontalPodAutoscalers => {
            use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
            let api: Api<HorizontalPodAutoscaler> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            let hpa = api.get(name).await.context("Failed to get HPA")?;
            let metadata = metadata_from(&hpa, &hpa.metadata);
            Ok(Resource {
                api_version: "autoscaling/v2".to_string(),
                kind: "HorizontalPodAutoscaler".to_string(),
                metadata,
                spec: Some(serde_json::to_value(&hpa.spec).unwrap_or_default()),
                status: Some(serde_json::to_value(&hpa.status).unwrap_or_default()),
                data: None,
                type_: None,
            })
        }
        ResourceType::VerticalPodAutoscalers => {
            use kube::api::DynamicObject;
            use kube::discovery::ApiResource;

            let ar = ApiResource {
                group: "autoscaling.k8s.io".to_string(),
                version: "v1".to_string(),
                kind: "VerticalPodAutoscaler".to_string(),
                api_version: "autoscaling.k8s.io/v1".to_string(),
                plural: "verticalpodautoscalers".to_string(),
            };

            let api: Api<DynamicObject> = match namespace {
                Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
                None => Api::default_namespaced_with(client.clone(), &ar),
            };
            let vpa = api.get(name).await.context("Failed to get VPA")?;
            let meta = &vpa.metadata;
            let metadata = ResourceMetadata {
                name: meta.name.clone().unwrap_or_default(),
                namespace: meta.namespace.clone(),
                uid: meta.uid.clone().unwrap_or_default(),
                resource_version: meta.resource_version.clone().unwrap_or_default(),
                labels: meta.labels.clone(),
                annotations: meta.annotations.clone(),
                creation_timestamp: meta.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
                owner_references: meta.owner_references.as_ref().map(|refs| {
                    refs.iter()
                        .map(|r| OwnerReference {
                            api_version: r.api_version.clone(),
                            kind: r.kind.clone(),
                            name: r.name.clone(),
                            uid: r.uid.clone(),
                        })
                        .collect()
                }),
            };
            Ok(Resource {
                api_version: "autoscaling.k8s.io/v1".to_string(),
                kind: "VerticalPodAutoscaler".to_string(),
                metadata,
                spec: vpa.data.get("spec").cloned(),
                status: vpa.data.get("status").cloned(),
                data: None,
                type_: None,
            })
        }
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
        ResourceType::Services => {
            use k8s_openapi::api::core::v1::Service;
            let api: Api<Service> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete service")?;
            Ok(())
        }
        ResourceType::ConfigMaps => {
            use k8s_openapi::api::core::v1::ConfigMap;
            let api: Api<ConfigMap> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete configmap")?;
            Ok(())
        }
        ResourceType::Secrets => {
            use k8s_openapi::api::core::v1::Secret;
            let api: Api<Secret> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete secret")?;
            Ok(())
        }
        ResourceType::Ingresses => {
            use k8s_openapi::api::networking::v1::Ingress;
            let api: Api<Ingress> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete ingress")?;
            Ok(())
        }
        ResourceType::StatefulSets => {
            use k8s_openapi::api::apps::v1::StatefulSet;
            let api: Api<StatefulSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete statefulset")?;
            Ok(())
        }
        ResourceType::DaemonSets => {
            use k8s_openapi::api::apps::v1::DaemonSet;
            let api: Api<DaemonSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete daemonset")?;
            Ok(())
        }
        ResourceType::Jobs => {
            use k8s_openapi::api::batch::v1::Job;
            let api: Api<Job> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete job")?;
            Ok(())
        }
        ResourceType::CronJobs => {
            use k8s_openapi::api::batch::v1::CronJob;
            let api: Api<CronJob> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete cronjob")?;
            Ok(())
        }
        ResourceType::ReplicaSets => {
            use k8s_openapi::api::apps::v1::ReplicaSet;
            let api: Api<ReplicaSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete replicaset")?;
            Ok(())
        }
        ResourceType::Nodes => {
            use k8s_openapi::api::core::v1::Node;
            let api: Api<Node> = Api::all(client.clone());
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete node")?;
            Ok(())
        }
        ResourceType::Namespaces => {
            use k8s_openapi::api::core::v1::Namespace;
            let api: Api<Namespace> = Api::all(client.clone());
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete namespace")?;
            Ok(())
        }
        ResourceType::HorizontalPodAutoscalers => {
            use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
            let api: Api<HorizontalPodAutoscaler> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete HPA")?;
            Ok(())
        }
        ResourceType::VerticalPodAutoscalers => {
            use kube::api::DynamicObject;
            use kube::discovery::ApiResource;

            let ar = ApiResource {
                group: "autoscaling.k8s.io".to_string(),
                version: "v1".to_string(),
                kind: "VerticalPodAutoscaler".to_string(),
                api_version: "autoscaling.k8s.io/v1".to_string(),
                plural: "verticalpodautoscalers".to_string(),
            };

            let api: Api<DynamicObject> = match namespace {
                Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
                None => Api::default_namespaced_with(client.clone(), &ar),
            };
            api.delete(name, &DeleteParams::default())
                .await
                .context("Failed to delete VPA")?;
            Ok(())
        }
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

pub async fn label_resource(
    client: &Client,
    resource_type: ResourceType,
    name: &str,
    key: &str,
    value: &str,
    namespace: Option<&str>,
) -> Result<()> {
    let patch = serde_json::json!({ "metadata": { "labels": { key: value } } });
    let params = PatchParams::default();

    match resource_type {
        ResourceType::Pods => {
            use k8s_openapi::api::core::v1::Pod;
            let api: Api<Pod> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label pod")?;
            Ok(())
        }
        ResourceType::Deployments => {
            use k8s_openapi::api::apps::v1::Deployment;
            let api: Api<Deployment> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label deployment")?;
            Ok(())
        }
        ResourceType::Services => {
            use k8s_openapi::api::core::v1::Service;
            let api: Api<Service> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label service")?;
            Ok(())
        }
        ResourceType::ConfigMaps => {
            use k8s_openapi::api::core::v1::ConfigMap;
            let api: Api<ConfigMap> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label configmap")?;
            Ok(())
        }
        ResourceType::Secrets => {
            use k8s_openapi::api::core::v1::Secret;
            let api: Api<Secret> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label secret")?;
            Ok(())
        }
        ResourceType::Ingresses => {
            use k8s_openapi::api::networking::v1::Ingress;
            let api: Api<Ingress> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label ingress")?;
            Ok(())
        }
        ResourceType::StatefulSets => {
            use k8s_openapi::api::apps::v1::StatefulSet;
            let api: Api<StatefulSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label statefulset")?;
            Ok(())
        }
        ResourceType::DaemonSets => {
            use k8s_openapi::api::apps::v1::DaemonSet;
            let api: Api<DaemonSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label daemonset")?;
            Ok(())
        }
        ResourceType::Jobs => {
            use k8s_openapi::api::batch::v1::Job;
            let api: Api<Job> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label job")?;
            Ok(())
        }
        ResourceType::CronJobs => {
            use k8s_openapi::api::batch::v1::CronJob;
            let api: Api<CronJob> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label cronjob")?;
            Ok(())
        }
        ResourceType::ReplicaSets => {
            use k8s_openapi::api::apps::v1::ReplicaSet;
            let api: Api<ReplicaSet> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label replicaset")?;
            Ok(())
        }
        ResourceType::Nodes => {
            use k8s_openapi::api::core::v1::Node;
            let api: Api<Node> = Api::all(client.clone());
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label node")?;
            Ok(())
        }
        ResourceType::Namespaces => {
            use k8s_openapi::api::core::v1::Namespace;
            let api: Api<Namespace> = Api::all(client.clone());
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label namespace")?;
            Ok(())
        }
        ResourceType::HorizontalPodAutoscalers => {
            use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
            let api: Api<HorizontalPodAutoscaler> = match namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::default_namespaced(client.clone()),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label HPA")?;
            Ok(())
        }
        ResourceType::VerticalPodAutoscalers => {
            use kube::api::DynamicObject;
            use kube::discovery::ApiResource;

            let ar = ApiResource {
                group: "autoscaling.k8s.io".to_string(),
                version: "v1".to_string(),
                kind: "VerticalPodAutoscaler".to_string(),
                api_version: "autoscaling.k8s.io/v1".to_string(),
                plural: "verticalpodautoscalers".to_string(),
            };

            let api: Api<DynamicObject> = match namespace {
                Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
                None => Api::default_namespaced_with(client.clone(), &ar),
            };
            api.patch(name, &params, &Patch::Merge(patch))
                .await
                .context("Failed to label VPA")?;
            Ok(())
        }
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

pub async fn stream_pod_logs(
    client: &Client,
    pod_name: &str,
    container: Option<&str>,
    namespace: &str,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    previous: bool,
    tx: Sender<Result<String, String>>,
    cancelled: Arc<AtomicBool>,
) -> Result<()> {
    use futures::AsyncBufReadExt;
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
        follow: true,
        previous,
        timestamps: true,
        ..Default::default()
    };

    let mut stream = api
        .log_stream(pod_name, &lp)
        .await
        .context("Failed to stream pod logs")?;

    let mut line = String::new();
    loop {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }

        line.clear();
        let n = stream
            .read_line(&mut line)
            .await
            .context("Log stream error")?;
        if n == 0 {
            break;
        }

        let trimmed = line.trim_end_matches(['\n', '\r']).to_string();
        if !trimmed.is_empty() {
            let _ = tx.send(Ok(trimmed));
        }
    }

    Ok(())
}

pub async fn get_pod_events(
    client: &Client,
    pod_name: &str,
    namespace: &str,
) -> Result<Vec<crate::types::Event>> {
    use k8s_openapi::api::core::v1::Event;

    let api: Api<Event> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default()
        .fields(&format!(
            "involvedObject.name={},involvedObject.kind=Pod",
            pod_name
        ))
        .timeout(30);

    let events = api.list(&lp).await.context("Failed to get pod events")?;

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
            source: e
                .source
                .map(|s| s.component.unwrap_or_default())
                .unwrap_or_default(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference, Time};
    use k8s_openapi::chrono::{TimeZone, Utc};
    use std::collections::BTreeMap;

    #[test]
    fn metadata_from_maps_object_meta_fields() {
        let mut labels = BTreeMap::new();
        labels.insert("app".to_string(), "demo".to_string());

        let meta = ObjectMeta {
            name: Some("pod-1".to_string()),
            namespace: Some("ns-1".to_string()),
            uid: Some("uid-1".to_string()),
            resource_version: Some("rv-42".to_string()),
            labels: Some(labels),
            annotations: None,
            creation_timestamp: Some(Time(
                Utc.with_ymd_and_hms(2025, 1, 1, 12, 0, 0)
                    .single()
                    .expect("valid timestamp"),
            )),
            owner_references: Some(vec![OwnerReference {
                api_version: "apps/v1".to_string(),
                kind: "ReplicaSet".to_string(),
                name: "rs-1".to_string(),
                uid: "owner-uid".to_string(),
                ..Default::default()
            }]),
            ..Default::default()
        };

        let pod = Pod {
            metadata: meta.clone(),
            ..Default::default()
        };
        let mapped = metadata_from(&pod, &meta);

        assert_eq!(mapped.name, "pod-1");
        assert_eq!(mapped.namespace.as_deref(), Some("ns-1"));
        assert_eq!(mapped.uid, "uid-1");
        assert_eq!(mapped.resource_version, "rv-42");
        assert_eq!(
            mapped.creation_timestamp.as_deref(),
            Some("2025-01-01T12:00:00+00:00")
        );
        assert_eq!(
            mapped.labels.as_ref().and_then(|m| m.get("app")),
            Some(&"demo".to_string())
        );
        assert_eq!(mapped.owner_references.as_ref().map(|v| v.len()), Some(1));
        assert_eq!(
            mapped
                .owner_references
                .as_ref()
                .and_then(|v| v.first())
                .map(|o| o.name.as_str()),
            Some("rs-1")
        );
    }

    #[test]
    fn metadata_from_uses_defaults_for_missing_fields() {
        let meta = ObjectMeta::default();
        let pod = Pod {
            metadata: meta.clone(),
            ..Default::default()
        };
        let mapped = metadata_from(&pod, &meta);

        assert_eq!(mapped.name, "");
        assert_eq!(mapped.uid, "");
        assert_eq!(mapped.resource_version, "");
        assert!(mapped.namespace.is_none());
        assert!(mapped.creation_timestamp.is_none());
    }
}
