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

Hash routes: `#/login`, `#/signup` (signed out); `#/home` (default), `#/settings`, `#/profile`, `#/analytics` (signed in). Unknown routes go to `#/home`.

`src/firebase.ts` initializes Firebase from `VITE_FIREBASE_*`. `src/services/authSession.ts` handles email/password sign-in and signup, Google popup sign-in, password reset, logout, and account deletion, and confirms each Firebase user with `GET /auth/me` before opening the app. `src/services/api.ts` attaches the current Firebase ID token to every request.

Styles live in `src/App.css`, with light and dark theme tokens in `src/index.css` (`html[data-theme]`).

## Workspace layout (from the team's sketch)

- `components/AppLayout.tsx`: top bar with ☰ drawer (Home, Google/Outlook Calendar placeholders, Availability, Analytics), the visible month as the title, a reminders bell, and the user menu (Account details, Analytics, Theme, Settings, Log out, Delete account).
- `screens/Home.tsx`: three panes. `TaskSidebar` (today's tasks and available hours, + Add Task, open/completed task list), `CalendarPane` (Today label, prev/next, D/W/M toggle; tasks appear in a "Due" row, availability shaded in the time grid), and `ChatPanel` (collapsible AI chatbox placeholder).
- `components/TaskPopover.tsx`: task card with edit (pencil), close (×), planned-work progress, the task's work sessions, "Plan work time", complete, and delete.
- `components/TaskForm.tsx`, `SessionForm.tsx` (both use `Modal.tsx`): add/edit tasks (optional due time, total hours) and plan/edit work sessions (task, day, from/until, quick lengths, overlap and due-time checks).
- `components/EventForm.tsx`, `EventPopover.tsx`, `SlotMenu.tsx`: add/edit events (type, time, location, weekly repeat), the event card (delete one occurrence or the series), and the menu shown when an empty slot is clicked (plan work / add event).
- `utils/events.ts`: event recurrence (`occursOn`), clashes, occurrence counts, and side-by-side layout for overlapping blocks (tested in `tests/events.test.ts`).
- `utils/planning.ts`: planned minutes, overlap, due-time, and availability checks for sessions (tested in `tests/planning.test.ts`).
- `services/workspaceStore.ts`: Lan's API-backed store for tasks and availability. `services/uiState.ts` stores theme, calendar view, and chat-panel state per device.
- `utils/calendar.ts`: pure date/view helpers, tested in `tests/calendar.test.ts`.

`npm run preview` serves static output; deploy an API reverse proxy alongside it or configure an appropriate API URL. It is not the development proxy.
