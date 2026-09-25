import { useSyncExternalStore } from "react";
import { mockDataService } from "../services/mockData";
export function useMockData() {
  return useSyncExternalStore(
    mockDataService.subscribe,
    mockDataService.getSnapshot,
  );
}
