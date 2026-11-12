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
/**
 * The first anchor comes from the device clock, before the account timezone is known. Once it is, move the
 * calendar to the account's today, unless the user has already navigated somewhere.
 */
let navigated = false;
const setView = calendarViewStore.set;
calendarViewStore.set = (next: CalendarViewState) => { navigated = true; setView(next); };
export function alignCalendarToday(today: string) {
  if (!navigated && calendarViewStore.get().anchor !== today) setView({ ...calendarViewStore.get(), anchor: today });
}
export function useCalendarView() { return useSyncExternalStore(calendarViewStore.subscribe, calendarViewStore.get); }

// The chat panel overlays the calendar on narrow screens, so it starts closed there unless the user opened it before.
const savedChat = read('autoplan.chatOpen');
const wide = typeof innerWidth === 'undefined' || innerWidth > 999;
export const chatPanelStore = createStore<boolean>(savedChat === null ? wide : savedChat === 'true', open => write('autoplan.chatOpen', String(open)));
export function useChatPanelOpen() { return useSyncExternalStore(chatPanelStore.subscribe, chatPanelStore.get); }

/** The left Today's Tasks panel. Open by default; hiding it gives the calendar the full width. */
export const sidebarStore = createStore<boolean>(read('autoplan.sidebarOpen') !== 'false', open => write('autoplan.sidebarOpen', String(open)));
export function useSidebarOpen() { return useSyncExternalStore(sidebarStore.subscribe, sidebarStore.get); }

/** Panel widths in px, set by dragging their edge. The calendar keeps at least CALENDAR_MIN_WIDTH. */
export interface WidthLimits { min: number; max: number; initial: number }
export const SIDEBAR_WIDTH: WidthLimits = { min: 200, max: 440, initial: 264 };
export const CHAT_WIDTH: WidthLimits = { min: 260, max: 720, initial: 280 };
export const CALENDAR_MIN_WIDTH = 470;
function savedWidth(key: string, limits: WidthLimits) {
  const value = Number(read(key));
  return read(key) !== null && Number.isFinite(value) && value >= limits.min && value <= limits.max ? value : limits.initial;
}
export const sidebarWidthStore = createStore<number>(savedWidth('autoplan.sidebarWidth', SIDEBAR_WIDTH), w => write('autoplan.sidebarWidth', String(w)));
export function useSidebarWidth() { return useSyncExternalStore(sidebarWidthStore.subscribe, sidebarWidthStore.get); }
export const chatWidthStore = createStore<number>(savedWidth('autoplan.chatWidth', CHAT_WIDTH), w => write('autoplan.chatWidth', String(w)));
export function useChatWidth() { return useSyncExternalStore(chatWidthStore.subscribe, chatWidthStore.get); }

/** The AI chat filling the area below the top bar. Not remembered: a reload shows the calendar again. */
export const chatFullscreenStore = createStore<boolean>(false);
export function useChatFullscreen() { return useSyncExternalStore(chatFullscreenStore.subscribe, chatFullscreenStore.get); }

/** Show built-in holidays, observances and daylight-saving changes on the calendar (on by default). */
export const holidaysStore = createStore<boolean>(read('autoplan.holidays') !== 'false', on => write('autoplan.holidays', String(on)));
export function useShowHolidays() { return useSyncExternalStore(holidaysStore.subscribe, holidaysStore.get); }
