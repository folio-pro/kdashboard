use super::AppView;
use crate::app_state::{AIChatRole, AppState, app_state, update_app_state};
use crate::settings::AIProvider;
use gpui::prelude::FluentBuilder;
use gpui::*;
use k8s_client::Resource;
use std::collections::BTreeSet;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use ui::gpui_component::input::{Input, InputEvent, InputState};
use ui::{IconName, Sizable, secondary_btn, theme};

#[derive(Clone)]
struct PromptContextSnapshot {
    context: Option<String>,
    namespace: Option<String>,
    selected_resource: Option<Resource>,
}

impl AppView {
    fn ensure_ai_prompt_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.ai_prompt_input.is_some() {
            return;
        }
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Pregunta sobre el recurso seleccionado...")
        });
        let sub = cx.subscribe(&input, |this, _input, ev: &InputEvent, cx| {
            if let InputEvent::PressEnter { secondary } = ev {
                if !secondary {
                    this.send_ai_prompt(cx);
                }
            }
        });
        self.ai_prompt_input = Some(input);
        self._ai_prompt_subscription = Some(sub);
    }

    fn read_ai_prompt(&self, cx: &Context<'_, Self>) -> String {
        self.ai_prompt_input
            .as_ref()
            .map(|i| i.read(cx).text().to_string().trim().to_string())
            .unwrap_or_default()
    }

    fn apply_pending_ai_input_clear(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if !self.ai_clear_input_pending {
            return;
        }
        if let Some(input) = self.ai_prompt_input.as_ref() {
            input.update(cx, |input_state, cx| {
                input_state.set_value("", window, cx);
            });
        }
        self.ai_clear_input_pending = false;
    }

    fn apply_pending_ai_input_prefill(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let prefill = cx.update_global::<AppState, _>(|state, _| state.take_ai_prefill_prompt());
        let Some((prefill, auto_send)) = prefill else {
            return;
        };
        if let Some(input) = self.ai_prompt_input.as_ref() {
            input.update(cx, |input_state, cx| {
                input_state.set_value(&prefill, window, cx);
            });
        }
        if auto_send {
            self.send_ai_prompt(cx);
        }
    }

    fn send_ai_prompt(&mut self, cx: &mut Context<'_, Self>) {
        let is_sending = cx.global::<AppState>().ai_request_in_flight;
        if is_sending {
            return;
        }

        let user_prompt = self.read_ai_prompt(cx);
        if user_prompt.is_empty() {
            return;
        }

        let state = cx.global::<AppState>();
        let provider = state.ai_provider;
        let selected_model = state.opencode_selected_model.clone();
        let selected_resource_for_prompt = state
            .ai_target_resource
            .clone()
            .or_else(|| state.selected_resource.clone());
        let snapshot = PromptContextSnapshot {
            context: state.context.clone(),
            namespace: state.namespace.clone(),
            selected_resource: selected_resource_for_prompt,
        };
        update_app_state(cx, |state, _| {
            state.ai_target_resource = None;
        });
        run_ai_user_prompt(cx, provider, selected_model, user_prompt, snapshot);
        self.ai_clear_input_pending = true;
        cx.notify();
    }

    pub(super) fn render_ai_panel_body(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> impl IntoElement {
        self.ensure_ai_prompt_input(window, cx);
        self.apply_pending_ai_input_prefill(window, cx);
        self.apply_pending_ai_input_clear(window, cx);
        let theme = theme(cx);
        let colors = &theme.colors;
        let state = app_state(cx);

        let is_sending = state.ai_request_in_flight;
        let messages = state.ai_messages.clone();
        let has_messages = !messages.is_empty();
        let prompt_input = self.ai_prompt_input.as_ref().map(|input| {
            Input::new(input)
                .appearance(false)
                .cleanable(true)
                .with_size(ui::Size::Small)
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .min_w(px(0.0))
                    .overflow_hidden()
                    .child(
                        div()
                            .id("ai-chat-scroll")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.ai_scroll_handle)
                            .p(px(12.0))
                            .bg(colors.surface)
                            .flex()
                            .flex_col()
                            .gap(px(8.0))
                            .children(messages.into_iter().map(|msg| {
                                let is_user = matches!(msg.role, AIChatRole::User);
                                let bubble_bg = if is_user {
                                    colors.primary.opacity(0.2)
                                } else {
                                    colors.surface_elevated
                                };
                                let align = if is_user {
                                    div().w_full().flex().justify_end()
                                } else {
                                    div().w_full().flex().justify_start()
                                };
                                align.child(
                                    div()
                                        .w_full()
                                        .max_w(px(290.0))
                                        .p(px(10.0))
                                        .rounded(theme.border_radius_md)
                                        .bg(bubble_bg)
                                        .child(render_markdown_message(
                                            cx,
                                            &msg.content,
                                            colors.text,
                                        )),
                                )
                            }))
                            .when(!has_messages, |el| {
                                el.child(
                                    div()
                                        .text_size(px(12.0))
                                        .text_color(colors.text_muted)
                                        .child("Escribe una pregunta para empezar."),
                                )
                            })
                            .when(is_sending, |el| {
                                el.child(
                                    div().w_full().flex().justify_start().child(
                                        div()
                                            .p(px(10.0))
                                            .rounded(theme.border_radius_md)
                                            .bg(colors.surface_elevated)
                                            .text_size(px(12.0))
                                            .text_color(colors.text_muted)
                                            .child("Pensando..."),
                                    ),
                                )
                            }),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .bg(colors.surface)
                    .border_t_1()
                    .border_color(colors.border)
                    .p(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex_1()
                            .px(px(8.0))
                            .py(px(6.0))
                            .rounded(theme.border_radius_md)
                            .bg(colors.surface_elevated)
                            .border_1()
                            .border_color(colors.border)
                            .when_some(prompt_input, |el, input| el.child(input)),
                    )
                    .child(
                        secondary_btn("ai-panel-send-btn", IconName::ArrowLeft, "Enviar", colors)
                            .when(is_sending, |el| el.opacity(0.5))
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                this.send_ai_prompt(cx);
                            })),
                    ),
            )
    }
}

