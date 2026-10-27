/** Read-only access to the user's own Google Calendar / Outlook calendar, entirely in the browser.
 * Tokens stay in memory (never sent to the AutoPlan API); only the converted events are uploaded. */
import type { CalendarProvider, ImportedEvent } from '../types/models';
import { fromGoogle, fromOutlook, type GoogleEvent, type OutlookEvent } from '../utils/externalCalendar';
import { zonedInstant } from '../utils/planning';

export const PROVIDERS: Record<CalendarProvider, { name: string; envKey: string; consoleHint: string }> = {
  google: {
    name: 'Google Calendar',
    envKey: 'VITE_GOOGLE_CLIENT_ID',
    consoleHint: 'Create an OAuth "Web application" client in Google Cloud Console (APIs & Services → Credentials), enable the Google Calendar API, and add http://localhost:5173 as an authorized JavaScript origin.',
  },
  outlook: {
    name: 'Outlook',
    envKey: 'VITE_MICROSOFT_CLIENT_ID',
    consoleHint: 'Register a single-page app in Microsoft Entra (Azure portal → App registrations) with redirect URI http://localhost:5173/msal-redirect.html and the delegated Calendars.Read permission.',
  },
};

const env = import.meta.env as Record<string, string | undefined>;
const warned = new Set<CalendarProvider>();
export function providerConfigError(provider: CalendarProvider) {
  const { name, envKey, consoleHint } = PROVIDERS[provider];
  if (env[envKey]) return '';
  // Setup steps are for developers, so they go to the console (once) rather than the page.
  if (!warned.has(provider)) {
    warned.add(provider);
    console.warn(`${name}: set ${envKey} in frontend/.env and restart the dev server. ${consoleHint}`);
  }
  return `${name} isn’t available yet.`;
}

export interface FetchedCalendar { account: string; events: ImportedEvent[] }

// ---------- Google (Google Identity Services token client) ----------
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
type TokenResponse = { access_token?: string; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };
declare global {
  interface Window {
    google?: { accounts: { oauth2: { initTokenClient: (config: {
      client_id: string; scope: string; callback: (response: TokenResponse) => void; error_callback?: (error: { type: string }) => void;
    }) => TokenClient } } };
  }
}
let gisScript: Promise<void> | undefined;
function loadGoogleScript() {
  gisScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { gisScript = undefined; reject(new Error('Could not load Google sign-in. Check your internet connection.')); };
    document.head.append(script);
  });
  return gisScript;
}
let googleToken: { value: string; expires: number } | null = null;
async function googleAccessToken() {
  if (googleToken && googleToken.expires > Date.now() + 60_000) return googleToken.value;
  await loadGoogleScript();
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: env.VITE_GOOGLE_CLIENT_ID!,
      scope: GOOGLE_SCOPE,
      callback: response => {
        if (!response.access_token) { reject(new Error(response.error_description || 'Google didn’t grant calendar access.')); return; }
        googleToken = { value: response.access_token, expires: Date.now() + 55 * 60_000 };
        resolve(response.access_token);
      },
      error_callback: error => reject(new Error(error.type === 'popup_closed' ? 'Google sign-in was closed before finishing.' : 'Google sign-in failed. Allow pop-ups and try again.')),
    });
    client.requestAccessToken({ prompt: googleToken ? '' : 'consent' });
  });
}
async function googleGet<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) { googleToken = null; throw new Error('Google access expired. Click Sync again.'); }
  if (response.status === 403) throw new Error('Google refused access. Make sure the Google Calendar API is enabled for this app’s Google Cloud project.');
  if (!response.ok) throw new Error(`Google Calendar returned an error (${response.status}).`);
  return response.json() as Promise<T>;
}
async function fetchGoogle(rangeStart: string, rangeEnd: string, zone: string): Promise<FetchedCalendar> {
  const token = await googleAccessToken();
  const base = 'https://www.googleapis.com/calendar/v3';
  const list = await googleGet<{ items: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; selected?: boolean; hidden?: boolean }[] }>(
    `${base}/users/me/calendarList?minAccessRole=reader`, token);
  // Calendars the user shows in Google Calendar (plus the primary one).
  const calendars = list.items.filter(c => c.primary || (c.selected && !c.hidden));
  const account = list.items.find(c => c.primary)?.id ?? 'Google account';
  const timeMin = zonedInstant(rangeStart, 0, zone), timeMax = zonedInstant(rangeEnd, 1440, zone);
  const events: ImportedEvent[] = [];
  for (const calendar of calendars) {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', ...(pageToken ? { pageToken } : {}) });
      const page = await googleGet<{ items: GoogleEvent[]; nextPageToken?: string }>(`${base}/calendars/${encodeURIComponent(calendar.id)}/events?${params}`, token);
      for (const item of page.items) events.push(...fromGoogle(item, calendar.summaryOverride ?? calendar.summary ?? 'Google Calendar', zone));
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  return { account, events };
}

