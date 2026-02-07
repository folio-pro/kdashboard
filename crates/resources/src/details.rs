use gpui::*;
use k8s_client::Resource;
use ui::theme;

pub struct ResourceDetails {
    resource: Option<Resource>,
}

impl ResourceDetails {
    pub fn new(resource: Option<Resource>) -> Self {
        Self { resource }
    }

    pub fn set_resource(&mut self, resource: Option<Resource>) {
        self.resource = resource;
    }
}

impl Render for ResourceDetails {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let mut container = div().size_full();

        if let Some(resource) = self.resource.clone() {
            let name = resource.metadata.name.clone();
            let kind = resource.kind.clone();
            let api_version = resource.api_version.clone();
            let namespace = resource.metadata.namespace.clone().unwrap_or_else(|| "-".to_string());
            let uid = resource.metadata.uid.clone();
            let created = resource.metadata.creation_timestamp.clone().unwrap_or_else(|| "-".to_string());

            let labels: Vec<(String, String)> = resource.metadata.labels
                .as_ref()
                .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();

            container = container
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(16.0))
                // Header
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            div()
                                .text_size(theme.font_size_large)
                                .text_color(colors.text)
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(name),
                        )
                        .child(
                            div()
                                .text_size(theme.font_size_small)
                                .text_color(colors.text_secondary)
                                .child(format!("{} / {}", kind, api_version)),
                        ),
                )
                // Metadata section
                .child(self.render_metadata(cx, namespace, uid, created))
                // Labels section
                .child(self.render_labels(cx, labels));
        } else {
            container = container
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(theme.font_size)
                        .text_color(colors.text_muted)
                        .child("Select a resource to view details"),
                );
        }

        container
    }
}

impl ResourceDetails {
    fn render_metadata(
        &self,
        cx: &Context<'_, Self>,
        namespace: String,
        uid: String,
        created: String,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(theme.font_size)
                    .text_color(colors.text)
                    .font_weight(FontWeight::MEDIUM)
                    .child("Metadata"),
            )
            .child(
                div()
                    .p(px(12.0))
                    .rounded(theme.border_radius)
                    .bg(colors.surface_elevated)
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(self.render_row(cx, "Namespace", namespace))
                    .child(self.render_row(cx, "UID", uid))
                    .child(self.render_row(cx, "Created", created)),
            )
    }

    fn render_labels(&self, cx: &Context<'_, Self>, labels: Vec<(String, String)>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let label_elements: Vec<Div> = labels
            .iter()
            .map(|(k, v)| {
                div()
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(4.0))
                    .bg(colors.secondary)
                    .text_size(theme.font_size_small)
                    .text_color(colors.text)
                    .child(format!("{}={}", k, v))
            })
            .collect();

        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(theme.font_size)
                    .text_color(colors.text)
                    .font_weight(FontWeight::MEDIUM)
                    .child("Labels"),
            )
            .child(
                div()
                    .p(px(12.0))
                    .rounded(theme.border_radius)
                    .bg(colors.surface_elevated)
                    .flex()
                    .flex_wrap()
                    .gap(px(8.0))
                    .children(label_elements),
            )
    }

    fn render_row(&self, cx: &Context<'_, Self>, label: &'static str, value: String) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .w(px(100.0))
                    .text_size(theme.font_size_small)
                    .text_color(colors.text_muted)
                    .child(label),
            )
            .child(
                div()
                    .flex_1()
                    .text_size(theme.font_size_small)
                    .text_color(colors.text)
                    .child(value),
            )
    }
}