fn summarize_selected_resource(resource: &Resource) -> String {
    let name = &resource.metadata.name;
    let ns = resource
        .metadata
        .namespace
        .as_deref()
        .unwrap_or("cluster-scope");
    match resource.kind.as_str() {
        "Pod" => {
            let phase = resource
                .status
                .as_ref()
                .and_then(|s| s.get("phase"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");
            let node = resource
                .spec
                .as_ref()
                .and_then(|s| s.get("nodeName"))
                .and_then(|v| v.as_str())
                .unwrap_or("-");
            format!("Pod {}/{} phase={} node={}", ns, name, phase, node)
        }
        "Deployment" => {
            let desired = resource
                .spec
                .as_ref()
                .and_then(|s| s.get("replicas"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let available = resource
                .status
                .as_ref()
                .and_then(|s| s.get("availableReplicas"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            format!(
                "Deployment {}/{} replicas={}/{}",
                ns, name, available, desired
            )
        }
        "Service" => {
            let service_type = resource
                .spec
                .as_ref()
                .and_then(|s| s.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("ClusterIP");
            format!("Service {}/{} type={}", ns, name, service_type)
        }
        _ => format!("{} {}/{}", resource.kind, ns, name),
    }
}

fn build_ai_prompt_with_k8s_context(
    snapshot: &PromptContextSnapshot,
    user_prompt: &str,
    auto_diagnostic: Option<&str>,
) -> String {
    let context = snapshot.context.as_deref().unwrap_or("unknown");
    let namespace = snapshot.namespace.as_deref().unwrap_or("all");
    let expert_system_prompt = r#"Act as a Senior SRE with deep Kubernetes expertise. Investigate incidents and determine root cause, impact, and remediation.

Goal:
- Diagnose the issue with high confidence.
- Avoid assumptions: explicitly state missing information.
- Prioritize evidence (events, logs, actual cluster state).

Data to collect and analyze when available in the provided context:
1) Cluster baseline
- current context, namespaces, nodes, node utilization
2) Affected resource and related objects
- resource YAML/describe, related workload/network/policy/autoscaling objects, namespace events
3) If Pods are failing
- pod status/describe, current logs, previous logs, container-level utilization
4) Configuration and dependencies
- configmaps/secrets/serviceaccounts/rbac, storage objects, services/endpoints/endpointslices, ingress
5) Control plane and scheduling health
- cluster-wide events, taints/tolerations, affinity/anti-affinity, requests/limits, quotas/limitranges, PDB, imagePullSecrets, ServiceAccount/RBAC

Analysis rules:
- Correlate timestamps across events, rollouts, and logs.
- Clearly separate symptom vs root cause.
- List hypotheses with confidence level (High/Medium/Low) and supporting evidence.
- If multiple causes are possible, rank by probability and impact.
- Do not propose risky changes without rollback steps.
- If available data is insufficient, state exactly what is missing and why.

Required output format:
1. Executive summary (5-8 lines)
2. Key findings (bullet points with evidence)
3. Most likely root cause
4. Alternative hypotheses rejected (and why)
5. Immediate remediation plan (step-by-step with commands)
6. Post-fix validation (what to measure and how to confirm)
7. Future prevention (alerts, probes, limits, policies)
8. Critical missing information (if any)"#;

    let selected_resource_section = if let Some(resource) = &snapshot.selected_resource {
        let summary = summarize_selected_resource(resource);
        let resource_json = serde_json::json!({
            "apiVersion": resource.api_version,
            "kind": resource.kind,
            "metadata": {
                "name": resource.metadata.name,
                "namespace": resource.metadata.namespace,
                "labels": resource.metadata.labels,
                "creationTimestamp": resource.metadata.creation_timestamp,
            },
            "spec": resource.spec,
            "status": resource.status
        });
        let resource_json_pretty =
            serde_json::to_string_pretty(&resource_json).unwrap_or_else(|_| "{}".to_string());
        let truncated = if resource_json_pretty.len() > 5000 {
            format!("{}...(truncated)", &resource_json_pretty[..5000])
        } else {
            resource_json_pretty
        };
        format!(
            "Selected resource summary:\n{}\n\nSelected resource snapshot (JSON):\n{}\n",
            summary, truncated
        )
    } else {
        "Selected resource summary:\nNone\n".to_string()
    };

    let diagnostic_section = if let Some(diag) = auto_diagnostic {
        format!("Automatic diagnostic run (question-driven):\n{}\n\n", diag)
    } else {
        String::new()
    };

    format!(
        "System role:\n{}\n\nKubernetes context:\n- context: {}\n- namespace: {}\n\n{}{}\nUser question:\n{}",
        expert_system_prompt,
        context,
        namespace,
        selected_resource_section,
        diagnostic_section,
        user_prompt
    )
}

fn run_ai_user_prompt(
    cx: &mut App,
    provider: AIProvider,
    model: Option<String>,
    user_prompt: String,
    prompt_context: PromptContextSnapshot,
) {
    tracing::info!(
        "Preparing AI prompt provider={} model={} user_prompt_len={}",
        provider.display_name(),
        model.as_deref().unwrap_or("<none>"),
        user_prompt.len(),
    );

    update_app_state(cx, |state, _| {
        state.set_ai_request_in_flight(true);
        state.push_ai_user_message(user_prompt.clone());
    });

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let auto_diagnostic = run_question_based_auto_diagnostic(&prompt_context, &user_prompt);
        let enriched_prompt = build_ai_prompt_with_k8s_context(
            &prompt_context,
            &user_prompt,
            auto_diagnostic.as_deref(),
        );
        tracing::info!(
            "Sending AI prompt provider={} model={} enriched_len={}",
            provider.display_name(),
            model.as_deref().unwrap_or("<none>"),
            enriched_prompt.len()
        );
        let result =
            run_ai_provider_prompt(provider, model, &enriched_prompt, Duration::from_secs(90));
        let _ = tx.send(result);
    });

    cx.spawn(async move |cx| {
        for _ in 0..900 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx| {
                    update_app_state(cx, |state, _| {
                        state.set_ai_request_in_flight(false);
                        match result {
                            Ok(answer) => {
                                let normalized = normalize_ai_template_response(&answer);
                                state.ai_connection_message = Some(normalized.clone());
                                state.push_ai_assistant_message(normalized);
                            }
                            Err(error) => {
                                state.ai_connection_message = Some(error.clone());
                                state.push_ai_assistant_message(format!("Error: {}", error));
                            }
                        }
                    });
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;
        }
        let _ = cx.update(|cx| {
            update_app_state(cx, |state, _| {
                state.set_ai_request_in_flight(false);
                state.ai_connection_message =
                    Some("Timed out waiting for the AI provider response".to_string());
                state.push_ai_assistant_message("Error: request timed out".to_string());
            });
        });
    })
    .detach();
}

