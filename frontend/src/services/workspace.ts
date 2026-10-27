import { apiRequest } from './api';
import { createWorkspaceStore } from './workspaceStore';
export const workspaceService = createWorkspaceStore(apiRequest);
