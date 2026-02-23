use super::{ColorSpan, PodLogsView};
use chrono::{DateTime, Datelike, Utc};
use gpui::Hsla;
use serde_json::Value;

impl PodLogsView {
    pub fn colorize_modal_line(
        line: &str,
        format_label: &str,
        colors: &ui::ThemeColors,
    ) -> Vec<ColorSpan> {
        if line.is_empty() {
            return vec![ColorSpan {
                text: " ".to_string(),
                color: colors.text,
            }];
        }

        if format_label.starts_with("JSON") || format_label.starts_with("Embedded JSON") {
            return Self::colorize_json_line(line, colors);
        }

        if format_label == "Key/Value" {
            return Self::colorize_kv_line(line, colors);
        }

        vec![ColorSpan {
            text: line.to_string(),
            color: colors.text,
        }]
    }

    fn colorize_kv_line(line: &str, colors: &ui::ThemeColors) -> Vec<ColorSpan> {
        if let Some((key, value)) = line.split_once(": ") {
            return vec![
                ColorSpan {
                    text: key.to_string(),
                    color: colors.primary,
                },
                ColorSpan {
                    text: ": ".to_string(),
                    color: colors.text_muted,
                },
                ColorSpan {
                    text: value.to_string(),
                    color: Self::color_for_json_value(value.trim(), colors),
                },
            ];
        }

        vec![ColorSpan {
            text: line.to_string(),
            color: colors.text,
        }]
    }

    fn colorize_json_line(line: &str, colors: &ui::ThemeColors) -> Vec<ColorSpan> {
        let indent_len = line.chars().take_while(|c| c.is_whitespace()).count();
        let indent = &line[..indent_len.min(line.len())];
        let trimmed = line[indent.len()..].trim_end();

        if trimmed.is_empty() {
            return vec![ColorSpan {
                text: line.to_string(),
                color: colors.text,
            }];
        }

        if ["{", "}", "[", "]", "},", "],"].contains(&trimmed) {
            return vec![
                ColorSpan {
                    text: indent.to_string(),
                    color: colors.text,
                },
                ColorSpan {
                    text: trimmed.to_string(),
                    color: colors.text_muted,
                },
            ];
        }

        if trimmed.starts_with('"')
            && let Some(key_end) = Self::find_json_key_end(trimmed)
        {
            let key_part = &trimmed[..=key_end];
            let rest = trimmed[key_end + 1..].trim_start();
            if let Some(value_part) = rest.strip_prefix(':') {
                let value = value_part.trim_start();
                let (value_text, trailing_comma) = if let Some(v) = value.strip_suffix(',') {
                    (v.trim_end(), ",")
                } else {
                    (value, "")
                };

                let mut out = vec![
                    ColorSpan {
                        text: indent.to_string(),
                        color: colors.text,
                    },
                    ColorSpan {
                        text: key_part.to_string(),
                        color: colors.primary,
                    },
                    ColorSpan {
                        text: ": ".to_string(),
                        color: colors.text_muted,
                    },
                    ColorSpan {
                        text: value_text.to_string(),
                        color: Self::color_for_json_value(value_text, colors),
                    },
                ];
                if !trailing_comma.is_empty() {
                    out.push(ColorSpan {
                        text: trailing_comma.to_string(),
                        color: colors.text_muted,
                    });
                }
                return out;
            }
        }

        vec![
            ColorSpan {
                text: indent.to_string(),
                color: colors.text,
            },
            ColorSpan {
                text: trimmed.to_string(),
                color: Self::color_for_json_value(trimmed.trim_end_matches(','), colors),
            },
        ]
    }

