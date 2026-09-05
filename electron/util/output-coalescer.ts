// Coalesce terminal output into one IPC send per flush window. Without this
// every PTY/WebSocket chunk becomes its own structured-clone
// `webContents.send` — a `cat bigfile` produces thousands of IPC messages per
// second. 8 ms keeps keystroke echo imperceptible while capping sends at
// ~125/s; the byte cap bounds renderer message size under heavy output.
//
// Shared by the k8s exec terminal (handlers/terminal.ts) and the Agent Session
// PTY (agent/session.ts).

const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;

export interface OutputCoalescer {
  push: (text: string) => void;
  /** Flush what's buffered and drop anything that arrives afterwards — session
   *  teardown is not immediate, so late in-flight writes must not leak a
   *  previous session's output into a replacement. */
  close: () => void;
}

export function makeOutputCoalescer(emit: (chunk: string) => void): OutputCoalescer {
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf.length === 0) return;
    const out = buf;
    buf = '';
    emit(out);
  };
  return {
    push(text: string): void {
      if (closed) return;
      buf += text;
      if (buf.length >= FLUSH_BYTES) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, FLUSH_MS);
      }
    },
    close(): void {
      flush();
      closed = true;
    },
  };
}
