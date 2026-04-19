import { parse as parseYaml } from "yaml";

export interface ParsedValue {
  type: "json" | "yaml" | "text";
  formatted: string;
}

export function detectAndFormat(value: string): ParsedValue {
  if (!value) return { type: "text", formatted: value };

  const trimmed = value.trimStart();

  // JSON detection: starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return {
        type: "json",
        formatted: JSON.stringify(parsed, null, 2),
      };
    } catch {
      // Not valid JSON, continue to YAML check
    }
  }

  // YAML detection: multi-line content with key-value-like structure
  if (value.includes("\n")) {
    try {
      const parsed = parseYaml(value);
      // Only treat as YAML if it parsed into an object or array (not a plain scalar)
      if (parsed !== null && typeof parsed === "object") {
        return {
          type: "yaml",
          formatted: JSON.stringify(parsed, null, 2),
        };
      }
    } catch {
      // Not valid YAML
    }
  }

  return { type: "text", formatted: value };
}