// ---------- Outlook (Microsoft Graph via MSAL) ----------
const GRAPH_SCOPES = ['Calendars.Read'];
let msal: Promise<import('@azure/msal-browser').PublicClientApplication> | undefined;
function msalClient() {
  msal ??= import('@azure/msal-browser').then(async ({ PublicClientApplication }) => {
    const client = new PublicClientApplication({
      auth: {
        clientId: env.VITE_MICROSOFT_CLIENT_ID!,
        authority: `https://login.microsoftonline.com/${env.VITE_MICROSOFT_TENANT || 'common'}`,
        redirectUri: `${window.location.origin}/msal-redirect.html`,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    await client.initialize();
    return client;
  });
  return msal;
}
async function outlookToken() {
  const client = await msalClient();
  const account = client.getAllAccounts()[0];
  try {
    if (account) return { token: (await client.acquireTokenSilent({ scopes: GRAPH_SCOPES, account })).accessToken, account: account.username };
  } catch { /* fall through to an interactive popup */ }
  try {
    const result = await client.acquireTokenPopup({ scopes: GRAPH_SCOPES, prompt: 'select_account' });
    return { token: result.accessToken, account: result.account?.username ?? 'Microsoft account' };
  } catch (error) {
    const code = (error as { errorCode?: string }).errorCode;
    throw new Error(code === 'user_cancelled' ? 'Microsoft sign-in was closed before finishing.' : 'Microsoft sign-in failed. Allow pop-ups and try again.', { cause: error });
  }
}
async function fetchOutlook(rangeStart: string, rangeEnd: string, zone: string): Promise<FetchedCalendar> {
  const { token, account } = await outlookToken();
  const params = new URLSearchParams({
    startDateTime: zonedInstant(rangeStart, 0, zone), endDateTime: zonedInstant(rangeEnd, 1440, zone),
    $top: '500', $select: 'id,subject,start,end,isAllDay,isCancelled,showAs,location,webLink,attendees,responseStatus',
  });
  let url: string | undefined = `https://graph.microsoft.com/v1.0/me/calendarView?${params}`;
  const events: ImportedEvent[] = [];
  while (url) {
    const response: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
    if (response.status === 401 || response.status === 403) throw new Error('Microsoft refused calendar access. Check the app’s Calendars.Read permission and try again.');
    if (!response.ok) throw new Error(`Outlook returned an error (${response.status}).`);
    const page = await response.json() as { value: OutlookEvent[]; '@odata.nextLink'?: string };
    for (const item of page.value) events.push(...fromOutlook(item, zone));
    url = page['@odata.nextLink'];
  }
  return { account, events };
}

/** Opens the provider's sign-in popup if needed and returns events for the range, converted to `zone`. */
export async function fetchExternalCalendar(provider: CalendarProvider, rangeStart: string, rangeEnd: string, zone: string) {
  const problem = providerConfigError(provider);
  if (problem) throw new Error(problem);
  return provider === 'google' ? fetchGoogle(rangeStart, rangeEnd, zone) : fetchOutlook(rangeStart, rangeEnd, zone);
}

/** Forget in-memory tokens / cached Microsoft sign-in (used on disconnect). */
export async function forgetProvider(provider: CalendarProvider) {
  if (provider === 'google') { googleToken = null; return; }
  if (!env.VITE_MICROSOFT_CLIENT_ID || !msal) return;
  const client = await msal;
  await client.clearCache();
}
