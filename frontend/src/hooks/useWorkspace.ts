import { useSyncExternalStore } from 'react';
import { workspaceService } from '../services/workspace';
export function useWorkspace() {
  return useSyncExternalStore(workspaceService.subscribe, workspaceService.getSnapshot);
}
