// JSON syntax highlighting for log lines — pure TS, no Svelte imports.

import { escapeHtml } from "$lib/utils";
import type { LogLine } from "./log-viewer";

/**
 * Apply syntax highlighting to a JSON string.
 * Returns an HTML string with spans for keys, strings, numbers, booleans, and null.
 */
export function highlightJson(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")\s*(:)|("(?:\\.|[^"\\])*")|((?:-?\d+\.?\d*(?:[eE][+-]?\d+)?))|(\btrue\b|\bfalse\b)|(\bnull\b)/g,
    (match, key, colon, str, num, bool, nil) => {
      if (key && colon) {
        return `<span class="log-json-key">${escapeHtml(key)}</span>${colon}`;
      }
      if (str) return `<span class="log-json-string">${escapeHtml(str)}</span>`;
      if (num) return `<span class="log-json-number">${match}</span>`;
      if (bool) return `<span class="log-json-bool">${match}</span>`;
      if (nil) return `<span class="log-json-null">${match}</span>`;
      return match;
    },
  );
}

/**
 * Lazily compute and cache JSON highlighting for a log line.
 * Returns an HTML string ready for {@html ...} rendering.
 */
export function getJsonHighlighted(line: LogLine): string {
  if (line._jsonHighlightedCache) return line._jsonHighlightedCache;
  if (!line.isJson || !line.jsonFormatted) return "";
  const trimmed = line.message.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonArrayStart = trimmed.indexOf("[");
  const start =
    jsonStart === -1
      ? jsonArrayStart
      : jsonArrayStart === -1
        ? jsonStart
        : Math.min(jsonStart, jsonArrayStart);
  const prefix = start > 0 ? trimmed.slice(0, start).trim() : "";
  const prefixHtml = prefix
    ? `<span class="text-[var(--text-muted)]">${escapeHtml(prefix)}</span>\n`
    : "";
  // jsonFormatted already has the prefix line, strip it to get pure JSON
  const jsonPart = prefix ? line.jsonFormatted.slice(prefix.length + 1) : line.jsonFormatted;
  line._jsonHighlightedCache = prefixHtml + highlightJson(jsonPart);
  return line._jsonHighlightedCache;
}