fn run_question_based_auto_diagnostic(
    prompt_context: &PromptContextSnapshot,
    user_prompt: &str,
) -> Option<String> {
    let intent = DiagnosticIntent::from_prompt(user_prompt);
    if let Some(selected) = prompt_context.selected_resource.as_ref() {
        match selected.kind.as_str() {
            "Pod" => return run_pod_question_diagnostic(prompt_context, selected, intent),
            "Deployment" => {
                return run_deployment_question_diagnostic(prompt_context, selected, intent);
            }
            _ => {}
        }
    }

    if intent.pending || intent.pod_issue {
        return run_namespace_pending_pods_diagnostic(prompt_context, intent);
    }

    None
}

#[derive(Clone, Copy, Debug, Default)]
struct DiagnosticIntent {
    pod_issue: bool,
    deployment_issue: bool,
    pending: bool,
    crash: bool,
    image_pull: bool,
    config_error: bool,
    oom: bool,
    evicted: bool,
    restart: bool,
}

impl DiagnosticIntent {
    fn from_prompt(prompt: &str) -> Self {
        let lower = prompt.to_lowercase();
        let has = |terms: &[&str]| terms.iter().any(|term| lower.contains(term));

        let pending = has(&["pending", "atascado", "stuck", "scheduling", "schedul"]);
        let crash = has(&[
            "crashloop",
            "crash loop",
            "crash",
            "no arranca",
            "failed container",
            "segfault",
            "backoff",
        ]);
        let image_pull = has(&[
            "imagepullbackoff",
            "errimagepull",
            "image pull",
            "pull image",
            "imagen",
            "registry",
        ]);
        let config_error = has(&[
            "createcontainerconfigerror",
            "createcontainererror",
            "config error",
            "secret",
            "configmap",
            "env var",
        ]);
        let oom = has(&["oomkilled", "oom killed", "out of memory", "memoria"]);
        let evicted = has(&["evicted", "desalojado", "disk pressure", "memory pressure"]);
        let restart = has(&["restart", "reinicia", "restarts", "restarted"]);

        let pod_issue = has(&[
            "pod",
            "container",
            "logs",
            "log",
            "why",
            "por qué",
            "porque",
            "qué pasa",
            "que pasa",
        ]) || pending
            || crash
            || image_pull
            || config_error
            || oom
            || evicted
            || restart;

        let deployment_issue = has(&[
            "deployment",
            "rollout",
            "replica",
            "no available",
            "unavailable",
            "degrad",
            "progressdeadlineexceeded",
        ]);

        Self {
            pod_issue,
            deployment_issue,
            pending,
            crash,
            image_pull,
            config_error,
            oom,
            evicted,
            restart,
        }
    }
}

