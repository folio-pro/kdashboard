use super::pod::diagnose_pod;
use super::types::DiagnosticIssue;
use super::workload::diagnose_deployment;

// -----------------------------------------------------------------------
// diagnose_pod: CrashLoopBackOff
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_crash_loop_backoff() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Running",
            "containerStatuses": [{
                "name": "app",
                "restartCount": 15,
                "ready": false,
                "state": {
                    "waiting": {
                        "reason": "CrashLoopBackOff",
                        "message": "back-off 5m0s restarting failed container"
                    }
                }
            }]
        },
        "spec": {"containers": [{"name": "app"}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "crash" && i.title.contains("CrashLoopBackOff")));
    assert!(issues.iter().any(|i| i.severity == "critical"));
}

// -----------------------------------------------------------------------
// diagnose_pod: ImagePullBackOff
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_image_pull_backoff() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Pending",
            "containerStatuses": [{
                "name": "app",
                "restartCount": 0,
                "image": "registry.example.com/nonexistent:latest",
                "ready": false,
                "state": {
                    "waiting": {
                        "reason": "ImagePullBackOff",
                        "message": "Back-off pulling image"
                    }
                }
            }]
        },
        "spec": {"containers": [{"name": "app"}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "image" && i.severity == "critical"));
    assert!(issues.iter().any(|i| i.title.contains("cannot pull image")));
}

#[test]
fn diagnose_pod_err_image_pull() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Pending",
            "containerStatuses": [{
                "name": "app",
                "restartCount": 0,
                "image": "bad-image:v1",
                "ready": false,
                "state": {
                    "waiting": {
                        "reason": "ErrImagePull",
                        "message": "rpc error"
                    }
                }
            }]
        },
        "spec": {"containers": [{"name": "app"}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues.iter().any(|i| i.category == "image"));
}

// -----------------------------------------------------------------------
// diagnose_pod: OOMKilled
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_oomkilled_last_state() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Running",
            "containerStatuses": [{
                "name": "app",
                "restartCount": 3,
                "ready": true,
                "state": {"running": {}},
                "lastState": {
                    "terminated": {
                        "reason": "OOMKilled",
                        "exitCode": 137
                    }
                }
            }]
        },
        "spec": {"containers": [{"name": "app"}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "oom" && i.severity == "critical"));
    assert!(issues.iter().any(|i| i.title.contains("OOMKilled")));
}

#[test]
fn diagnose_pod_oomkilled_current_state() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Failed",
            "containerStatuses": [{
                "name": "worker",
                "restartCount": 0,
                "ready": false,
                "state": {
                    "terminated": {
                        "reason": "OOMKilled",
                        "exitCode": 137
                    }
                }
            }]
        },
        "spec": {"containers": [{"name": "worker"}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "oom" && i.title.contains("currently OOMKilled")));
}

// -----------------------------------------------------------------------
// diagnose_pod: high restart count
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_high_restart_count() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Running",
            "containerStatuses": [{
                "name": "app",
                "restartCount": 10,
                "ready": true,
                "state": {"running": {}}
            }]
        },
        "spec": {"containers": [{"name": "app"}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.severity == "warning" && i.title.contains("10 restarts")));
}

#[test]
fn diagnose_pod_low_restart_count_no_warning() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Running",
            "containerStatuses": [{
                "name": "app",
                "restartCount": 3,
                "ready": true,
                "state": {"running": {}}
            }]
        },
        "spec": {"containers": [{"name": "app", "resources": {"limits": {"cpu": "1"}}}]}
    });

    let issues = diagnose_pod(&obj);
    // restartCount 3 < 5 threshold, should not produce a restart warning
    assert!(!issues.iter().any(|i| i.title.contains("restarts")));
}

// -----------------------------------------------------------------------
// diagnose_pod: readiness probe failing
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_running_but_not_ready() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Running",
            "containerStatuses": [{
                "name": "api",
                "restartCount": 0,
                "ready": false,
                "state": {"running": {"startedAt": "2024-01-01T00:00:00Z"}}
            }]
        },
        "spec": {"containers": [{"name": "api", "resources": {"limits": {"cpu": "1"}}}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "readiness" && i.title.contains("not ready")));
}

// -----------------------------------------------------------------------
// diagnose_pod: scheduling failure
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_unschedulable() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Pending",
            "conditions": [{
                "type": "PodScheduled",
                "status": "False",
                "reason": "Unschedulable",
                "message": "0/3 nodes are available: insufficient cpu"
            }]
        },
        "spec": {"containers": [{"name": "app", "resources": {"limits": {"cpu": "1"}}}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "scheduling" && i.severity == "critical"));
    assert!(issues
        .iter()
        .any(|i| i.title.contains("cannot be scheduled")));
}

