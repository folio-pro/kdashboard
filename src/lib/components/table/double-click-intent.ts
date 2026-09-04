// Which row a double-click meant. The list is live: between the two clicks
// of a double-click the watch can insert a row above the cursor (a CronJob
// spawning a pod), so the row under the pointer on the second click is not
// the one the user clicked first. The double-click opens the resource of the
// FIRST click — the one previewed in the aside — never a neighbour.
//
// The browser fires click, click, dblclick: the second click must not
// replace the first candidate, or the dblclick would always agree with the
// row under the pointer and the protection would never trigger.

export const DOUBLE_CLICK_WINDOW_MS = 700;

export class DoubleClickIntent {
  private first: { uid: string; at: number } | null = null;

  /** A single click on `uid`; only the first click of a sequence is remembered. */
  click(uid: string, now: number = Date.now()): void {
    if (this.first && now - this.first.at < DOUBLE_CLICK_WINDOW_MS) return;
    this.first = { uid, at: now };
  }

  /**
   * The uid the double-click on `uid` was meant for: the first click's, when
   * it was a different row within the window; otherwise the row itself.
   * Resets the sequence either way.
   */
  resolve(uid: string, now: number = Date.now()): string {
    const first = this.first;
    this.first = null;
    if (first && first.uid !== uid && now - first.at < DOUBLE_CLICK_WINDOW_MS) return first.uid;
    return uid;
  }
}
