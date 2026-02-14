use super::AppView;
use crate::app_state::{ActiveView, AppState, app_state};
use gpui::prelude::FluentBuilder;
use gpui::*;
use ui::gpui_component::input::InputEvent;
use ui::theme;

#[derive(Clone)]
struct CommandCompletion {
    replacement: String,
}

impl AppView {
    fn set_command_bar_state(&mut self, open: bool) {
        self.command_bar_open = open;
        self.command_bar_error = None;
        self.command_bar_hint = None;
    }

    pub(super) fn ensure_command_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.command_input.is_some() {
            return;
        }

        let input = cx.new(|cx| {
            ui::gpui_component::input::InputState::new(window, cx)
                .placeholder("Type :command or /filter")
        });

        let sub = cx.subscribe(&input, |this, _input, ev: &InputEvent, cx| match ev {
            InputEvent::PressEnter { .. } => this.execute_command_bar(cx),
            InputEvent::Change => {
                this.command_bar_error = None;
                this.command_bar_hint = None;
                cx.notify();
            }
            _ => {}
        });

        self.command_input = Some(input);
        self._command_subscription = Some(sub);
    }

    fn set_command_input_value(
        &mut self,
        value: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.ensure_command_input(window, cx);
        if let Some(input) = &self.command_input {
            let value = value.clone();
            input.update(cx, move |input_state, cx| {
                input_state.set_value(value.clone(), window, cx);
            });
        }
    }

    pub(super) fn open_command_mode(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.set_command_bar_state(true);
        window.focus(&self.focus_handle);
        self.set_command_input_value(":".to_string(), window, cx);
        cx.notify();
    }

    pub(super) fn open_search_mode(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.set_command_bar_state(true);
        window.focus(&self.focus_handle);
        self.set_command_input_value("/".to_string(), window, cx);
        cx.notify();
    }

    pub(super) fn close_command_bar(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.set_command_bar_state(false);
        self.set_command_input_value(String::new(), window, cx);
        cx.notify();
    }

    pub(super) fn execute_command_bar(&mut self, cx: &mut Context<'_, Self>) {
        let text = self
            .command_input
            .as_ref()
            .map(|i| i.read(cx).text().to_string())
            .unwrap_or_default();

        let line = text.trim();
        if line.is_empty() {
            self.set_command_bar_state(false);
            cx.notify();
            return;
        }

        if let Some(filter) = line.strip_prefix('/') {
            cx.update_global::<AppState, _>(|state, _| {
                state.set_filter(filter.trim().to_string());
            });
            self.set_command_bar_state(false);
            cx.notify();
            return;
        }

        let Some(command_line) = line.strip_prefix(':') else {
            self.command_bar_error = Some("Command must start with ':' or '/'".to_string());
            cx.notify();
            return;
        };

        let command_line = command_line.trim();
        if command_line.is_empty() {
            self.set_command_bar_state(false);
            cx.notify();
            return;
        }

        let mut parts = command_line.split_whitespace();
        let command = parts.next().unwrap_or_default().to_ascii_lowercase();
        let args: Vec<&str> = parts.collect();

        let handled = match command.as_str() {
            "q" | "quit" => {
                self.set_command_bar_state(false);
                true
            }
            "help" | "?" => {
                self.command_bar_error = Some(
                    "K9s-like commands: :po :dp :svc :ing :cm :secret :rs :sts :ds :job :cj :node :ns :hpa :vpa :ctx <name> :ns <name> :pf and /filter"
                        .to_string(),
                );
                true
            }
            "ctx" | "context" | "contexts" => {
                if let Some(ctx_name) = args.first() {
                    crate::switch_context(cx, (*ctx_name).to_string());
                    self.set_command_bar_state(false);
                } else {
                    self.command_bar_error = Some("Usage: :ctx <context-name>".to_string());
                }
                true
            }
            "ns" | "namespace" => {
                if let Some(ns) = args.first() {
                    let namespace = (*ns).to_string();
                    let resource_type = cx.global::<AppState>().selected_type;
                    cx.update_global::<AppState, _>(|state, _| {
                        state.set_namespace(Some(namespace.clone()));
                    });
                    crate::load_resources(cx, resource_type, Some(namespace));
                    self.set_command_bar_state(false);
                } else {
                    cx.update_global::<AppState, _>(|state, _| {
                        state.set_selected_type(k8s_client::ResourceType::Namespaces);
                        state.active_view = ActiveView::ResourceTable;
                        state.set_selected_resource(None);
                    });
                    crate::load_resources(cx, k8s_client::ResourceType::Namespaces, None);
                    self.set_command_bar_state(false);
                }
                true
            }
            "pf" | "portforward" | "port-forwards" | "portforwards" => {
                cx.update_global::<AppState, _>(|state, _| {
                    state.active_view = ActiveView::PortForwards;
                    state.set_selected_resource(None);
                });
                self.set_command_bar_state(false);
                true
            }
            other => {
                if let Some(resource_type) = Self::resource_type_from_alias(other) {
                    self.execute_resource_command(resource_type, &args, cx);
                    true
                } else {
                    false
                }
            }
        };

        if !handled {
            self.command_bar_error = Some(format!("Unknown command '{}'. Try :help", command));
            cx.notify();
        }
    }

    fn command_input_text(&self, cx: &Context<'_, Self>) -> String {
        self.command_input
            .as_ref()
            .map(|i| i.read(cx).text().to_string())
            .unwrap_or_default()
    }

    fn command_catalog() -> &'static [(&'static str, &'static str)] {
        &[
            ("po", "Pods"),
            ("dp", "Deployments"),
            ("svc", "Services"),
            ("ing", "Ingresses"),
            ("cm", "ConfigMaps"),
            ("secret", "Secrets"),
            ("rs", "ReplicaSets"),
            ("sts", "StatefulSets"),
            ("ds", "DaemonSets"),
            ("job", "Jobs"),
            ("cj", "CronJobs"),
            ("node", "Nodes"),
            ("ns", "Namespaces"),
            ("hpa", "HorizontalPodAutoscalers"),
            ("vpa", "VerticalPodAutoscalers"),
            ("ctx", "Switch context"),
            ("pf", "Open port forwards"),
            ("help", "Show command help"),
            ("q", "Close command bar"),
        ]
    }

    fn completion_command(alias: &str) -> String {
        match alias {
            "po" => "pods".to_string(),
            "dp" => "deployments".to_string(),
            "svc" => "services".to_string(),
            "ing" => "ingresses".to_string(),
            "cm" => "configmaps".to_string(),
            "secret" => "secrets".to_string(),
            "rs" => "replicasets".to_string(),
            "sts" => "statefulsets".to_string(),
            "ds" => "daemonsets".to_string(),
            "job" => "jobs".to_string(),
            "cj" => "cronjobs".to_string(),
            "node" => "nodes".to_string(),
            "ctx" => "context".to_string(),
            "pf" => "portforward".to_string(),
            "q" => "quit".to_string(),
            other => other.to_string(),
        }
    }

    fn command_completions(&self, cx: &Context<'_, Self>) -> Vec<CommandCompletion> {
        let input = self.command_input_text(cx);
        let line = input.trim_start();

        if let Some(prefix) = line.strip_prefix('/') {
            let trimmed = prefix.trim();
            if trimmed.is_empty() {
                return vec![CommandCompletion {
                    replacement: "/error".to_string(),
                }];
            }
            return vec![CommandCompletion {
                replacement: format!("/{}", trimmed),
            }];
        }

        let Some(rest) = line.strip_prefix(':') else {
            return Vec::new();
        };

        let state = app_state(cx);
        let rest = rest.trim_start();
        if rest.is_empty() {
            return Self::command_catalog()
                .iter()
                .take(8)
                .map(|(cmd, _detail)| CommandCompletion {
                    replacement: format!(":{}", Self::completion_command(cmd)),
                })
                .collect();
        }

        let mut parts = rest.split_whitespace();
        let command = parts.next().unwrap_or_default().to_ascii_lowercase();
        let args: Vec<&str> = parts.collect();
        let ends_with_space = rest.ends_with(' ');

        if args.is_empty() && !ends_with_space {
            return Self::command_catalog()
                .iter()
                .filter(|(cmd, _)| {
                    cmd.starts_with(&command) || Self::completion_command(cmd).starts_with(&command)
                })
                .take(8)
                .map(|(cmd, _detail)| CommandCompletion {
                    replacement: format!(":{}", Self::completion_command(cmd)),
                })
                .collect();
        }

        let current_arg = if ends_with_space {
            ""
        } else {
            args.last().copied().unwrap_or("")
        };

        match command.as_str() {
            "ctx" | "context" | "contexts" => state
                .contexts
                .iter()
                .filter(|ctx_name| ctx_name.starts_with(current_arg))
                .take(8)
                .map(|ctx_name| CommandCompletion {
                    replacement: format!(":context {ctx_name}"),
                })
                .collect(),
            "ns" | "namespace" => state
                .namespaces
                .iter()
                .filter(|ns| ns.starts_with(current_arg))
                .take(8)
                .map(|ns| CommandCompletion {
                    replacement: format!(":namespace {ns}"),
                })
                .collect(),
            cmd => {
                if Self::resource_type_from_alias(cmd).is_none() {
                    return Vec::new();
                }

                if current_arg.starts_with('@') {
                    let ctx_prefix = current_arg.trim_start_matches('@');
                    let completion_cmd = Self::completion_command(cmd);
                    return state
                        .contexts
                        .iter()
                        .filter(|ctx_name| ctx_name.starts_with(ctx_prefix))
                        .take(8)
                        .map(|ctx_name| CommandCompletion {
                            replacement: format!(":{completion_cmd} @{ctx_name}"),
                        })
                        .collect();
                }

                if current_arg.starts_with('/') {
                    let f = current_arg.trim_start_matches('/');
                    let completion_cmd = Self::completion_command(cmd);
                    return vec![CommandCompletion {
                        replacement: format!(":{completion_cmd} /{f}"),
                    }];
                }

                let completion_cmd = Self::completion_command(cmd);
                state
                    .namespaces
                    .iter()
                    .filter(|ns| ns.starts_with(current_arg))
                    .take(8)
                    .map(|ns| CommandCompletion {
                        replacement: format!(":{completion_cmd} {ns}"),
                    })
                    .collect()
            }
        }
    }

    pub(super) fn handle_command_bar_keydown(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.command_bar_open {
            return;
        }

        let key = event.keystroke.key.as_str();
        let key_char = event.keystroke.key_char.as_deref().unwrap_or("");
        if key == "tab" || key == "iso_left_tab" || key_char == "\t" {
            self.handle_command_bar_tab(window, cx);
            return;
        }

        if key == "enter" || key == "escape" {
            self.command_bar_hint = None;
            return;
        }

        if event.keystroke.modifiers.control
            || event.keystroke.modifiers.alt
            || event.keystroke.modifiers.platform
        {
            return;
        }

        if key == "backspace" {
            let mut text = self.command_input_text(cx);
            text.pop();
            self.set_command_input_value(text, window, cx);
            self.command_bar_hint = None;
            return;
        }

        if let Some(ch) = event.keystroke.key_char.as_ref() {
            if !ch.is_empty() {
                let mut text = self.command_input_text(cx);
                text.push_str(ch);
                self.set_command_input_value(text, window, cx);
                self.command_bar_hint = None;
            }
        }
    }

    pub(super) fn handle_command_bar_tab(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.command_bar_open {
            return;
        }

        let text = self.command_input_text(cx);

        if let Some(hint) = self.command_bar_hint.as_ref() {
            if hint.starts_with(&text) && hint.len() > text.len() {
                self.set_command_input_value(hint.clone(), window, cx);
                self.command_bar_hint = None;
                cx.notify();
                return;
            }
        }

        if let Some(first) = self.command_completions(cx).first() {
            if first.replacement.starts_with(&text) && first.replacement.len() > text.len() {
                self.command_bar_hint = Some(first.replacement.clone());
                cx.notify();
            } else {
                self.set_command_input_value(first.replacement.clone(), window, cx);
            }
        }
    }

    fn execute_resource_command(
        &mut self,
        resource_type: k8s_client::ResourceType,
        args: &[&str],
        cx: &mut Context<'_, Self>,
    ) {
        let mut namespace_override: Option<String> = None;
        let mut context_override: Option<String> = None;
        let mut filter_override: Option<String> = None;

        for arg in args {
            if let Some(ctx_name) = arg.strip_prefix('@') {
                if !ctx_name.is_empty() {
                    context_override = Some(ctx_name.to_string());
                }
            } else if let Some(filter) = arg.strip_prefix('/') {
                filter_override = Some(filter.to_string());
            } else if !arg.is_empty() {
                namespace_override = Some((*arg).to_string());
            }
        }

        if let Some(ctx_name) = context_override {
            crate::switch_context(cx, ctx_name);
        }

        cx.update_global::<AppState, _>(|state, _| {
            state.set_selected_type(resource_type);
            state.active_view = ActiveView::ResourceTable;
            state.set_selected_resource(None);

            if let Some(filter) = &filter_override {
                state.set_filter(filter.clone());
            } else {
                state.set_filter(String::new());
            }

            if resource_type.is_namespaced() {
                if let Some(ns) = &namespace_override {
                    state.set_namespace(Some(ns.clone()));
                }
            } else {
                state.set_namespace(None);
            }
        });

        let namespace = if resource_type.is_namespaced() {
            namespace_override.or_else(|| cx.global::<AppState>().namespace.clone())
        } else {
            None
        };

        crate::load_resources(cx, resource_type, namespace);
        self.set_command_bar_state(false);
        cx.notify();
    }

    fn resource_type_from_alias(alias: &str) -> Option<k8s_client::ResourceType> {
        match alias {
            "po" | "pod" | "pods" => Some(k8s_client::ResourceType::Pods),
            "dp" | "deploy" | "deployment" | "deployments" => {
                Some(k8s_client::ResourceType::Deployments)
            }
            "svc" | "service" | "services" => Some(k8s_client::ResourceType::Services),
            "ing" | "ingress" | "ingresses" => Some(k8s_client::ResourceType::Ingresses),
            "cm" | "configmap" | "configmaps" => Some(k8s_client::ResourceType::ConfigMaps),
            "sec" | "secret" | "secrets" => Some(k8s_client::ResourceType::Secrets),
            "rs" | "replicaset" | "replicasets" => Some(k8s_client::ResourceType::ReplicaSets),
            "sts" | "statefulset" | "statefulsets" => Some(k8s_client::ResourceType::StatefulSets),
            "ds" | "daemonset" | "daemonsets" => Some(k8s_client::ResourceType::DaemonSets),
            "job" | "jobs" => Some(k8s_client::ResourceType::Jobs),
            "cj" | "cronjob" | "cronjobs" => Some(k8s_client::ResourceType::CronJobs),
            "no" | "node" | "nodes" => Some(k8s_client::ResourceType::Nodes),
            "namespaces" => Some(k8s_client::ResourceType::Namespaces),
            "hpa" => Some(k8s_client::ResourceType::HorizontalPodAutoscalers),
            "vpa" => Some(k8s_client::ResourceType::VerticalPodAutoscalers),
            _ => None,
        }
    }

    pub(super) fn render_command_bar(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let input = self.command_input_text(cx);
        let hint_suffix = self
            .command_bar_hint
            .as_ref()
            .and_then(|hint| hint.strip_prefix(&input))
            .unwrap_or("")
            .to_string();

        div()
            .w_full()
            .px(px(10.0))
            .py(px(6.0))
            .bg(colors.surface)
            .border_t_1()
            .border_color(colors.border)
            .font_family(theme.font_family_ui.clone())
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(0.0))
                    .text_size(px(15.0))
                    .child(div().text_color(colors.text).child(input))
                    .when(!hint_suffix.is_empty(), |el| {
                        el.child(
                            div()
                                .text_color(colors.text_muted)
                                .font_weight(FontWeight::BOLD)
                                .child(hint_suffix),
                        )
                    }),
            )
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(colors.text_muted)
                    .child("Tab suggest/accept  Enter run  Esc close"),
            )
            .when_some(self.command_bar_error.as_ref(), |el, message| {
                el.child(
                    div()
                        .text_size(px(11.0))
                        .text_color(colors.warning)
                        .child(message.clone()),
                )
            })
    }
}