// -----------------------------------------------------------------------
// diagnose_pod: pending with no specific issues
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_pending_generic() {
    let obj = serde_json::json!({
        "status": {"phase": "Pending"},
        "spec": {"containers": [{"name": "app", "resources": {"limits": {"cpu": "1"}}}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "scheduling" && i.title.contains("Pending")));
}

// -----------------------------------------------------------------------
// diagnose_pod: missing resource limits
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_missing_resource_limits() {
    let obj = serde_json::json!({
        "status": {"phase": "Running", "containerStatuses": [{
            "name": "app", "restartCount": 0, "ready": true, "state": {"running": {}}
        }]},
        "spec": {"containers": [{"name": "app"}]}  // no resources field
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "resources" && i.severity == "info"));
    assert!(issues
        .iter()
        .any(|i| i.title.contains("no resource limits")));
}

#[test]
fn diagnose_pod_with_limits_no_resource_warning() {
    let obj = serde_json::json!({
        "status": {"phase": "Running", "containerStatuses": [{
            "name": "app", "restartCount": 0, "ready": true, "state": {"running": {}}
        }]},
        "spec": {"containers": [{
            "name": "app",
            "resources": {"limits": {"cpu": "500m", "memory": "256Mi"}}
        }]}
    });

    let issues = diagnose_pod(&obj);
    assert!(!issues.iter().any(|i| i.category == "resources"));
}

// -----------------------------------------------------------------------
// diagnose_pod: CreateContainerConfigError
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_config_error() {
    let obj = serde_json::json!({
        "status": {
            "phase": "Pending",
            "containerStatuses": [{
                "name": "app",
                "restartCount": 0,
                "ready": false,
                "state": {
                    "waiting": {
                        "reason": "CreateContainerConfigError",
                        "message": "secret \"db-secret\" not found"
                    }
                }
            }]
        },
        "spec": {"containers": [{"name": "app"}]}
    });

    let issues = diagnose_pod(&obj);
    assert!(issues
        .iter()
        .any(|i| i.category == "crash" && i.title.contains("config error")));
}

// -----------------------------------------------------------------------
// diagnose_pod: no status field
// -----------------------------------------------------------------------

#[test]
fn diagnose_pod_no_status_returns_empty() {
    let obj = serde_json::json!({"spec": {"containers": [{"name": "app"}]}});
    let issues = diagnose_pod(&obj);
    assert!(issues.is_empty());
}

// -----------------------------------------------------------------------
// diagnose_deployment: progress deadline exceeded
// -----------------------------------------------------------------------

#[test]
fn diagnose_deployment_progress_deadline_exceeded() {
    let obj = serde_json::json!({
        "spec": {"replicas": 3},
        "status": {
            "readyReplicas": 0,
            "conditions": [{
                "type": "Progressing",
                "status": "False",
                "reason": "ProgressDeadlineExceeded",
                "message": "Deployment exceeded its progress deadline"
            }]
        }
    });

    let issues = diagnose_deployment(&obj);
    assert!(issues
        .iter()
        .any(|i| i.severity == "critical" && i.title.contains("progress deadline")));
}

// -----------------------------------------------------------------------
// diagnose_deployment: no available replicas
// -----------------------------------------------------------------------

#[test]
fn diagnose_deployment_unavailable() {
    let obj = serde_json::json!({
        "spec": {"replicas": 2},
        "status": {
            "readyReplicas": 0,
            "conditions": [{
                "type": "Available",
                "status": "False",
                "message": "Deployment does not have minimum availability"
            }]
        }
    });

    let issues = diagnose_deployment(&obj);
    assert!(issues
        .iter()
        .any(|i| i.severity == "critical" && i.title.contains("no available replicas")));
}

// -----------------------------------------------------------------------
// diagnose_deployment: replica mismatch
// -----------------------------------------------------------------------

#[test]
fn diagnose_deployment_replica_mismatch() {
    let obj = serde_json::json!({
        "spec": {"replicas": 5},
        "status": {
            "readyReplicas": 3,
            "conditions": [{
                "type": "Available",
                "status": "True"
            }]
        }
    });

    let issues = diagnose_deployment(&obj);
    assert!(issues
        .iter()
        .any(|i| i.severity == "warning" && i.title.contains("3/5")));
}

#[test]
fn diagnose_deployment_all_replicas_ready_no_warning() {
    let obj = serde_json::json!({
        "spec": {"replicas": 3},
        "status": {
            "readyReplicas": 3,
            "conditions": [{
                "type": "Available",
                "status": "True"
            }]
        }
    });

    let issues = diagnose_deployment(&obj);
    assert!(!issues.iter().any(|i| i.category == "readiness"));
}

// -----------------------------------------------------------------------
// Health determination logic
// -----------------------------------------------------------------------

#[test]
fn health_unhealthy_when_critical_issue() {
    let issues = [DiagnosticIssue {
        severity: "critical".into(),
        category: "crash".into(),
        title: "test".into(),
        detail: "test".into(),
        suggestion: "test".into(),
    }];
    let health = if issues.iter().any(|i| i.severity == "critical") {
        "unhealthy"
    } else if issues.iter().any(|i| i.severity == "warning") {
        "degraded"
    } else {
        "healthy"
    };
    assert_eq!(health, "unhealthy");
}

#[test]
fn health_degraded_when_warning_only() {
    let issues = [DiagnosticIssue {
        severity: "warning".into(),
        category: "crash".into(),
        title: "test".into(),
        detail: "test".into(),
        suggestion: "test".into(),
    }];
    let health = if issues.iter().any(|i| i.severity == "critical") {
        "unhealthy"
    } else if issues.iter().any(|i| i.severity == "warning") {
        "degraded"
    } else {
        "healthy"
    };
    assert_eq!(health, "degraded");
}

#[test]
fn health_healthy_when_only_info() {
    let issues = [DiagnosticIssue {
        severity: "info".into(),
        category: "resources".into(),
        title: "test".into(),
        detail: "test".into(),
        suggestion: "test".into(),
    }];
    let health = if issues.iter().any(|i| i.severity == "critical") {
        "unhealthy"
    } else if issues.iter().any(|i| i.severity == "warning") {
        "degraded"
    } else {
        "healthy"
    };
    assert_eq!(health, "healthy");
}

#[test]
fn health_healthy_when_no_issues() {
    let issues: Vec<DiagnosticIssue> = vec![];
    let health = if issues.iter().any(|i| i.severity == "critical") {
        "unhealthy"
    } else if issues.iter().any(|i| i.severity == "warning") {
        "degraded"
    } else {
        "healthy"
    };
    assert_eq!(health, "healthy");
}
