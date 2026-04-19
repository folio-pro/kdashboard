use super::types::DiagnosticIssue;

pub fn diagnose_deployment(obj: &serde_json::Value) -> Vec<DiagnosticIssue> {
    let mut issues = Vec::new();
    let status = match obj.get("status") {
        Some(s) => s,
        None => return issues,
    };

    let conditions = status.get("conditions").and_then(|v| v.as_array());
    if let Some(conds) = conditions {
        for cond in conds {
            let ctype = cond.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let cstatus = cond.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let reason = cond.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            let message = cond.get("message").and_then(|v| v.as_str()).unwrap_or("");

            if ctype == "Progressing" && cstatus == "False" && reason == "ProgressDeadlineExceeded"
            {
                issues.push(DiagnosticIssue {
                    severity: "critical".into(),
                    category: "crash".into(),
                    title: "Deployment progress deadline exceeded".into(),
                    detail: message.to_string(),
                    suggestion: "The rollout is stuck. Check pod events and logs for the failing pods. Consider rolling back.".into(),
                });
            }

            if ctype == "Available" && cstatus == "False" {
                issues.push(DiagnosticIssue {
                    severity: "critical".into(),
                    category: "readiness".into(),
                    title: "Deployment has no available replicas".into(),
                    detail: message.to_string(),
                    suggestion: "Check the pods managed by this deployment for crash loops or scheduling issues.".into(),
                });
            }
        }
    }

    // Replica mismatch
    let desired = obj
        .get("spec")
        .and_then(|s| s.get("replicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let ready = status
        .get("readyReplicas")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if desired > 0 && ready < desired {
        issues.push(DiagnosticIssue {
            severity: "warning".into(),
            category: "readiness".into(),
            title: format!("Only {}/{} replicas ready", ready, desired),
            detail: "Not all desired replicas are ready.".into(),
            suggestion: "Check individual pods for issues. A rollout may be in progress.".into(),
        });
    }

    issues
}
