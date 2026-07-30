import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ResourceList, CrdGroup, CrdInfo, CrdResourceList } from "../types/index.js";
import type {
  KubeIo,
  Unsubscribe,
  WatchEventPayload,
  PortForwardStartArgs,
  PortForwardStartResult,
  CrdListArgs,
} from "./k8s.io.js";

/**
 * The real KubeIo adapter: maps the store's Kubernetes-domain calls onto Tauri
 * `invoke` command strings and `listen` event channels. This is the ONLY place
 * that knows the backend command names — the orchestration above the seam
 * never sees them.
 */
export class TauriKubeIo implements KubeIo {
  getContexts(): Promise<string[]> {
    return invoke<string[]>("get_contexts");
  }

  getCurrentContext(): Promise<string> {
    return invoke<string>("get_current_context");
  }

  switchContext(context: string): Promise<void> {
    return invoke("switch_context", { context });
  }

  getNamespaces(): Promise<string[]> {
    return invoke<string[]>("get_namespaces");
  }

  listResources(resourceType: string, namespace: string): Promise<ResourceList> {
    return invoke<ResourceList>("list_resources", { resourceType, namespace });
  }

  getResourceCounts(
    resourceTypes: readonly string[],
    namespace: string,
  ): Promise<Record<string, number>> {
    return invoke<Record<string, number>>("get_resource_counts", {
      resourceTypes: [...resourceTypes],
      namespace,
    });
  }

  startResourceWatch(resourceType: string, namespace: string): Promise<void> {
    return invoke("start_resource_watch", { resourceType, namespace });
  }

  stopResourceWatch(): Promise<void> {
    return invoke("stop_resource_watch");
  }

  async onWatchEvent(cb: (payload: WatchEventPayload) => void): Promise<Unsubscribe> {
    return listen<WatchEventPayload>("resource-watch-event", (event) => cb(event.payload));
  }

  stopLogStream(): Promise<void> {
    return invoke("stop_log_stream");
  }

  stopTerminalExec(): Promise<void> {
    return invoke("stop_terminal_exec");
  }

  startPortForward(args: PortForwardStartArgs): Promise<PortForwardStartResult> {
    return invoke<PortForwardStartResult>("start_port_forward", {
      podName: args.podName,
      namespace: args.namespace,
      containerPort: args.containerPort,
      localPort: args.localPort,
      sessionId: args.sessionId,
    });
  }

  stopPortForward(sessionId: string): Promise<void> {
    return invoke("stop_port_forward", { sessionId });
  }

  async onPortForwardClosed(cb: (sessionId: string) => void): Promise<Unsubscribe> {
    return listen<string>("port-forward-closed", (event) => cb(event.payload));
  }

  discoverCrds(): Promise<CrdGroup[]> {
    return invoke<CrdGroup[]>("discover_crds");
  }

  listCrdResources(args: CrdListArgs): Promise<CrdResourceList> {
    return invoke<CrdResourceList>("list_crd_resources", {
      group: args.group,
      version: args.version,
      kind: args.kind,
      plural: args.plural,
      scope: args.scope,
      namespace: args.namespace,
    });
  }

  getCrdCounts(crds: CrdInfo[], namespace: string): Promise<Record<string, number>> {
    return invoke<Record<string, number>>("get_crd_counts", { crds, namespace });
  }
}
