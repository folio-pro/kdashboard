export type { ToastType, Toast } from "./toast.logic";
import { ToastStoreLogic } from "./toast.logic";
import { unshadowState } from "./_unshadow.js";

class ToastStore extends ToastStoreLogic {
  override toasts = $state<import("./toast.logic").Toast[]>([]);

  constructor() {
    super();
    unshadowState(this);
  }
}

export const toastStore = new ToastStore();
