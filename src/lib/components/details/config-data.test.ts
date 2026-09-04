import { describe, expect, test } from "bun:test";
import {
  base64ByteLength,
  decodeSecretValue,
  dockerRegistries,
  formatBytes,
  secretTypeLabel,
  summarizeValue,
  tlsSummary,
} from "./config-data.logic";

// btoa over the UTF-8 bytes — no Node Buffer, so svelte-check (DOM lib only)
// type-checks this file too.
const utf8 = (s: string) => new TextEncoder().encode(s);
const bytesB64 = (bytes: ArrayLike<number>) => btoa(String.fromCharCode(...Array.from(bytes)));
const b64 = (s: string) => bytesB64(utf8(s));

describe("base64ByteLength", () => {
  test("accounts for padding", () => {
    expect(base64ByteLength(b64("a"))).toBe(1);
    expect(base64ByteLength(b64("ab"))).toBe(2);
    expect(base64ByteLength(b64("abc"))).toBe(3);
    expect(base64ByteLength(b64("abcd"))).toBe(4);
  });

  test("empty input is zero bytes", () => {
    expect(base64ByteLength("")).toBe(0);
  });

  test("ignores whitespace line breaks in the payload", () => {
    expect(base64ByteLength("YWJj\nZGVm")).toBe(6);
  });
});

describe("decodeSecretValue", () => {
  test("decodes UTF-8 text", () => {
    const d = decodeSecretValue(b64("héllo wörld"));
    expect(d.binary).toBe(false);
    expect(d.text).toBe("héllo wörld");
    expect(d.bytes).toBe(utf8("héllo wörld").length);
  });

  test("flags invalid UTF-8 as binary and reports its size", () => {
    const d = decodeSecretValue(bytesB64([0xff, 0xfe, 0x00, 0x01]));
    expect(d.binary).toBe(true);
    expect(d.bytes).toBe(4);
    expect(d.text).toBe("");
  });

  test("flags text containing NUL as binary (PKCS#12, keystores)", () => {
    const d = decodeSecretValue(bytesB64([0x50, 0x4b, 0x00, 0x00, 0x64, 0x61, 0x74, 0x61]));
    expect(d.binary).toBe(true);
  });

  test("returns un-encoded input verbatim (stringData-only projection)", () => {
    const d = decodeSecretValue("not base64!!");
    expect(d.binary).toBe(false);
    expect(d.text).toBe("not base64!!");
  });

  test("empty value decodes to empty text", () => {
    expect(decodeSecretValue("")).toEqual({ text: "", bytes: 0, binary: false });
  });
});

describe("formatBytes", () => {
  test("picks a unit", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  });
});

describe("secretTypeLabel", () => {
  test("names the well-known types and passes others through", () => {
    expect(secretTypeLabel(undefined)).toBe("Opaque");
    expect(secretTypeLabel("kubernetes.io/tls")).toBe("TLS certificate");
    expect(secretTypeLabel("example.com/custom")).toBe("example.com/custom");
  });
});

describe("tlsSummary", () => {
  test("reports which conventional keys are present", () => {
    expect(tlsSummary({ "tls.crt": b64("CERT"), "tls.key": b64("KEY") })).toEqual({
      hasCert: true,
      hasKey: true,
      hasCa: false,
    });
    expect(tlsSummary({ "tls.crt": b64("CERT"), "ca.crt": b64("CA") })).toEqual({
      hasCert: true,
      hasKey: false,
      hasCa: true,
    });
    expect(tlsSummary(undefined)).toEqual({ hasCert: false, hasKey: false, hasCa: false });
  });

  test("an empty string does not count as present", () => {
    expect(tlsSummary({ "tls.crt": "", "tls.key": b64("k") }).hasCert).toBe(false);
  });
});

describe("dockerRegistries", () => {
  test("lists registries and usernames from a dockerconfigjson Secret", () => {
    const cfg = {
      auths: {
        "ghcr.io": { username: "nico", password: "hunter2", auth: b64("nico:hunter2") },
        "https://index.docker.io/v1/": { auth: b64("bob:pw") },
        "registry.internal": {},
      },
    };
    const out = dockerRegistries("kubernetes.io/dockerconfigjson", { ".dockerconfigjson": b64(JSON.stringify(cfg)) });
    expect(out).toEqual([
      { registry: "ghcr.io", username: "nico" },
      { registry: "https://index.docker.io/v1/", username: "bob" },
      { registry: "registry.internal" },
    ]);
    // Passwords never leave the helper.
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  test("reads the legacy dockercfg layout (no auths wrapper)", () => {
    const cfg = { "quay.io": { username: "svc", password: "x" } };
    expect(dockerRegistries("kubernetes.io/dockercfg", { ".dockercfg": b64(JSON.stringify(cfg)) })).toEqual([
      { registry: "quay.io", username: "svc" },
    ]);
  });

  test("unparseable or missing payloads yield an empty list", () => {
    expect(dockerRegistries("kubernetes.io/dockerconfigjson", {})).toEqual([]);
    expect(dockerRegistries("kubernetes.io/dockerconfigjson", { ".dockerconfigjson": b64("{not json") })).toEqual([]);
    expect(dockerRegistries("kubernetes.io/dockerconfigjson", { ".dockerconfigjson": b64("[]") })).toEqual([]);
  });
});

describe("summarizeValue", () => {
  test("a short single-line value is inline", () => {
    expect(summarizeValue("production")).toEqual({ lines: 1, chars: 10, block: false, long: false });
  });

  test("a multi-line value is a block, collapsed only when long", () => {
    const short = summarizeValue("a=1\nb=2");
    expect(short.block).toBe(true);
    expect(short.long).toBe(false);
    const long = summarizeValue(Array.from({ length: 30 }, (_, i) => `k${i}=v`).join("\n"));
    expect(long.lines).toBe(30);
    expect(long.block).toBe(true);
    expect(long.long).toBe(true);
  });

  test("a wide single-line value becomes a block; a huge one starts collapsed", () => {
    expect(summarizeValue("x".repeat(100)).block).toBe(true);
    expect(summarizeValue("x".repeat(100)).long).toBe(false);
    expect(summarizeValue("x".repeat(5000)).long).toBe(true);
  });

  test("an empty value has zero lines", () => {
    expect(summarizeValue("").lines).toBe(0);
  });
});
