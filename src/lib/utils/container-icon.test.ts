import { describe, expect, test } from "bun:test";
import { getContainerIconUrl } from "./container-icon";

describe("getContainerIconUrl", () => {
  test("returns null for empty input", () => {
    expect(getContainerIconUrl("")).toBeNull();
  });

  test("maps known images directly", () => {
    expect(getContainerIconUrl("nginx:1.25")).toBe(
      "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nginx/nginx-original.svg",
    );
  });

  test("extracts image name from registry path and tags", () => {
    expect(getContainerIconUrl("docker.io/library/postgres:15")).toBe(
      "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/postgresql/postgresql-plain.svg",
    );
  });

  test("handles digests", () => {
    expect(getContainerIconUrl("redis@sha256:abc123")).toBe(
      "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/redis/redis-plain.svg",
    );
  });

  test("falls back to partial match for composite names", () => {
    expect(getContainerIconUrl("my-react-app:v1")).toBe(
      "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/react/react-original.svg",
    );
  });

  test("returns null when image has no known mapping", () => {
    expect(getContainerIconUrl("internal-custom-image:latest")).toBeNull();
  });

  test("returns cached values consistently", () => {
    const first = getContainerIconUrl("python:3.12");
    const second = getContainerIconUrl("python:latest");
    expect(first).toBe(second);
  });
});
