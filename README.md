# AutoPlan

React + TypeScript frontend, FastAPI backend, and MongoDB persistence for accounts, tasks, and weekly availability. Firebase Authentication handles sign-in (email/password and Google); the API verifies Firebase ID tokens and keeps each user's data in MongoDB.

## Local setup

Prerequisites: Python 3.13, Node.js 24 LTS, and MongoDB (local, Docker, or Atlas). Run from the repository root. For an existing MongoDB deployment, skip Docker and set its URI in `backend/.env`.

```sh
docker run -d --name autoplan-mongo -p 127.0.0.1:27017:27017 -v autoplan-mongo-data:/data/db mongo:8
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt   # Windows: backend\.venv\Scripts\python
cp -n backend/.env.example backend/.env
cp -n frontend/.env.example frontend/.env
npm ci --prefix frontend
```

In the [Firebase console](https://console.firebase.google.com/), open your project and:

1. Under **Authentication → Sign-in method**, enable **Email/Password** and **Google**.
2. Under **Authentication → Settings → Authorized domains**, make sure `localhost` and `127.0.0.1` are listed.
3. Under **Project settings → Your apps**, add a Web app if needed and copy its config values into the `VITE_FIREBASE_*` keys in `frontend/.env`.
4. Set `FIREBASE_PROJECT_ID` in `backend/.env` to the same project ID.

If you use MongoDB Atlas, add your current IP address under **Network Access**; otherwise the API fails at startup with an SSL handshake error.

Start the API in one terminal:

```sh
cd backend
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend in another terminal, from the repository root:

```sh
npm run dev --prefix frontend -- --port 5173 --strictPort
```

Open <http://localhost:5173/#/signup> and create an account, or use **Continue with Google**. Use `localhost` (not `127.0.0.1`) so Outlook sign-in matches its registered redirect URI. There are no built-in demo credentials. Stop any existing development server using these ports before starting another. To restart the persistent MongoDB container later, run `docker start autoplan-mongo`.

## Environment variables

Backend (`backend/.env`; never expose these with a `VITE_` prefix):

- `MONGODB_URI`: required connection URI; example `mongodb://127.0.0.1:27017`. Database credentials belong here only.
- `DATABASE_NAME`: MongoDB database, default `auto_scheduler`.
- `FIREBASE_PROJECT_ID`: required; the Firebase project whose ID tokens the API accepts. Must match `VITE_FIREBASE_PROJECT_ID`.
- `ALLOWED_ORIGINS`: comma-separated exact frontend origins, without paths. Examples include localhost and 127.0.0.1 on ports 5173/5174. Wildcards are rejected.
- `OPENAI_API_KEY`: optional. Enables `/assistant/chat` and `/schedule/interpret` via the OpenAI Responses API. Never commit a real key; leave blank to use structured scheduling without AI.
- `OPENAI_MODEL`: optional model id for those endpoints (default `gpt-4o-mini`).

Frontend (`frontend/.env`):

- `VITE_API_URL`: browser API base URL, default `/api`.
- `API_PROXY_TARGET`: Vite development proxy target, default `http://127.0.0.1:8000`.
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`: the Firebase Web app config. These are public identifiers, not secrets. If they are missing, the app shows a setup message instead of the login page.

Tests optionally read `TEST_MONGODB_URI`. Tests create randomly named databases prefixed `autoplan_auth_test_`, then delete only those databases. Use a dedicated local/test MongoDB instance with permission to create indexes and databases.

`.env` files are ignored by Git; committed `.env.example` files contain placeholders only. Production should serve the app and `/api` through the same HTTPS origin, forwarding `/api/auth/*` to backend `/auth/*`. Vite's development proxy is not a production deployment. `npm run preview` alone does not provide the API proxy.

## Authentication API

Signup, login, Google sign-in, password reset and logout happen in the browser through the Firebase SDK. Every API request sends `Authorization: Bearer <Firebase ID token>`.

- `GET /auth/me`: verifies the token, creates the MongoDB user on first sign-in (keyed by Firebase `uid`), keeps name/email in step with Firebase, and returns `{id, name, email}`; 401 otherwise.
- `PUT /auth/avatar`: saves (or clears with `null`) the https link of an avatar uploaded to Firebase Storage; image bytes never go in MongoDB.
- `DELETE /auth/account`: deletes the user's tasks, work sessions, events, availability, plan and user record, then returns 204. The frontend then deletes the Firebase account.
- `GET /protected`: requires a valid token and returns the current user's ID.

The API checks the token's RS256 signature against Google's published keys, plus its expiry, audience (`FIREBASE_PROJECT_ID`) and issuer. It returns 503 if Google's keys can't be fetched. Firebase manages passwords; MongoDB stores none. Browser mutations validate Origin, and CORS permits only configured origins.

The frontend restores sessions through Firebase on refresh, gates workspace screens, shows API errors, and supports logout from the user menu (top right) and the Account page. Signup shares the responsive two-column Login design.

## Validation

From the repository root:

```sh
npm run build --prefix frontend
npm run lint --prefix frontend
npm test --prefix frontend
cd backend
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 .venv/bin/python -m pytest -q
```

Without `TEST_MONGODB_URI`, mock-database tests run and real-MongoDB tests explicitly skip. Tests replace Firebase with a fake token verifier (`tests/conftest.py`). Coverage includes profile creation, invalid/missing tokens, account deletion, user isolation, validation, and CORS/origin checks.

Lan's original Sprint 1 verification (before the Firebase switch): 68 backend tests passed (34 mock, 34 real MongoDB 8), plus 14 frontend tests, lint, and production build. Browser checks covered signup, login, task creation/edit/completion/deletion, availability save/load, refresh, calendar display, logout, and a second account with no access to the first account’s data. MongoDB records from the browser-created accounts were inspected directly. No Atlas or production deployment has been tested. See [SPRINT1.md](SPRINT1.md) for the detailed report and Codex disclosure draft.

## Workspace API

All workspace routes use the Firebase authentication dependency. Owners are taken only from the verified token; extra input fields such as `user_id` are rejected. Responses have `Cache-Control: no-store`.

- `GET /tasks`: current user's tasks, ordered by deadline.
- `POST /tasks`: create `{title, deadline, dueTime?, minutes, priority, category}`; returns 201 with task `{id, title, deadline, dueTime, minutes, priority, category, done}`. `dueTime` is minutes after midnight and is optional (default 1439 = 11:59 PM). `minutes` is the total estimated work (15 to 6000, in steps of 15).
- `GET /tasks/{id}`: get an owned task.
- `PUT /tasks/{id}`: edit its fields, preserving completion.
- `PATCH /tasks/{id}/completion`: `{done: true}` or `{done: false}`.
- `DELETE /tasks/{id}`: delete owned task and its work sessions; returns 204.
- `GET /sessions`: the user's work sessions, ordered by date and start.
- `POST /sessions`: plan work time `{taskId, date, start, end, source?}`; returns 201. A task can have any number of sessions on different days (e.g. 30m one day, 2h30m another). `start`/`end` are minutes after midnight in 5-minute steps; `source` is `manual` (default) or `auto` (reserved for the future AI scheduler). Sessions must end by the task's due time (422) and cannot overlap another of the user's sessions or events (409).
- `PUT /sessions/{id}`, `DELETE /sessions/{id}`: edit or remove an owned session.
- `GET /events`: the user's events. Events are fixed-time commitments you attend (classes, meetings, appointments, meetups); they have no due date.
- `POST /events`: create `{title, kind, date, start, end, location?, repeat?}`; returns 201 with `{id, ..., skipDates, source}`. `kind` is `Class`, `Meeting`, `Appointment`, `Social`, or `Other`. `repeat` is `{weekdays, until}` (Monday = 0) for a weekly series such as a class schedule, up to one year long.
- `PUT /events/{id}`: edit the event (every occurrence of a series). `POST /events/{id}/skip` with `{date}`: remove one occurrence of a series (e.g. a cancelled class). `DELETE /events/{id}`: delete the event or whole series.
- `GET /availability`: saved settings, or defaults (all days disabled, UTC, reminders off).
- `PUT /availability`: save `{days, timeZone, reminders}`. Each day has `{day, enabled, start, end}`. Include all seven weekdays exactly once, Monday=0 through Sunday=6. Start/end are integer minutes after midnight. End must follow start and may equal 1440 (24:00). Overnight windows are not supported. `timeZone` is a valid IANA identifier.

Unknown tasks and tasks owned by other users both return 404. Missing or revoked authentication returns 401. Invalid input returns 422. MongoDB creates an owner/deadline index for tasks, owner/date and owner/task indexes for sessions, an owner/date index for events, and a unique owner index for availability at startup. Calendar derives its view from the same tasks and settings; it needs no separate duplicate database collection.

## Calendar sync (Google Calendar and Outlook)

Users connect their own calendar on the **Calendars** page (☰ menu → Google Calendar / Outlook Calendar). The browser signs in with **read-only** access (Google Identity Services with `calendar.readonly`; Microsoft MSAL + Graph with `Calendars.Read`), fetches timed events from 1 week ago to 8 weeks ahead, converts them to the user's time zone (splitting events that cross midnight), and uploads the snapshot. OAuth tokens stay in browser memory and never reach the API. All-day events, events marked free, cancelled events and declined invitations are skipped.

Imported events are stored as read-only `events` with `source: "google" | "outlook"`, so they block work sessions and count as busy time for plan generation like any event. Syncing again replaces the previous copy (no duplicates); disconnecting removes them. AutoPlan never writes to the external calendar.

- `GET /calendar/connections`: `[{provider, account, lastSynced, rangeStart, rangeEnd, eventCount}]`.
- `PUT /calendar/{google|outlook}/sync`: `{account, rangeStart, rangeEnd, events: [{externalId, title, kind, date, start, end, location?, calendarName?, link?}]}`. Replaces that provider's events in the range (all of them if a different account is connected). At most 120 days and 3000 event-days per sync; every event must fall inside the range; non-https links are dropped.
- `DELETE /calendar/{google|outlook}`: removes the connection and its imported events.
- Editing, skipping or deleting an imported event returns 409 ("change it in Google Calendar / Outlook, then sync").

One-time setup per team (values go in `frontend/.env`; see `frontend/.env.example`):

1. **Google** (`VITE_GOOGLE_CLIENT_ID`): in [Google Cloud Console](https://console.cloud.google.com/) (the Firebase project works), enable the **Google Calendar API**, configure the OAuth consent screen (add the `.../auth/calendar.readonly` scope; while the app is in *Testing*, add each teammate as a test user), then create an OAuth client of type **Web application** with authorized JavaScript origins `http://localhost:5173` and `http://127.0.0.1:5173`.
2. **Outlook** (`VITE_MICROSOFT_CLIENT_ID`, optional `VITE_MICROSOFT_TENANT`, default `common`): in the [Azure portal](https://portal.azure.com/) → Microsoft Entra ID → App registrations → New registration, choose "Accounts in any organizational directory and personal Microsoft accounts", add a **Single-page application** redirect URI `http://localhost:5173/msal-redirect.html`, and under API permissions add Microsoft Graph delegated **Calendars.Read**. No client secret is needed. School tenants may require an admin to approve the permission.

Restart `npm run dev` after editing `.env`. Without these values the Calendars page explains what's missing and everything else works.

## AI-assisted scheduling

Responsibilities are separated on purpose:

1. **OpenAI service** (`openai_interpret.py`, `/assistant/chat`): interprets natural language into structured preferences / intents with the Responses API and Structured Outputs. Model output never writes the database.
2. **Scheduling engine** (`scheduling_engine.py`): deterministic placement of work sessions from tasks, deadlines, priorities, availability, events, dependencies, and split rules.
3. **Validator** (`scheduling_validator.py`): independently rechecks hard constraints before a preview is trusted or applied.
4. **Persistence / UI**: `POST /schedule/preview` stores a pending preview; the calendar shows proposed sessions; **Apply** / **Cancel** call `/schedule/apply` or discard. Apply re-fingerprints current data, rejects stale previews, and is idempotent.

The engine works with structured tasks even when `OPENAI_API_KEY` is unset. OpenAI is never used to invent conflict-free timestamps.

### Heuristic (preferences, not proofs)

Ready tasks are ordered by dependency readiness, then deadline/due time, then priority (High → Low), then stable task id. Free time is availability minus events and fixed (manual/locked) sessions. Split tasks pack 15-minute-aligned sessions up to `maxSessionMinutes` (prefer fewer, larger chunks, earlier starts). Unsplit tasks need one contiguous free block. Remainders smaller than `minSessionMinutes` are reported as unscheduled (`remainder_below_min_session`) — never silently dropped. Failure to place work is reported with reason codes such as `insufficient_availability` or `no_contiguous_slot`; that is **not** a claim of mathematical infeasibility unless a validator/cycle check establishes it (for example `dependency_cycle`).

### Schedule API

- `POST /schedule/preview` `{horizonDays?}` → `{previewId, schedule}` (no session writes).
- `POST /schedule/apply` `{previewId}` → creates `source: "auto"` sessions; replaces unlocked auto sessions; keeps manual/locked.
- `POST /schedule/replan` — same as preview after task/availability changes.
- `POST /schedule/interpret` — OpenAI structured interpretation; optional preview when `runScheduler` and no clarification needed.

### Manual check

1. Set availability (e.g. Mon 6–9 PM) and add a calendar event 7–8 PM.
2. Add a 120-minute task due that day at 9 PM with **Allow splitting** on (60-minute max sessions).
3. Click **Generate Schedule** on the calendar: expect proposed 6–7 and 8–9 PM.
4. **Apply**, then refresh — sessions persist. Repeat Apply — no duplicates.
5. Create the same task with splitting off — preview reports `no_contiguous_slot`.
6. Optional: set `OPENAI_API_KEY` and ask the chat to schedule; without a key, structured preview still works.

Live OpenAI calls are **not** covered by CI; interpret/chat OpenAI paths are unit-tested with mocks only.

## Current scope

Sprint 1 includes Firebase login/signup (email/password and Google), password reset, logout, and account deletion; MongoDB task CRUD and completion; saved weekday availability and time zone; and the sketch-based workspace: a top bar (menu, month title, reminders bell, user menu with theme toggle), a Today's Tasks sidebar with Add Task, a day/week/month calendar, and an AI chatbox panel. New accounts start empty.

Tasks have a due date and an optional due time (11:59 PM if left blank), remaining duration, split limits, optional earliest start, and dependencies. The user can place **work sessions** manually or generate them with **Generate Schedule**. Sessions show as blocks in the time grid; locked/manual sessions are preserved when replanning.

**Events** (classes, meetings, appointments, meetups) are fixed blocks of time with an optional location and an optional weekly repeat until a last date. They block work sessions and auto-scheduling. Google Calendar and Outlook import is available on the Calendars page. Reminder delivery remains limited to the bell list for due today/tomorrow.

### Schedule persistence diagnostics

The API loads `backend/.env` relative to `app/config.py`, independent of the launch directory. Existing process environment variables take precedence. Task CRUD, schedule previews, and Apply use the same `app.state.db` connection; Firebase token verification remains unchanged.

Apply requires MongoDB transactions (a replica set or transaction-capable sharded deployment). It validates the preview and replaces unlocked auto sessions plus the preview status in one transaction with majority write concern. It returns success only after commit; there is no in-memory or non-transactional fallback.

Older databases may have a unique, non-sparse `sessions.jti` index from token storage. Work sessions omit `jti`, so that index rejects additional work sessions with error 11000. Startup builds a partial unique index for documents where `jti` exists before removing the legacy index. It does not remove records or the legacy token TTL index, and token identifiers remain unique. This error does not require changing Atlas Network Access.

Database failures return a safe `detail`, a category in `code`, and a `reference` that matches the backend error log. The log includes the method, route, exception type, and MongoDB error code, without credentials, request bodies, or driver error text. Categories distinguish connectivity, database authentication, database permissions, uniqueness conflicts, document validation, unsupported transactions, and other operations. User authentication errors remain HTTP 401; database credentials/roles are backend configuration failures and do not sign users out.

Backend tests run with `cd backend && .venv/bin/pytest -q`. Set `TEST_MONGODB_URI` through your environment to a test-capable MongoDB replica set to exercise persistence and rollback. The fixture creates and cleans up uniquely named `aptest_*` databases; it never substitutes a production database name. Transaction tests skip mongomock and standalone MongoDB rather than pretending to verify persistence. Frontend checks: `cd frontend && npm test && npm run build`.