fn run_pod_question_diagnostic(
    prompt_context: &PromptContextSnapshot,
    pod: &Resource,
    intent: DiagnosticIntent,
) -> Option<String> {
    let pod_name = pod.metadata.name.clone();
    let namespace = pod
        .metadata
        .namespace
        .clone()
        .or_else(|| prompt_context.namespace.clone())?;

    let phase = pod
        .status
        .as_ref()
        .and_then(|s| s.get("phase"))
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let waiting_reasons = pod_waiting_reasons(pod);
    let terminated_reasons = pod_terminated_reasons(pod);
    let restarts = pod_restart_count(pod);

    let pod_is_problematic = phase == "Pending"
        || phase == "Failed"
        || restarts > 0
        || !waiting_reasons.is_empty()
        || !terminated_reasons.is_empty();

    if !intent.pod_issue && !pod_is_problematic {
        return None;
    }

    let should_collect_logs = phase != "Pending"
        || intent.crash
        || intent.restart
        || intent.pending
        || intent.image_pull
        || intent.config_error
        || intent.oom
        || intent.evicted
        || waiting_reasons
            .iter()
            .any(|r| matches!(r.as_str(), "CrashLoopBackOff" | "Error"));
    let should_collect_previous_logs =
        intent.crash || intent.restart || waiting_reasons.iter().any(|r| r == "CrashLoopBackOff");

    let rt = k8s_client::tokio_runtime();
    rt.block_on(async move {
        let client = match k8s_client::get_client().await {
            Ok(c) => c,
            Err(e) => {
                return Some(format!(
                    "Could not run automatic pod diagnostic: failed to get k8s client: {}",
                    e
                ));
            }
        };

        let events_result = k8s_client::get_pod_events(&client, &pod_name, &namespace).await;
        let logs_result = if should_collect_logs {
            Some(
                k8s_client::get_pod_logs(
                    &client,
                    &pod_name,
                    None,
                    &namespace,
                    Some(80),
                    Some(2400),
                )
                .await,
            )
        } else {
            None
        };
        let previous_logs_result = if should_collect_previous_logs {
            Some(
                k8s_client::get_pod_logs(
                    &client,
                    &pod_name,
                    None,
                    &namespace,
                    Some(80),
                    Some(3600),
                )
                .await,
            )
        } else {
            None
        };

        let mut lines = Vec::new();
        lines.push(format!(
            "Pod diagnostic for {}/{}: phase={}, restarts={}",
            namespace, pod_name, phase, restarts
        ));
        if !waiting_reasons.is_empty() {
            lines.push(format!(
                "Container waiting reasons: {}",
                waiting_reasons.join(", ")
            ));
        }
        if !terminated_reasons.is_empty() {
            lines.push(format!(
                "Recent termination reasons: {}",
                terminated_reasons.join(", ")
            ));
        }

        match events_result {
            Ok(mut events) => {
                events.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
                if events.is_empty() {
                    lines.push("No pod events were returned.".to_string());
                } else {
                    lines.push("Top pod events:".to_string());
                    for ev in events.into_iter().take(8) {
                        lines.push(format!(
                            "- [{}] {}: {}",
                            ev.event_type, ev.reason, ev.message
                        ));
                    }
                }
            }
            Err(e) => lines.push(format!("Could not read pod events: {}", e)),
        }

        if let Some(result) = logs_result {
            match result {
                Ok(logs) => {
                    let snippet: String = logs.lines().take(30).collect::<Vec<_>>().join("\n");
                    if snippet.is_empty() {
                        lines.push("Current pod logs are empty.".to_string());
                    } else {
                        lines.push("Current logs snippet:".to_string());
                        lines.push(snippet);
                    }
                }
                Err(e) => lines.push(format!("Could not fetch current logs: {}", e)),
            }
        }

        if let Some(result) = previous_logs_result {
            match result {
                Ok(logs) => {
                    let snippet: String = logs.lines().take(20).collect::<Vec<_>>().join("\n");
                    if !snippet.is_empty() {
                        lines.push("Previous logs snippet (restart/crash context):".to_string());
                        lines.push(snippet);
                    }
                }
                Err(e) => lines.push(format!("Could not fetch previous logs: {}", e)),
            }
        }

        Some(lines.join("\n"))
    })
}