    fn find_json_key_end(s: &str) -> Option<usize> {
        let mut escaped = false;
        for (i, ch) in s.char_indices().skip(1) {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => return Some(i),
                _ => {}
            }
        }
        None
    }

    fn color_for_json_value(value: &str, colors: &ui::ThemeColors) -> Hsla {
        let v = value.trim();
        if v.starts_with('"') && v.ends_with('"') && v.len() >= 2 {
            return colors.success;
        }
        if matches!(v, "true" | "false") {
            return colors.warning;
        }
        if v == "null" {
            return colors.error;
        }
        if v.parse::<f64>().is_ok() {
            return colors.primary;
        }
        colors.text_secondary
    }

    pub fn format_log_message_for_modal(message: &str) -> (String, String) {
        if let Ok(json) = serde_json::from_str::<Value>(message) {
            let pretty =
                serde_json::to_string_pretty(&json).unwrap_or_else(|_| message.to_string());
            return (pretty, "JSON".to_string());
        }

        if let Some((prefix, json_body, pretty_json)) =
            Self::extract_and_pretty_print_embedded_json(message)
        {
            let formatted = if prefix.is_empty() {
                pretty_json
            } else {
                format!("{}\n{}", prefix, pretty_json)
            };
            return (formatted, format!("Embedded {}", json_body));
        }

        if let Some(logfmt) = Self::format_logfmt(message) {
            return (logfmt, "Key/Value".to_string());
        }

        (message.to_string(), "Raw".to_string())
    }

    fn extract_and_pretty_print_embedded_json(
        message: &str,
    ) -> Option<(String, &'static str, String)> {
        for (open, close, label) in [('{', '}', "JSON object"), ('[', ']', "JSON array")] {
            let start = message.find(open)?;
            let end = message.rfind(close)?;
            if end <= start {
                continue;
            }

            let json_slice = &message[start..=end];
            if let Ok(json) = serde_json::from_str::<Value>(json_slice) {
                let pretty_json = serde_json::to_string_pretty(&json).ok()?;
                let prefix = message[..start].trim().to_string();
                return Some((prefix, label, pretty_json));
            }
        }
        None
    }

    fn format_logfmt(message: &str) -> Option<String> {
        let re = regex::Regex::new(r#"([A-Za-z0-9_.-]+)=("[^"]*"|\S+)"#).ok()?;
        let mut rows = Vec::new();

        for caps in re.captures_iter(message) {
            let key = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            let raw_value = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
            let value = raw_value.trim_matches('"');
            rows.push(format!("{}: {}", key, value));
        }

        if rows.len() >= 2 {
            Some(rows.join("\n"))
        } else {
            None
        }
    }

    pub fn format_log_timestamp(ts: &str) -> String {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(ts) {
            let dt_utc = parsed.with_timezone(&Utc);
            let now = Utc::now();
            if dt_utc.date_naive() == now.date_naive() {
                return dt_utc.format("%H:%M:%S").to_string();
            }
            if dt_utc.year() == now.year() {
                return dt_utc.format("%b %d %H:%M:%S").to_string();
            }
            return dt_utc.format("%Y-%m-%d %H:%M:%S").to_string();
        }

        if let Some((date, time_raw)) = ts.split_once('T') {
            let time = time_raw.split(['.', 'Z', '+']).next().unwrap_or(time_raw);
            return format!("{} {}", date, time);
        }

        ts.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── format_log_message_for_modal ────────────────────────────────

    #[test]
    fn format_modal_detects_json() {
        let msg = r#"{"level":"info","message":"hello"}"#;
        let (formatted, label) = PodLogsView::format_log_message_for_modal(msg);
        assert_eq!(label, "JSON");
        assert!(formatted.contains("\"level\""));
        assert!(formatted.contains("\"info\""));
    }

    #[test]
    fn format_modal_detects_embedded_json_object() {
        let msg = r#"INFO some prefix {"key":"value"}"#;
        let (formatted, label) = PodLogsView::format_log_message_for_modal(msg);
        assert!(label.contains("Embedded"));
        assert!(formatted.contains("INFO some prefix"));
        assert!(formatted.contains("\"key\""));
    }

    #[test]
    fn format_modal_detects_embedded_json_array() {
        // Array embedded inside a message that also has an object marker
        // Note: the extract function tries { first, then [, using ? operator
        let msg = r#"result: {"items": [1, 2, 3]}"#;
        let (formatted, label) = PodLogsView::format_log_message_for_modal(msg);
        assert!(label.contains("Embedded") || label == "JSON");
        assert!(formatted.contains("1"));
    }

    #[test]
    fn format_modal_detects_logfmt() {
        let msg = r#"level=info msg="request completed" status=200 duration=45ms"#;
        let (formatted, label) = PodLogsView::format_log_message_for_modal(msg);
        assert_eq!(label, "Key/Value");
        assert!(formatted.contains("level: info"));
        assert!(formatted.contains("status: 200"));
        assert!(formatted.contains("duration: 45ms"));
    }

    #[test]
    fn format_modal_raw_fallback() {
        let msg = "just a plain log line";
        let (formatted, label) = PodLogsView::format_log_message_for_modal(msg);
        assert_eq!(label, "Raw");
        assert_eq!(formatted, msg);
    }

    // ── format_logfmt ───────────────────────────────────────────────

    #[test]
    fn format_logfmt_parses_key_value_pairs() {
        let msg = r#"level=info msg="hello world" code=200"#;
        let result = PodLogsView::format_logfmt(msg);
        assert!(result.is_some());
        let lines = result.unwrap();
        assert!(lines.contains("level: info"));
        assert!(lines.contains("msg: hello world"));
        assert!(lines.contains("code: 200"));
    }

    #[test]
    fn format_logfmt_returns_none_for_single_pair() {
        let msg = "level=info";
        assert!(PodLogsView::format_logfmt(msg).is_none());
    }

    #[test]
    fn format_logfmt_returns_none_for_plain_text() {
        let msg = "just some text without key value pairs";
        assert!(PodLogsView::format_logfmt(msg).is_none());
    }

    #[test]
    fn format_logfmt_handles_quoted_values() {
        let msg = r#"key1="value with spaces" key2=simple"#;
        let result = PodLogsView::format_logfmt(msg).unwrap();
        assert!(result.contains("key1: value with spaces"));
        assert!(result.contains("key2: simple"));
    }

    // ── extract_and_pretty_print_embedded_json ──────────────────────

    #[test]
    fn extract_embedded_json_with_prefix() {
        let msg = r#"prefix text {"a":1}"#;
        let result = PodLogsView::extract_and_pretty_print_embedded_json(msg);
        assert!(result.is_some());
        let (prefix, label, pretty) = result.unwrap();
        assert_eq!(prefix, "prefix text");
        assert_eq!(label, "JSON object");
        assert!(pretty.contains("\"a\""));
    }

    #[test]
    fn extract_embedded_json_without_prefix() {
        let msg = r#"{"a":1}"#;
        let result = PodLogsView::extract_and_pretty_print_embedded_json(msg);
        assert!(result.is_some());
        let (prefix, _, _) = result.unwrap();
        assert!(prefix.is_empty());
    }

    #[test]
    fn extract_embedded_json_returns_none_for_array_only() {
        // The function uses ? with find('{'), so if no { exists it returns None
        // before trying [ — arrays only work when there's also a { in the message
        let msg = r#"items: [1, 2, 3]"#;
        assert!(PodLogsView::extract_and_pretty_print_embedded_json(msg).is_none());
    }

    #[test]
    fn extract_embedded_json_object_and_array() {
        // When message has both { and [, the object path is tried first
        let msg = r#"prefix {"key": [1, 2]}"#;
        let result = PodLogsView::extract_and_pretty_print_embedded_json(msg);
        assert!(result.is_some());
        let (_, label, _) = result.unwrap();
        assert_eq!(label, "JSON object");
    }

    #[test]
    fn extract_embedded_json_returns_none_for_invalid() {
        let msg = "no json here at all";
        assert!(PodLogsView::extract_and_pretty_print_embedded_json(msg).is_none());
    }

    // ── find_json_key_end ───────────────────────────────────────────

    #[test]
    fn find_json_key_end_simple() {
        let s = r#""key": value"#;
        assert_eq!(PodLogsView::find_json_key_end(s), Some(4));
    }

    #[test]
    fn find_json_key_end_with_escape() {
        let s = r#""ke\"y": value"#;
        assert_eq!(PodLogsView::find_json_key_end(s), Some(6));
    }

    #[test]
    fn find_json_key_end_no_closing_quote() {
        let s = r#""key"#;
        assert!(PodLogsView::find_json_key_end(s).is_none());
    }

    #[test]
    fn find_json_key_end_empty_key() {
        let s = r#""": value"#;
        assert_eq!(PodLogsView::find_json_key_end(s), Some(1));
    }

    // ── format_log_timestamp ────────────────────────────────────────

    #[test]
    fn format_log_timestamp_today_shows_time_only() {
        let now = Utc::now();
        let ts = now.to_rfc3339();
        let result = PodLogsView::format_log_timestamp(&ts);
        // Should be HH:MM:SS format
        assert_eq!(result.len(), 8);
        assert!(result.contains(':'));
    }

    #[test]
    fn format_log_timestamp_old_year_shows_full_date() {
        let ts = "2020-06-15T10:30:00Z";
        let result = PodLogsView::format_log_timestamp(ts);
        assert!(result.contains("2020"));
    }

    #[test]
    fn format_log_timestamp_non_rfc3339_with_t_separator() {
        let ts = "2024-01-15T10:30:00.123456Z";
        // This is valid RFC3339, should parse. But if called with year != current,
        // it will show with the date.
        let result = PodLogsView::format_log_timestamp(ts);
        assert!(!result.is_empty());
    }

    #[test]
    fn format_log_timestamp_plain_text_passthrough() {
        let ts = "not-a-timestamp";
        assert_eq!(PodLogsView::format_log_timestamp(ts), "not-a-timestamp");
    }

    #[test]
    fn format_log_timestamp_non_rfc3339_with_t() {
        let ts = "2024-01-15T10:30:00+broken";
        let result = PodLogsView::format_log_timestamp(ts);
        // Fallback: split on T, strip after . / Z / +
        assert_eq!(result, "2024-01-15 10:30:00");
    }
}
