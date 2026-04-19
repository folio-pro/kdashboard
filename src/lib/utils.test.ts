import { describe, expect, test } from "bun:test";
import { cn, kindToResourceType, escapeHtml } from "./utils";

describe("cn", () => {
  test("merges truthy classes and removes conflicts", () => {
    const merged = cn("px-2", "font-bold", false && "hidden", "px-4");
    expect(merged).toContain("font-bold");
    expect(merged).toContain("px-4");
    expect(merged).not.toContain("px-2");
  });
});

describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes angle brackets", () => {
    expect(escapeHtml("<div>hello</div>")).toBe("&lt;div&gt;hello&lt;/div&gt;");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('class="foo"')).toBe("class=&quot;foo&quot;");
  });

  test("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#039;s");
  });

  test("escapes all special characters together", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;"
    );
  });

  test("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("returns safe string unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("kindToResourceType", () => {
  test("maps known kubernetes kinds", () => {
    expect(kindToResourceType("Deployment")).toBe("deployments");
    expect(kindToResourceType("Pod")).toBe("pods");
  });

  test("falls back to lowercase plural for unknown kinds", () => {
    expect(kindToResourceType("FooBar")).toBe("foobars");
  });
});