fn run_deployment_question_diagnostic(
    prompt_context: &PromptContextSnapshot,
    deployment: &Resource,
    intent: DiagnosticIntent,
) -> Option<String> {
    let namespace = deployment
        .metadata
        .namespace
        .clone()
        .or_else(|| prompt_context.namespace.clone())?;
    let deployment_name = deployment.metadata.name.clone();

    let desired = deployment
        .spec
        .as_ref()
        .and_then(|s| s.get("replicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1);
    let available = deployment
        .status
        .as_ref()
        .and_then(|s| s.get("availableReplicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let ready = deployment
        .status
        .as_ref()
        .and_then(|s| s.get("readyReplicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let updated = deployment
        .status
        .as_ref()
        .and_then(|s| s.get("updatedReplicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let rollout_problem = available < desired || ready < desired || updated < desired;
    if !intent.deployment_issue && !rollout_problem {
        return None;
    }

    let selector = deployment
        .spec
        .as_ref()
        .and_then(|s| s.get("selector"))
        .and_then(|v| v.get("matchLabels"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let rt = k8s_client::tokio_runtime();
    rt.block_on(async move {
        let client = match k8s_client::get_client().await {
            Ok(c) => c,
            Err(e) => {
                return Some(format!(
                    "Could not run automatic deployment diagnostic: failed to get k8s client: {}",
                    e
                ))
            }
        };

        let pods_result =
            k8s_client::list_resources(&client, k8s_client::ResourceType::Pods, Some(&namespace)).await;

        let mut lines = Vec::new();
        lines.push(format!(
            "Deployment diagnostic for {}/{}: available/desired={}/{}, ready/desired={}/{}, updated/desired={}/{}",
            namespace, deployment_name, available, desired, ready, desired, updated, desired
        ));

        if selector.is_empty() {
            lines.push("Deployment selector.matchLabels is empty; cannot map pods reliably.".to_string());
            return Some(lines.join("\n"));
        }

        match pods_result {
            Ok(pods) => {
                let selected_pods: Vec<Resource> = pods
                    .items
                    .into_iter()
                    .filter(|pod| labels_match_selector(pod, &selector))
                    .collect();

                if selected_pods.is_empty() {
                    lines.push("No pods matched deployment selector.".to_string());
                    return Some(lines.join("\n"));
                }

                lines.push(format!(
                    "Pods matched by selector: {}",
                    selected_pods.len()
                ));

                let mut problem_summaries = Vec::new();
                for pod in selected_pods.iter().take(8) {
                    let phase = pod
                        .status
                        .as_ref()
                        .and_then(|s| s.get("phase"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown");
                    let waiting = pod_waiting_reasons(pod);
                    let terminated = pod_terminated_reasons(pod);
                    let restarts = pod_restart_count(pod);

                    if phase != "Running"
                        || restarts > 0
                        || !waiting.is_empty()
                        || !terminated.is_empty()
                    {
                        problem_summaries.push(format!(
                            "- {} phase={} restarts={} waiting=[{}] terminated=[{}]",
                            pod.metadata.name,
                            phase,
                            restarts,
                            waiting.join(", "),
                            terminated.join(", ")
                        ));
                    }
                }

                if problem_summaries.is_empty() {
                    lines.push("No obvious pod-level failures found in the first matched pods.".to_string());
                } else {
                    lines.push("Problematic matched pods:".to_string());
                    lines.extend(problem_summaries);
                }
            }
            Err(e) => lines.push(format!("Could not list deployment pods: {}", e)),
        }

        Some(lines.join("\n"))
    })
}

fn run_namespace_pending_pods_diagnostic(
    prompt_context: &PromptContextSnapshot,
    intent: DiagnosticIntent,
) -> Option<String> {
    let Some(namespace) = prompt_context.namespace.clone() else {
        return Some(
            "Namespace pod diagnostic could not run: no active namespace is selected (current scope is likely all namespaces)."
                .to_string(),
        );
    };
    let rt = k8s_client::tokio_runtime();

    rt.block_on(async move {
        let client = match k8s_client::get_client().await {
            Ok(c) => c,
            Err(e) => {
                return Some(format!(
                    "Could not run automatic namespace pod diagnostic: failed to get k8s client: {}",
                    e
                ))
            }
        };

        let pods_result =
            k8s_client::list_resources(&client, k8s_client::ResourceType::Pods, Some(&namespace)).await;

        let mut lines = Vec::new();
        lines.push(format!(
            "Namespace pod diagnostic for '{}': scanned pods in current namespace.",
            namespace
        ));

        let pods = match pods_result {
            Ok(pods) => pods.items,
            Err(e) => {
                lines.push(format!("Could not list pods in namespace '{}': {}", namespace, e));
                return Some(lines.join("\n"));
            }
        };

        let mut pending_pods: Vec<Resource> = pods
            .into_iter()
            .filter(|pod| {
                pod.status
                    .as_ref()
                    .and_then(|s| s.get("phase"))
                    .and_then(|v| v.as_str())
                    == Some("Pending")
            })
            .collect();

        pending_pods.sort_by(|a, b| a.metadata.name.cmp(&b.metadata.name));

        if pending_pods.is_empty() {
            lines.push("No pods are currently in Pending state in this namespace.".to_string());
            return Some(lines.join("\n"));
        }

        lines.push(format!(
            "Found {} Pending pod(s): {}",
            pending_pods.len(),
            pending_pods
                .iter()
                .take(12)
                .map(|p| p.metadata.name.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ));

        let collect_details = intent.pending || intent.crash || intent.image_pull || intent.config_error;
        if !collect_details {
            return Some(lines.join("\n"));
        }

        for pod in pending_pods.iter().take(4) {
            let pod_name = pod.metadata.name.clone();
            let waiting = pod_waiting_reasons(pod);
            let restarts = pod_restart_count(pod);
            lines.push(format!(
                "Pending pod {}: restarts={} waiting=[{}]",
                pod_name,
                restarts,
                waiting.join(", ")
            ));

            match k8s_client::get_pod_events(&client, &pod_name, &namespace).await {
                Ok(mut events) => {
                    events.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
                    if events.is_empty() {
                        lines.push(format!("- {} has no recent events.", pod_name));
                    } else {
                        lines.push(format!("- Top events for {}:", pod_name));
                        for ev in events.into_iter().take(4) {
                            lines.push(format!("  - [{}] {}: {}", ev.event_type, ev.reason, ev.message));
                        }
                    }
                }
                Err(e) => lines.push(format!("- Could not read events for {}: {}", pod_name, e)),
            }
        }

        Some(lines.join("\n"))
    })
}

fn labels_match_selector(
    pod: &Resource,
    selector: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    let Some(labels) = pod.metadata.labels.as_ref() else {
        return false;
    };

    selector.iter().all(|(key, val)| {
        let Some(expected) = val.as_str() else {
            return false;
        };
        labels
            .get(key)
            .map(|actual| actual == expected)
            .unwrap_or(false)
    })
}

fn pod_restart_count(resource: &Resource) -> u64 {
    resource
        .status
        .as_ref()
        .and_then(|s| s.get("containerStatuses"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("restartCount").and_then(|v| v.as_u64()))
                .sum()
        })
        .unwrap_or(0)
}

fn pod_waiting_reasons(resource: &Resource) -> Vec<String> {
    let mut reasons = BTreeSet::new();
    let Some(items) = resource
        .status
        .as_ref()
        .and_then(|s| s.get("containerStatuses"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    for item in items {
        if let Some(reason) = item
            .get("state")
            .and_then(|v| v.get("waiting"))
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str())
        {
            reasons.insert(reason.to_string());
        }
    }

    reasons.into_iter().collect()
}

fn pod_terminated_reasons(resource: &Resource) -> Vec<String> {
    let mut reasons = BTreeSet::new();
    let Some(items) = resource
        .status
        .as_ref()
        .and_then(|s| s.get("containerStatuses"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    for item in items {
        if let Some(reason) = item
            .get("lastState")
            .and_then(|v| v.get("terminated"))
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str())
        {
            reasons.insert(reason.to_string());
        }
        if let Some(reason) = item
            .get("state")
            .and_then(|v| v.get("terminated"))
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str())
        {
            reasons.insert(reason.to_string());
        }
    }

    reasons.into_iter().collect()
}

pub(super) fn run_ai_connection_test(cx: &mut App, provider: AIProvider, model: Option<String>) {
    tracing::info!(
        "Starting AI connection test provider={} model={}",
        provider.display_name(),
        model.as_deref().unwrap_or("<none>")
    );

    update_app_state(cx, |state, _| {
        state.set_ai_connection_testing(true);
    });

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let result = run_ai_provider_prompt(
            provider,
            model,
            "Reply with exactly 'OK' to validate the connection.",
            Duration::from_secs(20),
        );
        let _ = tx.send(result);
    });

    cx.spawn(async move |cx| {
        for _ in 0..200 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx| {
                    update_app_state(cx, |state, _| {
                        state.set_ai_connection_result(result.clone());
                        match result {
                            Ok(content) => {
                                tracing::info!("AI connection test succeeded");
                                state.push_ai_assistant_message(content);
                            }
                            Err(err) => {
                                tracing::error!("AI connection test failed: {}", err);
                                state.push_ai_assistant_message(format!("Error: {}", err));
                            }
                        }
                    });
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;
        }
        let _ = cx.update(|cx| {
            update_app_state(cx, |state, _| {
                tracing::error!("AI connection test timed out");
                state.set_ai_connection_result(Err(
                    "Timed out waiting for the AI provider response".to_string(),
                ));
            });
        });
    })
    .detach();
}

pub(super) fn load_opencode_models(cx: &mut App) {
    tracing::info!("Loading OpenCode models via `opencode models`");

    update_app_state(cx, |state, _| {
        state.set_opencode_models_loading(true);
    });

    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<String>, String>>();
    std::thread::spawn(move || {
        let output =
            run_command_with_timeout("opencode", &["models".to_string()], Duration::from_secs(20));
        let parsed = output.and_then(|text| parse_opencode_models(&text));
        let _ = tx.send(parsed);
    });

    cx.spawn(async move |cx| {
        for _ in 0..200 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx| {
                    update_app_state(cx, |state, _| {
                        state.set_opencode_models_loading(false);
                        match result {
                            Ok(models) => {
                                tracing::info!("Loaded {} OpenCode models", models.len());
                                state.set_opencode_models(models);
                            }
                            Err(error) => {
                                tracing::error!("Failed to load OpenCode models: {}", error);
                                state.ai_connection_message =
                                    Some(format!("Error loading OpenCode models: {}", error));
                            }
                        }
                    });
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;
        }
        let _ = cx.update(|cx| {
            update_app_state(cx, |state, _| {
                tracing::error!("Timeout loading OpenCode models");
                state.set_opencode_models_loading(false);
                state.ai_connection_message = Some("Timed out loading OpenCode models".to_string());
            });
        });
    })
    .detach();
}

fn parse_opencode_models(output: &str) -> Result<Vec<String>, String> {
    let mut set = BTreeSet::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains('/') && !trimmed.contains("http") && !trimmed.starts_with("ERROR") {
            let candidate = trimmed
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_matches(|c: char| c == '|' || c == ',' || c == ';');
            if candidate.contains('/') {
                set.insert(candidate.to_string());
            }
        }
    }
    if set.is_empty() {
        tracing::warn!(
            "OpenCode models output could not be parsed. Raw output: {}",
            output
        );
        return Err("No models were found in the `opencode models` output".to_string());
    }
    Ok(set.into_iter().collect())
}

fn normalize_ai_template_response(input: &str) -> String {
    let labels = [
        "Summary",
        "Findings",
        "Likely root cause",
        "Automatic checks performed",
        "Recommended next action",
        "Optional deeper checks",
    ];

    let mut out = input.to_string();

    // Ensure every section starts on its own line.
    for (idx, label) in labels.iter().enumerate() {
        let numbered_a = format!("{} ) {}", idx + 1, label);
        let numbered_b = format!("{}) {}", idx + 1, label);
        let plain = format!("{}:", label);
        out = out.replace(&numbered_a, &plain);
        out = out.replace(&numbered_b, &plain);
        out = out.replace(&format!(" {}", plain), &format!("\n{}", plain));
    }

    let mut sections: Vec<(String, String)> = Vec::new();
    for (idx, label) in labels.iter().enumerate() {
        let marker = format!("{}:", label);
        let start = match out.find(&marker) {
            Some(pos) => pos,
            None => continue,
        };
        let content_start = start + marker.len();
        let end = labels
            .iter()
            .enumerate()
            .skip(idx + 1)
            .filter_map(|(_j, next)| out[content_start..].find(&format!("{}:", next)))
            .map(|offset| content_start + offset)
            .min()
            .unwrap_or(out.len());

        let content = out[content_start..end].trim().to_string();
        sections.push((marker, content));
    }

    if sections.is_empty() {
        return out;
    }

    let mut normalized_lines = Vec::new();
    for (marker, content) in sections {
        if !content.is_empty() {
            normalized_lines.push(marker);
            normalized_lines.push(content);
            normalized_lines.push(String::new());
        }
    }

    let normalized = normalized_lines.join("\n").trim().to_string();
    if normalized.is_empty() {
        out.trim().to_string()
    } else {
        normalized
    }
}

#[derive(Clone, Copy)]
enum MdBlockKind {
    Paragraph,
    Heading(usize),
    ListItem,
    Quote,
    CodeFence,
}

fn parse_markdown_blocks(input: &str) -> Vec<(MdBlockKind, String)> {
    let mut blocks: Vec<(MdBlockKind, String)> = Vec::new();
    let mut paragraph_lines: Vec<String> = Vec::new();
    let mut in_code_fence = false;
    let mut code_lines: Vec<String> = Vec::new();

    let flush_paragraph = |lines: &mut Vec<String>, out: &mut Vec<(MdBlockKind, String)>| {
        if !lines.is_empty() {
            out.push((MdBlockKind::Paragraph, lines.join(" ")));
            lines.clear();
        }
    };

    for raw_line in input.lines() {
        let line = raw_line.trim_end();
        let trimmed = line.trim();

        if trimmed.starts_with("```") {
            flush_paragraph(&mut paragraph_lines, &mut blocks);
            if in_code_fence {
                blocks.push((MdBlockKind::CodeFence, code_lines.join("\n")));
                code_lines.clear();
                in_code_fence = false;
            } else {
                in_code_fence = true;
            }
            continue;
        }

        if in_code_fence {
            code_lines.push(line.to_string());
            continue;
        }

        if trimmed.is_empty() {
            flush_paragraph(&mut paragraph_lines, &mut blocks);
            continue;
        }

        if trimmed.starts_with("> ") {
            flush_paragraph(&mut paragraph_lines, &mut blocks);
            blocks.push((
                MdBlockKind::Quote,
                parse_inline_markdown_to_plain(trimmed[2..].trim()),
            ));
            continue;
        }

        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
            flush_paragraph(&mut paragraph_lines, &mut blocks);
            blocks.push((
                MdBlockKind::ListItem,
                parse_inline_markdown_to_plain(trimmed[2..].trim()),
            ));
            continue;
        }

        if let Some(dot_pos) = trimmed.find(". ") {
            let (left, right) = trimmed.split_at(dot_pos);
            if !left.is_empty() && left.chars().all(|c| c.is_ascii_digit()) {
                flush_paragraph(&mut paragraph_lines, &mut blocks);
                blocks.push((
                    MdBlockKind::ListItem,
                    parse_inline_markdown_to_plain(right[2..].trim()),
                ));
                continue;
            }
            continue;
        }

        if trimmed.starts_with('#') {
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            let content = trimmed[hashes..].trim();
            if !content.is_empty() && hashes <= 6 {
                flush_paragraph(&mut paragraph_lines, &mut blocks);
                blocks.push((
                    MdBlockKind::Heading(hashes),
                    parse_inline_markdown_to_plain(content),
                ));
                continue;
            }
        }

        paragraph_lines.push(parse_inline_markdown_to_plain(trimmed));
    }

    if in_code_fence {
        blocks.push((MdBlockKind::CodeFence, code_lines.join("\n")));
    }
    if !paragraph_lines.is_empty() {
        blocks.push((MdBlockKind::Paragraph, paragraph_lines.join(" ")));
    }

    if blocks.is_empty() {
        blocks.push((MdBlockKind::Paragraph, input.to_string()));
    }
    blocks
}

fn parse_inline_markdown_to_plain(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] == '`' {
            i += 1;
            while i < chars.len() && chars[i] != '`' {
                out.push(chars[i]);
                i += 1;
            }
            if i < chars.len() && chars[i] == '`' {
                i += 1;
            }
            continue;
        }

        if chars[i] == '[' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != ']' {
                j += 1;
            }
            if j + 1 < chars.len() && chars[j] == ']' && chars[j + 1] == '(' {
                let mut k = j + 2;
                while k < chars.len() && chars[k] != ')' {
                    k += 1;
                }
                if k < chars.len() && chars[k] == ')' {
                    let text: String = chars[i + 1..j].iter().collect();
                    let url: String = chars[j + 2..k].iter().collect();
                    out.push_str(text.trim());
                    if !url.trim().is_empty() {
                        out.push_str(" (");
                        out.push_str(url.trim());
                        out.push(')');
                    }
                    i = k + 1;
                    continue;
                }
            }
        }

        if chars[i] == '*' || chars[i] == '_' {
            i += 1;
            continue;
        }

        out.push(chars[i]);
        i += 1;
    }

    soft_wrap_long_tokens(&out, 32)
}

fn soft_wrap_long_tokens(input: &str, max_token_len: usize) -> String {
    let mut out = String::new();
    let mut token_len = 0usize;

    for ch in input.chars() {
        if ch.is_whitespace() {
            out.push(ch);
            token_len = 0;
            continue;
        }

        if token_len >= max_token_len {
            out.push(' ');
            token_len = 0;
        }

        out.push(ch);
        token_len += 1;
    }

    out
}

fn render_markdown_message(
    cx: &Context<'_, AppView>,
    content: &str,
    text_color: Hsla,
) -> impl IntoElement {
    let theme = theme(cx);
    let colors = &theme.colors;
    let blocks = parse_markdown_blocks(content);

    div()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .children(blocks.into_iter().map(|(kind, text)| {
            let wrapped_text = soft_wrap_long_tokens(&text, 64);
            let is_section_title = is_ai_section_title(&wrapped_text);
            match kind {
                MdBlockKind::Heading(level) => {
                    let size = match level {
                        1 => px(15.0),
                        2 => px(14.0),
                        _ => px(13.0),
                    };
                    div()
                        .min_w(px(0.0))
                        .text_size(size)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors.primary)
                        .child(wrapped_text)
                        .into_any_element()
                }
                MdBlockKind::ListItem => {
                    if is_section_title {
                        div()
                            .min_w(px(0.0))
                            .text_size(px(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors.primary)
                            .child(wrapped_text)
                            .into_any_element()
                    } else {
                        div()
                            .min_w(px(0.0))
                            .text_size(px(12.0))
                            .text_color(text_color)
                            .child(format!("• {}", wrapped_text))
                            .into_any_element()
                    }
                }
                MdBlockKind::Quote => div()
                    .min_w(px(0.0))
                    .pl(px(8.0))
                    .border_l_2()
                    .border_color(colors.border)
                    .text_size(px(12.0))
                    .text_color(colors.text_muted)
                    .child(format!("\"{}\"", wrapped_text))
                    .into_any_element(),
                MdBlockKind::CodeFence => div()
                    .min_w(px(0.0))
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(theme.border_radius_sm)
                    .bg(colors.background.opacity(0.45))
                    .border_1()
                    .border_color(colors.border)
                    .text_size(px(12.0))
                    .text_color(text_color)
                    .child(wrapped_text)
                    .into_any_element(),
                MdBlockKind::Paragraph => {
                    if is_section_title {
                        div()
                            .min_w(px(0.0))
                            .text_size(px(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors.primary)
                            .child(wrapped_text)
                            .into_any_element()
                    } else {
                        div()
                            .min_w(px(0.0))
                            .text_size(px(12.0))
                            .text_color(text_color)
                            .child(wrapped_text)
                            .into_any_element()
                    }
                }
            }
        }))
}

fn is_ai_section_title(text: &str) -> bool {
    let lower = text.trim().trim_end_matches(':').to_ascii_lowercase();

    let normalized = lower
        .strip_prefix("1) ")
        .or_else(|| lower.strip_prefix("2) "))
        .or_else(|| lower.strip_prefix("3) "))
        .or_else(|| lower.strip_prefix("4) "))
        .or_else(|| lower.strip_prefix("5) "))
        .or_else(|| lower.strip_prefix("6) "))
        .or_else(|| lower.strip_prefix("1. "))
        .or_else(|| lower.strip_prefix("2. "))
        .or_else(|| lower.strip_prefix("3. "))
        .or_else(|| lower.strip_prefix("4. "))
        .or_else(|| lower.strip_prefix("5. "))
        .or_else(|| lower.strip_prefix("6. "))
        .unwrap_or(&lower)
        .trim();

    matches!(
        normalized,
        "summary"
            | "findings"
            | "likely root cause"
            | "automatic checks performed"
            | "recommended next action"
            | "optional deeper checks"
    )
}

fn run_ai_provider_prompt(
    provider: AIProvider,
    model: Option<String>,
    prompt: &str,
    timeout: Duration,
) -> Result<String, String> {
    let candidates: Vec<(&str, Vec<String>)> = match provider {
        AIProvider::OpenCode => {
            let mut list = Vec::new();
            if let Some(m) = &model {
                list.push((
                    "opencode",
                    vec![
                        "-m".to_string(),
                        m.clone(),
                        "run".to_string(),
                        prompt.to_string(),
                    ],
                ));
                list.push((
                    "opencode",
                    vec![
                        "-m".to_string(),
                        m.clone(),
                        "--prompt".to_string(),
                        prompt.to_string(),
                    ],
                ));
            }
            list.push(("opencode", vec!["--prompt".to_string(), prompt.to_string()]));
            list.push(("opencode", vec!["run".to_string(), prompt.to_string()]));
            list
        }
        AIProvider::ClaudeCode => vec![
            (
                "claudecode",
                vec!["--prompt".to_string(), prompt.to_string()],
            ),
            ("claudecode", vec!["chat".to_string(), prompt.to_string()]),
            ("claudecode", vec![prompt.to_string()]),
        ],
    };

    let mut errors = Vec::new();
    for (command, args) in candidates {
        tracing::info!(
            "Running AI provider command: {} {}",
            command,
            args.join(" ")
        );
        match run_command_with_timeout(command, &args, timeout) {
            Ok(output) => return Ok(output),
            Err(err) => {
                tracing::error!(
                    "AI provider command failed: {} {} -> {}",
                    command,
                    args.join(" "),
                    err
                );
                errors.push(format!("{} {:?}: {}", command, args, err));
            }
        }
    }

    Err(format!(
        "Could not communicate with {}. Verify the binary is installed and available in PATH.\n{}",
        provider.display_name(),
        errors.join("\n")
    ))
}

fn run_command_with_timeout(
    command: &str,
    args: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let message = format!("Could not execute command: {}", e);
            tracing::error!("{} {} -> {}", command, args.join(" "), message);
            message
        })?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("Could not read command output: {}", e))?;
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

                if status.success() {
                    if stdout.is_empty() {
                        tracing::info!(
                            "Command succeeded with empty stdout: {} {}",
                            command,
                            args.join(" ")
                        );
                        return Ok("(no output)".to_string());
                    }
                    tracing::info!("Command succeeded: {} {}", command, args.join(" "));
                    return Ok(stdout);
                }

                let message = if stderr.is_empty() {
                    format!("Exit code {:?}", status.code())
                } else {
                    stderr
                };
                tracing::error!(
                    "Command failed status={:?}: {} {} -> {}",
                    status.code(),
                    command,
                    args.join(" "),
                    message
                );
                return Err(message);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    tracing::error!(
                        "Command timeout after {:?}: {} {}",
                        timeout,
                        command,
                        args.join(" ")
                    );
                    return Err("Command timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let message = format!("Error while waiting for process: {}", e);
                tracing::error!("{} {} -> {}", command, args.join(" "), message);
                return Err(message);
            }
        }
    }
}
