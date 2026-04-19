export {
  type WatchEvent,
  WatchBatcher,
  DebouncedFilter,
  filterItems,
  sortItems,
} from "./performance.logic";
import {
  PerformanceStoreLogic,
  WatchBatcher,
  DebouncedFilter,
} from "./performance.logic";
import { unshadowState } from "./_unshadow.js";

class PerformanceStore extends PerformanceStoreLogic {
  override watchBatcher = $state(new WatchBatcher());
  override debouncedFilter = $state(new DebouncedFilter());

  constructor() {
    super();
    unshadowState(this);
  }
}

export const performanceStore = new PerformanceStore();
