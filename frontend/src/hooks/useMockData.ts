import { useSyncExternalStore } from 'react';
import { mockDataService } from '../services/mockData';
export function useMockData() { return useSyncExternalStore(mockDataService.subscribe, mockDataService.getSnapshot); }
export function useMockSession() { return useSyncExternalStore(mockDataService.subscribeSession, mockDataService.getSession); }
