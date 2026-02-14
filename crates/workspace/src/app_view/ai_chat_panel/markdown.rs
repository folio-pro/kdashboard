use super::AppView;
use gpui::*;
use ui::theme;

pub(super) fn normalize_ai_template_response(input: &str) -> String {
    let labels = [
        "Summary",
        "Findings",
        "Likely root cause",
        "Automatic checks performed",
        "Recommended next action",
        "Optional deeper checks",
    ];

    let mut out = input.to_string();

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

        if let Some(text) = trimmed.strip_prefix("> ") {
            flush_paragraph(&mut paragraph_lines, &mut blocks);
            blocks.push((
                MdBlockKind::Quote,
                parse_inline_markdown_to_plain(text.trim()),
            ));
            continue;
        }

        if (trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ "))
            && let Some(text) = trimmed.get(2..)
        {
            flush_paragraph(&mut paragraph_lines, &mut blocks);
            blocks.push((
                MdBlockKind::ListItem,
                parse_inline_markdown_to_plain(text.trim()),
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

pub(super) fn render_markdown_message(
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
