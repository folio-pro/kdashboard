import { describe, expect, test } from "bun:test";
import {
  CONTEXT_ICONS,
  getIconById,
  getIconUrl,
  iconsByCategory,
} from "./context-icons";

describe("CONTEXT_ICONS", () => {
  test("has entries in all categories", () => {
    const categories = new Set(CONTEXT_ICONS.map((icon) => icon.category));
    expect(categories.has("cloud")).toBe(true);
    expect(categories.has("infra")).toBe(true);
    expect(categories.has("env")).toBe(true);
    expect(categories.has("generic")).toBe(true);
  });
});

describe("getIconById", () => {
  test("returns correct icon for known ID", () => {
    const icon = getIconById("kubernetes");
    expect(icon).toBeDefined();
    expect(icon!.id).toBe("kubernetes");
    expect(icon!.label).toBe("Kubernetes");
    expect(icon!.category).toBe("infra");
  });

  test("returns undefined for unknown ID", () => {
    expect(getIconById("nonexistent-icon")).toBeUndefined();
  });
});

describe("getIconUrl", () => {
  test("builds correct URL with default 'original' variant", () => {
    const url = getIconUrl("github");
    expect(url).toBe(
      "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/github/github-original.svg",
    );
  });

  test("uses variant override when available", () => {
    const url = getIconUrl("kubernetes");
    expect(url).toBe(
      "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/kubernetes/kubernetes-plain.svg",
    );
  });
});

describe("iconsByCategory", () => {
  test("groups icons correctly", () => {
    expect(Object.keys(iconsByCategory)).toEqual(
      expect.arrayContaining(["cloud", "infra", "env", "generic"]),
    );

    for (const icon of iconsByCategory.cloud) {
      expect(icon.category).toBe("cloud");
    }
    for (const icon of iconsByCategory.infra) {
      expect(icon.category).toBe("infra");
    }

    const totalGrouped = Object.values(iconsByCategory).reduce(
      (sum, icons) => sum + icons.length,
      0,
    );
    expect(totalGrouped).toBe(CONTEXT_ICONS.length);
  });
});
