use gpui::*;
use gpui::prelude::FluentBuilder;
use ui::gpui_component::input::{Input, InputEvent, InputState};

// Pencil mockup colors for the editor theme
const EDITOR_TOOLBAR_BG: u32 = 0x0F172A;
const EDITOR_BORDER: u32 = 0x334155;
const EDITOR_ACCENT: u32 = 0x22D3EE;
const EDITOR_TEXT_SECONDARY: u32 = 0x94A3B8;

actions!(yaml_editor, [Save]);

pub struct YamlEditor {
    input_state: Option<Entity<InputState>>,
    _input_subscription: Option<Subscription>,
    content: String,
    read_only: bool,
    on_save: Option<Box<dyn Fn(&str, &mut Context<'_, Self>)>>,
}

impl YamlEditor {
    pub fn new(content: String) -> Self {
        Self {
            input_state: None,
            _input_subscription: None,
            content,
            read_only: false,
            on_save: None,
        }
    }

    pub fn read_only(mut self, read_only: bool) -> Self {
        self.read_only = read_only;
        self
    }

    pub fn on_save(mut self, handler: impl Fn(&str, &mut Context<'_, Self>) + 'static) -> Self {
        self.on_save = Some(Box::new(handler));
        self
    }

    /// Get a reference to the underlying InputState entity for reading content externally.
    pub fn input_entity(&self) -> Option<&Entity<InputState>> {
        self.input_state.as_ref()
    }

    pub fn get_content(&self, cx: &Context<'_, Self>) -> String {
        self.input_state
            .as_ref()
            .map(|i| i.read(cx).text().to_string())
            .unwrap_or_else(|| self.content.clone())
    }

    /// Lazy-initialize the InputState as a code editor with YAML mode.
    fn ensure_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.input_state.is_some() {
            return;
        }

        let content = self.content.clone();
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .code_editor("yaml")
                .line_number(true)
                .default_value(content)
        });

        let sub = cx.subscribe(&input, |_this, _input, ev: &InputEvent, _cx| {
            if let InputEvent::Change = ev {}
        });

        self.input_state = Some(input);
        self._input_subscription = Some(sub);
    }
}

impl Render for YamlEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.ensure_input(window, cx);

        let editor = self.input_state.as_ref().map(|state| {
            Input::new(state)
                .h_full()
                .disabled(self.read_only)
        });

        div()
            .key_context("YamlEditor")
            .on_action(cx.listener(|this, _action: &Save, _window, cx| {
                if let Some(on_save) = &this.on_save {
                    let content = this
                        .input_state
                        .as_ref()
                        .map(|i| i.read(cx).text().to_string())
                        .unwrap_or_default();
                    on_save(&content, cx);
                }
            }))
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            // ── Editor toolbar ──
            .child(
                div()
                    .w_full()
                    .h(px(48.0))
                    .flex_shrink_0()
                    .px(px(20.0))
                    .flex()
                    .items_center()
                    .bg(rgb(EDITOR_TOOLBAR_BG))
                    .border_b_1()
                    .border_color(rgb(EDITOR_BORDER))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(24.0))
                            // YAML badge
                            .child(
                                div()
                                    .px(px(10.0))
                                    .py(px(4.0))
                                    .rounded(px(100.0))
                                    .bg(rgb(EDITOR_TOOLBAR_BG))
                                    .border_1()
                                    .border_color(rgb(EDITOR_BORDER))
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(div().size(px(6.0)).rounded_full().bg(rgb(EDITOR_ACCENT)))
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(rgb(EDITOR_TEXT_SECONDARY))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child("YAML")
                                    )
                            )
                    )
            )
            // ── Code editor ──
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .when_some(editor, |el: Div, editor| el.child(editor))
            )
    }
}
