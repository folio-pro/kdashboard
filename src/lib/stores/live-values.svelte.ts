import { LiveValuesLogic } from "./live-values.logic";
import { unshadowState } from "./_unshadow.js";

export type { ChangeDirection, RowFlash, RowSignals, SignalReader } from "./live-values.logic";
export { signalsFor, FLASH_MS, NO_FLASH } from "./live-values.logic";

class LiveValuesStore extends LiveValuesLogic {
  override generation = $state(0);

  /** The single pending sweep, so N flashes in one batch share one timer. */
  private _sweepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    unshadowState(this);
  }

  override compare(
    uid: string,
    before: Record<string, number | null>,
    after: Record<string, number | null>,
    now: number,
  ): boolean {
    const recorded = super.compare(uid, before, after, now);
    if (recorded) this._scheduleSweep();
    return recorded;
  }

  private _scheduleSweep(): void {
    if (this._sweepTimer !== null) return;
    const expiry = this.nextExpiry();
    if (expiry === null) return;
    // Wake at the OLDEST flash's expiry, not a fresh full window: a flash
    // recorded late shares this timer, and sweeping on its own schedule would
    // leave the earlier one's arrow up for almost another FLASH_MS.
    const delay = Math.max(0, expiry - Date.now());
    this._sweepTimer = setTimeout(() => {
      this._sweepTimer = null;
      this.sweep(Date.now());
      // A flash recorded late in the window outlives this sweep; keep going
      // until the last one has expired.
      if (this.pending) this._scheduleSweep();
    }, delay);
  }

  override clear(): void {
    if (this._sweepTimer !== null) {
      clearTimeout(this._sweepTimer);
      this._sweepTimer = null;
    }
    super.clear();
  }
}

export const liveValues = new LiveValuesStore();
