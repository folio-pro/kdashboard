// Reactive wrapper over LogStreamLogic: the same state machine, with `phase`
// and `error` as Svelte 5 runes so the viewer re-renders on every transition.
// All behaviour lives in the .logic.ts base class, which is where the tests are.

import { invoke } from "$lib/ipc/core";
import { listen } from "$lib/ipc/event";
import { unshadowState } from "$lib/stores/_unshadow.js";

import { LogStreamLogic, type LogStreamIo } from "./log-stream.logic";
import type { StreamPhase } from "./log-viewer";

/** What a caller supplies; the IPC half is wired up here. */
export type LogStreamHooks = Omit<LogStreamIo, "invoke" | "listen">;

class LogStream extends LogStreamLogic {
  // Override plain properties with Svelte 5 reactive state
  phase = $state<StreamPhase>("idle");
  error = $state<string | null>(null);

  constructor(hooks: LogStreamHooks) {
    super({
      ...hooks,
      invoke: (cmd, args) => invoke(cmd, args),
      listen: <T,>(channel: string, cb: (payload: T) => void) =>
        listen<T>(channel, (event) => cb(event.payload)),
    });
    unshadowState(this);
  }
}

/** Create a reactive log stream. Call destroy() when the owner unmounts. */
export function createLogStream(hooks: LogStreamHooks): LogStreamLogic {
  return new LogStream(hooks);
}
