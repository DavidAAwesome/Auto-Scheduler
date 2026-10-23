import { useSyncExternalStore } from 'react';
import { localDate } from '../utils/dates.ts';
import type { CalendarMode } from '../utils/calendar.ts';

/** Small per-device UI preferences. Storage can be unavailable, so every access is guarded. */
function read(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Preference simply isn't remembered. */ } }

function createStore<T>(initial: T, persist?: (value: T) => void) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) { value = next; persist?.(next); listeners.forEach(fn => fn()); },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type Theme = 'light' | 'dark';
const savedTheme = read('autoplan.theme');
const initialTheme: Theme = savedTheme === 'dark' || savedTheme === 'light'
  ? savedTheme
  : typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const applyTheme = (theme: Theme) => { if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme; };
applyTheme(initialTheme);
export const themeStore = createStore<Theme>(initialTheme, theme => { write('autoplan.theme', theme); applyTheme(theme); });
export function useTheme() { return useSyncExternalStore(themeStore.subscribe, themeStore.get); }

export interface CalendarViewState { mode: CalendarMode; anchor: string }
const savedMode = read('autoplan.calendarMode');
export const calendarViewStore = createStore<CalendarViewState>(
  { mode: savedMode === 'day' || savedMode === 'month' ? savedMode : 'week', anchor: localDate() },
  view => write('autoplan.calendarMode', view.mode),
);
export function useCalendarView() { return useSyncExternalStore(calendarViewStore.subscribe, calendarViewStore.get); }

// The chat panel overlays the calendar on narrow screens, so it starts closed there unless the user opened it before.
const savedChat = read('autoplan.chatOpen');
const wide = typeof innerWidth === 'undefined' || innerWidth > 1180;
export const chatPanelStore = createStore<boolean>(savedChat === null ? wide : savedChat === 'true', open => write('autoplan.chatOpen', String(open)));
export function useChatPanelOpen() { return useSyncExternalStore(chatPanelStore.subscribe, chatPanelStore.get); }
