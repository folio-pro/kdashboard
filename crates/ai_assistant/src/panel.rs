use gpui::*;
use ui::{Sizable, theme};

#[derive(Clone)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
}

pub struct AIPanelView {
    messages: Vec<ChatMessage>,
    input: String,
    is_loading: bool,
    streaming_content: String,
}

impl AIPanelView {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            input: String::new(),
            is_loading: false,
            streaming_content: String::new(),
        }
    }

    pub fn add_message(&mut self, message: ChatMessage) {
        self.messages.push(message);
    }

    pub fn set_input(&mut self, input: String) {
        self.input = input;
    }

    pub fn set_loading(&mut self, loading: bool) {
        self.is_loading = loading;
    }

    pub fn append_streaming(&mut self, content: &str) {
        self.streaming_content.push_str(content);
    }

    pub fn finish_streaming(&mut self) {
        if !self.streaming_content.is_empty() {
            self.messages.push(ChatMessage {
                role: MessageRole::Assistant,
                content: std::mem::take(&mut self.streaming_content),
            });
        }
    }

    pub fn clear(&mut self) {
        self.messages.clear();
        self.input.clear();
        self.streaming_content.clear();
    }
}

impl Default for AIPanelView {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for AIPanelView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let _colors = &theme.colors;

        let messages: Vec<_> = self.messages.iter().cloned().collect();
        let streaming = self.streaming_content.clone();
        let is_loading = self.is_loading;
        let input = self.input.clone();

        div()
            .size_full()
            .flex()
            .flex_col()
            // Messages area
            .child(self.render_messages_area(cx, messages, streaming, is_loading))
            // Input area
            .child(self.render_input_area(cx, input))
    }
}

impl AIPanelView {
    fn render_messages_area(
        &self,
        cx: &Context<'_, Self>,
        messages: Vec<ChatMessage>,
        streaming: String,
        is_loading: bool,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let _colors = &theme.colors;

        let mut area = div()
            .flex_1()
            .overflow_hidden()
            .p(px(12.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .children(messages.iter().map(|msg| self.render_message(cx, msg)));

        // Streaming content
        if !streaming.is_empty() {
            area = area.child(self.render_streaming_message(cx, &streaming));
        }

        // Loading indicator
        if is_loading && streaming.is_empty() {
            area = area.child(self.render_loading(cx));
        }

        area
    }

    fn render_message(&self, cx: &Context<'_, Self>, message: &ChatMessage) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let (bg, justify_end) = match message.role {
            MessageRole::User => (colors.primary.opacity(0.2), true),
            MessageRole::Assistant => (colors.surface_elevated, false),
        };

        let row = div().w_full().flex();

        let row = if justify_end {
            row.justify_end()
        } else {
            row.justify_start()
        };

        row.child(
            div()
                .max_w(px(300.0))
                .p(px(12.0))
                .rounded(theme.border_radius)
                .bg(bg)
                .text_size(theme.font_size)
                .text_color(colors.text)
                .child(message.content.clone()),
        )
    }

    fn render_streaming_message(&self, cx: &Context<'_, Self>, content: &str) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div().w_full().flex().justify_start().child(
            div()
                .max_w(px(300.0))
                .p(px(12.0))
                .rounded(theme.border_radius)
                .bg(colors.surface_elevated)
                .text_size(theme.font_size)
                .text_color(colors.text)
                .child(content.to_string()),
        )
    }

    fn render_loading(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div().w_full().flex().justify_start().child(
            div()
                .p(px(12.0))
                .rounded(theme.border_radius)
                .bg(colors.surface_elevated)
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(ui::Spinner::new().with_size(ui::Size::XSmall))
                .child(
                    div()
                        .text_size(theme.font_size_small)
                        .text_color(colors.text_muted)
                        .child("Thinking..."),
                ),
        )
    }

    fn render_input_area(&self, cx: &Context<'_, Self>, input: String) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let (text_color, display_text) = if input.is_empty() {
            (
                colors.text_muted,
                "Ask about your Kubernetes resources...".to_string(),
            )
        } else {
            (colors.text, input)
        };

        div()
            .w_full()
            .p(px(12.0))
            .border_t_1()
            .border_color(colors.border)
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .flex_1()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(theme.border_radius)
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.surface)
                    .text_size(theme.font_size)
                    .text_color(text_color)
                    .child(display_text),
            )
            .child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(theme.border_radius)
                    .bg(colors.primary)
                    .text_size(theme.font_size)
                    .text_color(colors.text)
                    .cursor_pointer()
                    .hover(|style| style.bg(colors.primary_hover))
                    .child("Send"),
            )
    }
}
