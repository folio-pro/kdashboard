/**
 * Native OS notification via the renderer's Notification API (Electron routes
 * it to the platform notifier). Best effort: silently skipped where the API is
 * missing or permission is denied; asks once when undecided.
 */
export function notifyDesktop(title: string, body: string, opts: { tag?: string; silent?: boolean } = {}): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    const show = () => {
      const n = new Notification(title, { body, tag: opts.tag, silent: opts.silent ?? false });
      n.onclick = () => window.focus();
    };
    if (Notification.permission === "granted") show();
    else void Notification.requestPermission().then((p) => { if (p === "granted") show(); });
  } catch {
    // notifications are best effort
  }
}
