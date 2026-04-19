import type { UpdateInfo } from "$lib/types";

export interface UpdateBannerState {
  updateInfo: UpdateInfo | null;
  dismissed: boolean;
  installing: boolean;
  progress: number;
}

export function createState(): UpdateBannerState {
  return { updateInfo: null, dismissed: false, installing: false, progress: 0 };
}

export function isVisible(state: UpdateBannerState): boolean {
  return state.updateInfo !== null && !state.dismissed;
}

export function computeProgress(downloaded: number, contentLength: number): number {
  if (contentLength <= 0) return 0;
  return Math.round((downloaded / contentLength) * 100);
}
