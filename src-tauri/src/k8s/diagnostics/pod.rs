use super::types::DiagnosticIssue;

pub fn diagnose_pod(obj: &serde_json::Value) -> Vec<DiagnosticIssue> {
    let mut issues = Vec::new();
    let status = match obj.get("status") {
        Some(s) => s,
        None => return issues,
    };

    let phase = status.get("phase").and_then(|v| v.as_str()).unwrap_or("");

    // Check container statuses
    let container_statuses = status.get("containerStatuses").and_then(|v| v.as_array());
    if let Some(statuses) = container_statuses {
        for cs in statuses {
            let container_name = cs.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
            let restart_count = cs.get("restartCount").and_then(|v| v.as_u64()).unwrap_or(0);

            // CrashLoopBackOff
            if let Some(waiting) = cs.get("state").and_then(|s| s.get("waiting")) {
                let reason = waiting.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                let message = waiting
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if reason == "CrashLoopBackOff" {
                    issues.push(DiagnosticIssue {
                        severity: "critical".into(),
                        category: "crash".into(),
                        title: format!("Container '{}' is in CrashLoopBackOff", container_name),
                        detail: format!("Restarts: {}. {}", restart_count, message),
                        suggestion: "Check container logs for the crash cause. Common causes: missing env vars, wrong command, config errors.".into(),
                    });
                }

                // ImagePullBackOff / ErrImagePull
                if reason == "ImagePullBackOff" || reason == "ErrImagePull" {
                    let image = cs
                        .get("image")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    issues.push(DiagnosticIssue {
                        severity: "critical".into(),
                        category: "image".into(),
                        title: format!("Container '{}' cannot pull image", container_name),
                        detail: format!("Image: {}. {}", image, message),
                        suggestion: "Verify image name/tag exists, check registry credentials (imagePullSecrets), and ensure network access to registry.".into(),
                    });
                }

                // CreateContainerConfigError
                if reason == "CreateContainerConfigError" {
                    issues.push(DiagnosticIssue {
                        severity: "critical".into(),
                        category: "crash".into(),
                        title: format!("Container '{}' has a config error", container_name),
                        detail: message.to_string(),
                        suggestion: "Check referenced ConfigMaps, Secrets, and volume mounts exist and are accessible.".into(),
                    });
                }
            }

            // OOMKilled (check last terminated state)
            if let Some(terminated) = cs.get("lastState").and_then(|s| s.get("terminated")) {
                let reason = terminated
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if reason == "OOMKilled" {
                    issues.push(DiagnosticIssue {
                        severity: "critical".into(),
                        category: "oom".into(),
                        title: format!("Container '{}' was OOMKilled", container_name),
                        detail: format!("The container exceeded its memory limit and was killed. Restarts: {}", restart_count),
                        suggestion: "Increase memory limits in the pod spec, or investigate the application's memory usage for leaks.".into(),
                    });
                }
            }

            // Also check current terminated state
            if let Some(terminated) = cs.get("state").and_then(|s| s.get("terminated")) {
                let reason = terminated
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if reason == "OOMKilled" {
                    issues.push(DiagnosticIssue {
                        severity: "critical".into(),
                        category: "oom".into(),
                        title: format!("Container '{}' is currently OOMKilled", container_name),
                        detail: "The container ran out of memory.".into(),
                        suggestion:
                            "Increase memory limits or optimize the application's memory usage."
                                .into(),
                    });
                }
            }

            // High restart count
            if restart_count > 5 {
                issues.push(DiagnosticIssue {
                    severity: "warning".into(),
                    category: "crash".into(),
                    title: format!("Container '{}' has {} restarts", container_name, restart_count),
                    detail: "Frequent restarts indicate instability.".into(),
                    suggestion: "Check logs across restarts (use --previous flag) to identify the recurring failure pattern.".into(),
                });
            }

            // Not ready
            let ready = cs.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
            if !ready && cs.get("state").and_then(|s| s.get("running")).is_some() {
                issues.push(DiagnosticIssue {
                    severity: "warning".into(),
                    category: "readiness".into(),
                    title: format!("Container '{}' is running but not ready", container_name),
                    detail: "The readiness probe is failing.".into(),
                    suggestion:
                        "Check readiness probe configuration and the application's health endpoint."
                            .into(),
                });
            }
        }
    }

    // Check conditions
    let conditions = status.get("conditions").and_then(|v| v.as_array());
    if let Some(conds) = conditions {
        for cond in conds {
            let ctype = cond.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let cstatus = cond.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let reason = cond.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            let message = cond.get("message").and_then(|v| v.as_str()).unwrap_or("");

            // Unschedulable
            if ctype == "PodScheduled" && cstatus == "False" {
                issues.push(DiagnosticIssue {
                    severity: "critical".into(),
                    category: "scheduling".into(),
                    title: "Pod cannot be scheduled".into(),
                    detail: format!("{}: {}", reason, message),
                    suggestion: "Check node resources (CPU/memory availability), node taints/tolerations, and affinity rules.".into(),
                });
            }
        }
    }

    // Pending phase
    if phase == "Pending" && issues.is_empty() {
        issues.push(DiagnosticIssue {
            severity: "warning".into(),
            category: "scheduling".into(),
            title: "Pod is in Pending state".into(),
            detail: "The pod has not been scheduled yet.".into(),
            suggestion: "Check events for scheduling details, verify resource availability and node capacity.".into(),
        });
    }

    // Check for missing resource limits
    if let Some(containers) = obj
        .get("spec")
        .and_then(|s| s.get("containers"))
        .and_then(|v| v.as_array())
    {
        for container in containers {
            let name = container
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let resources = container.get("resources");
            let has_limits = resources
                .and_then(|r| r.get("limits"))
                .map(|l| l.as_object().map(|o| !o.is_empty()).unwrap_or(false))
                .unwrap_or(false);

            if !has_limits {
                issues.push(DiagnosticIssue {
                    severity: "info".into(),
                    category: "resources".into(),
                    title: format!("Container '{}' has no resource limits", name),
                    detail:
                        "Without resource limits, the container can consume unbounded resources."
                            .into(),
                    suggestion:
                        "Set memory and CPU limits to prevent resource contention and OOM kills."
                            .into(),
                });
            }
        }
    }

    issues
}
