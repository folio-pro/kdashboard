export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

/** Default auto-dismiss duration: errors get 8s, everything else 4s. */
export function getToastDuration(type: ToastType, customDuration?: number): number {
  return customDuration ?? (type === "error" ? 8000 : 4000);
}

export class ToastStoreLogic {
  toasts: Toast[] = [];

  private _counter = 0;
  private _timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  add(toast: Omit<Toast, "id">): string {
    const id = `toast-${++this._counter}`;
    const duration = getToastDuration(toast.type, toast.duration);
    this.toasts = [...this.toasts, { ...toast, id }];
    if (duration > 0) {
      this._timeouts.set(id, setTimeout(() => this.dismiss(id), duration));
    }
    return id;
  }

  dismiss(id: string): void {
    const tid = this._timeouts.get(id);
    if (tid) clearTimeout(tid);
    this._timeouts.delete(id);
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  success(title: string, description?: string): string {
    return this.add({ type: "success", title, description });
  }

  error(title: string, description?: string, action?: Toast["action"]): string {
    return this.add({ type: "error", title, description, action });
  }

  warning(title: string, description?: string): string {
    return this.add({ type: "warning", title, description });
  }

  info(title: string, description?: string): string {
    return this.add({ type: "info", title, description });
  }
}
