import type { Resource } from "$lib/types";

export type ContainerState = "running" | "waiting" | "error" | "terminated";

interface ContainerStatus {
  name: string;
  ready: boolean;
  state?: Record<string, unknown>;
}

/**
 * One entry per container, in spec order. Waiting on a crash or image error is
 * an error; any other wait, or running without being ready, is waiting; exiting
 * 0 is terminated, which reads as finished rather than broken.
 */
export function containerStates(resource: Resource): { name: string; state: ContainerState }[] {
  const statuses = resource.status?.containerStatuses as ContainerStatus[] | undefined;
  if (!statuses) return [];
  return statuses.map((c) => {
    let state: ContainerState = "running";
    if (c.state?.waiting) {
      const reason = (c.state.waiting as { reason?: string }).reason ?? "";
      state = /error|crash|backoff/i.test(reason) ? "error" : "waiting";
    } else if (c.state?.terminated) {
      const exitCode = (c.state.terminated as { exitCode?: number }).exitCode;
      state = exitCode && exitCode !== 0 ? "error" : "terminated";
    }
    if (!c.ready && state === "running") state = "waiting";
    return { name: c.name, state };
  });
}
