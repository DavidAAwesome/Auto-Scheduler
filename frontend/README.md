# AutoPlan frontend

React + TypeScript + Vite. See the root [README](../README.md) for MongoDB/FastAPI setup, environment variables, API contracts, and verification commands.

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
npm run build
npm run lint
npm test
```

Use Node.js 24 LTS. The backend must run on port 8000; Vite forwards `/api` there using `API_PROXY_TARGET`. `VITE_API_URL` defaults to `/api`. Only public configuration belongs in frontend environment variables.

## Screens and authentication

Hash routes: `#/login`, `#/signup`, `#/home`, `#/tasks`, `#/assistant`, `#/analytics`, `#/calendar`, `#/profile`, and `#/settings`. Each screen lives in `src/screens/`. Login and Signup share the prototype's two-column design and preview card; the preview hides at widths of 760px and below. Signup adds name and confirm-password fields. There is no hardcoded demo login.

`src/services/api.ts` sends credentialed requests. `src/services/authSession.ts` restores the HttpOnly-cookie session through `/auth/me`; `App.tsx` gates workspace routes. Failed restoration offers a retry. Profile displays the backend user's name/email. Profile and sidebar logout revoke the server session.

Responsive workspace styles remain in `src/App.css`, with tokens in `src/index.css`. Typography uses Google Fonts with system fallbacks.

## Sprint 1 workspace

`src/services/workspace.ts` connects the existing API client to the shared `workspaceStore.ts`. Tasks support add/edit/complete/reopen/delete, search, and filters. Home and Calendar read the same confirmed server data. Workspace loading and failures are handled by `WorkspaceGate`; failed saves keep the confirmed data and display an error. Account changes clear memory immediately, and stale requests cannot restore the previous account's data. Task data is not stored in localStorage.

Settings saves all seven weekdays, a timezone, and an optional reminder preference. Each day supports one time window; midnight can be entered as 24:00 in the end field. Calendar displays the selected week, saved available hours, completed/open task deadlines, and an all-dates agenda. Its current date follows the saved timezone. Task deadlines are date-only values and are not converted to UTC.

- `src/types/models.ts`: Task, Availability, CalendarEvent, ScheduledBlock, and legacy prototype types.
- `src/services/taskRules.ts`: shared task validation and filters, reused from the prototype.
- `src/services/workspaceStore.ts`: API data loading, mutations, error handling, and account resets.
- `src/components/TaskForm.tsx`: existing accessible form, now awaiting API writes.
- `src/screens/Settings.tsx` and `Calendar.tsx`: saved settings and basic calendar.
- `tests/workspace.test.ts`: API store, failure, account-race, and timezone regression tests.

The old `mockData.ts`/sample data remain as test fixtures and are not imported by the live app. No automatic upload of old localStorage data occurs. Scheduling, external calendar sync, and reminder delivery remain future sprint work.

`npm run preview` serves static output; deploy an API reverse proxy alongside it or configure an appropriate API URL. It is not the development proxy.
