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
- `POST /tasks`: create `{title, deadline, dueTime?, minutes, priority, category}`; returns 201 with task `{id, title, deadline, dueTime, minutes, priority, category, done}`. `dueTime` is minutes after midnight and is optional (default 1439 = 11:59 PM). `minutes` is the total estimated work (15 to 6000, in steps of 15). `completedMinutes` (default 0) is work actually done; the response's `remainingMinutes` is always `max(0, minutes − completedMinutes)`. Older clients may still send `remainingMinutes`, which sets `completedMinutes = minutes − remainingMinutes`.
- `GET /tasks/{id}`: get an owned task.
- `PUT /tasks/{id}`: edit its fields, preserving completion.
- `PATCH /tasks/{id}/completion`: `{done: true}` or `{done: false}`.
- `DELETE /tasks/{id}`: delete owned task and its work sessions; returns 204.
- `GET /sessions`: the user's sessions in the canonical shape `{id, taskId, title, type, status, locked, source, scheduleVersion, startAt, endAt, date, start, end}`. `type` is `work` or `break` (`taskId` is null for breaks); `status` is `saved`, `completed` or `cancelled` (`proposed` exists only inside previews). `startAt`/`endAt` are UTC instants and are the source of truth; `date`/`start`/`end` are the same instants in the user's time zone, for display.
- `POST /sessions`: plan work time `{taskId, date, start, end, locked?}` in local wall-clock time; returns 201 with `source: "manual"`. A task can have any number of sessions on different days. Sessions must end by the task's due time (422) and cannot overlap another live session or an event (409).
- `PUT /sessions/{id}`, `DELETE /sessions/{id}`: edit or remove an owned work session. Breaks are managed by the scheduler and are not editable here.
- `PATCH /sessions/{id}/status` `{status}`: mark a work session `completed` (its minutes are added to the task's `completedMinutes`), back to `saved`, or `cancelled`.
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

## Scheduling

There is one scheduling service (`backend/app/scheduling_service.py`). The **Generate Schedule** button, **Repair schedule**, the Today panel and every chat request call it, and they all read the same session list, so the calendar, the Today panel and the chat cannot disagree.

1. **Engine** (`scheduling_engine.py`): pure and deterministic. It works in absolute UTC minutes and converts wall-clock availability with the user's IANA zone, so DST days are handled (a time in a spring-forward gap maps to the first instant after it; an ambiguous fall-back time uses the first occurrence).
2. **Validator** (`scheduling_validator.py`): an independent check of every preview before it is stored and again inside Apply: no overlaps, inside availability, not in the past, by each deadline, after earliest start and dependencies, daily limit, focus limit with breaks, and per-task duration conservation.
3. **Previews and Apply**: a preview is stored in `schedule_previews` with status `proposed` and never touches `sessions`. Apply re-runs the validator, rejects the preview with 409 if `users.schedule_version` or the input fingerprint changed (any task, event, availability, preference or session edit bumps the version), then deletes, shortens and inserts sessions and marks the preview applied in one MongoDB transaction. A second Apply of the same preview returns the saved schedule with `duplicate: true` and writes nothing.
4. **OpenAI** (`assistant.py`, optional): only classifies the request into an intent with validated parameters (`taskId`, `breakMinutes`, `notBefore`). It never produces times or claims an action; the reply shown for scheduling intents comes from the service result. Missing or invalid parameters become one focused question.

### Free time, breaks and workload

Free time is availability, clipped to now and the planning window, minus events, lunch, protected breaks and fixed sessions (locked, manual or in progress), using half-open intervals. Preferences (`GET`/`PUT /schedule/preferences`, also on the Settings page) default to 50 minutes of focus, a 10-minute break, 4 hours of task work per day and no lunch window. These are editable defaults, not health advice.

A **work run** is a sequence of work sessions with no rest between them. A gap counts as rest when it contains at least one break length of time that is not an event; lunch and protected breaks are rest, a meeting is not. A run may hold at most the focus length, even across task switches. When two runs on the same day together exceed the focus length, a break session is reserved between them unless lunch or a protected break already sits there. No trailing break is added after the last run. Unchanged automatic breaks are kept as-is when a plan is recalculated.

### Priority and deadlines

Tasks are ordered by deadline risk first, then priority (High, Medium, Low), then earliest deadline, then task id, respecting dependencies (a cycle is reported as `dependency_cycle`). A task is at risk when its remaining minutes exceed the usable capacity before its deadline, approximated as free time × focus / (focus + break), capped by the daily limit. This is an approximation for ordering only. In repair mode an at-risk task may displace flexible sessions of lower-priority work, at most 20 moves in total and 6 per task, and only when the urgent task gains minutes and the displaced task loses no more than that. Unsplit tasks get one session that must also fit the focus length.

Minutes that cannot be placed are reported per task with reason codes (`deadline_passed`, `insufficient_capacity`, `daily_limit`, `no_contiguous_slot`, `unsplit_exceeds_focus_limit`, `beyond_planning_window`, `dependency_unallocated`, and others). This is a greedy heuristic: an unplaced task is **not** proof that no schedule exists.

### Duration invariant

For every open task: `remaining = estimated − completed`, and `retained + new + unallocated = remaining + overAllocated`. `retained` counts saved sessions that stay (locked, manual, in-progress, and kept flexible sessions). A session is **in progress** when `startAt < now < endAt`. It is retained in full, because its minutes are not completed until the user marks it done; a requested break can shorten it at `now`. `overAllocated` is non-zero only when fixed sessions already exceed the remaining work, which is reported as a conflict instead of being silently trimmed.

### Session classes in a new plan

- Completed and cancelled sessions are ignored; completed work in the last 12 hours still counts toward the current run.
- Past saved sessions are context only.
- In-progress, locked and manual sessions are fixed. Locked breaks are protected rest.
- Unlocked automatic future work is flexible: Generate replaces it, Repair keeps it when it is still valid and only moves what must change.
- Automatic breaks are recalculated.

### Schedule API

- `GET /schedule` → `{scheduleVersion, timeZone, sessions}`, the saved schedule.
- `POST /schedule/preview` `{horizonDays?}`: generate a fresh plan.
- `POST /schedule/repair` (alias `/schedule/replan`) `{horizonDays?, moves?: [{taskId, notBefore}]}`: a local repair. `moves` asks for a task to start no earlier than an instant ("move Asm to tomorrow").
- `POST /schedule/break` `{minutes}`: a protected break starting now, with the schedule repaired around it. If an event or locked work is in the way the break is shortened or refused, and the preview says why.
- Each preview returns `{previewId, mode, sessions, removed, tasks, conflicts, days, firstProposedDate, note, ...}`. `sessions` is the complete future schedule in the window if applied, with `change` = `retained`, `kept`, `new` or `truncated`. `removed` lists saved sessions Apply deletes (or shortens, when `newEndAt` is set) with a reason.
- `POST /schedule/apply` `{previewId}` → `{previewId, status, duplicate, schedule}`. Returns 409 for a stale or invalid preview.
- `GET /schedule/preview/{id}`: a stored preview.
- `POST /schedule/interpret`: OpenAI interpretation of a scheduling request.

### Chat

Chat requests are parsed deterministically first and fall back to OpenAI only for intent classification: today's plan, busy time, generate, explain what didn't fit, request a break ("I need a 30-minute break now"), repair, and move a task. "Today's tasks" lists today's saved and proposed sessions and breaks with their times, and lists deadlines separately. Proposed sessions are labelled as not saved.

### Manual check (the acceptance scenario)

1. Set availability to 9 AM–12 PM every day in America/New_York.
2. Add **Asm** (High, 60 min) and **Test revision** (Medium, 60 min), both due tomorrow.
3. At 8 AM, click **Generate Schedule**. Expect: 9:00–9:50 Asm, 9:50–10:00 Break, 10:00–10:10 Asm, 10:10–10:50 Test revision, 10:50–11:00 Break, 11:00–11:20 Test revision.
4. Ask the chat "Today's tasks": the same six items are listed as proposed, and the deadlines appear as "Next due" tomorrow.
5. **Apply**, then refresh: the sessions are saved. Pressing Apply again writes nothing.

The acceptance scenario and the other scenarios run as backend API tests (`tests/test_schedule_api.py`). `backend/tests/test_frontend_fixture.py` checks that the frontend's captured fixture still matches the API (`UPDATE_FIXTURES=1` rewrites it). Live OpenAI calls are not covered by CI.

### Known limitations

- Allocation is greedy with bounded repair, not an optimal solver; deadline risk uses the capacity approximation above.
- Breaks are only reserved between work runs. A manual or locked session longer than the focus length is left as the user placed it; new work is never added to extend such a run.
- A requested break always starts now; a break at a later time should be added as an event.
- External calendar events are a snapshot from the last sync.

## Current scope

Sprint 1 includes Firebase login/signup (email/password and Google), password reset, logout, and account deletion; MongoDB task CRUD and completion; saved weekday availability and time zone; and the sketch-based workspace: a top bar (menu, month title, reminders bell, user menu with theme toggle), a Today's Tasks sidebar with Add Task, a day/week/month calendar, and an AI chatbox panel. New accounts start empty.

Tasks have a due date and an optional due time (11:59 PM if left blank), remaining duration, split limits, optional earliest start, and dependencies. The user can place **work sessions** manually or generate them with **Generate Schedule**. Sessions and breaks show as blocks in the time grid; proposed sessions are drawn dashed until Apply; locked/manual sessions are preserved when replanning.

**Events** (classes, meetings, appointments, meetups) are fixed blocks of time with an optional location and an optional weekly repeat until a last date. They block work sessions and auto-scheduling. Google Calendar and Outlook import is available on the Calendars page. Reminder delivery remains limited to the bell list for due today/tomorrow.

### Schedule persistence diagnostics

The API loads `backend/.env` relative to `app/config.py`, independent of the launch directory. Existing process environment variables take precedence. Task CRUD, schedule previews, and Apply use the same `app.state.db` connection; Firebase token verification remains unchanged.

Apply requires MongoDB transactions (a replica set or transaction-capable sharded deployment). It revalidates the preview and applies its removals, shortenings and inserts plus the preview status in one transaction with snapshot reads and majority write concern. It returns success only after commit; there is no in-memory or non-transactional fallback.

Older databases may have a unique, non-sparse `sessions.jti` index from token storage. Work sessions omit `jti`, so that index rejects additional work sessions with error 11000. Startup builds a partial unique index for documents where `jti` exists before removing the legacy index. It does not remove records or the legacy token TTL index, and token identifiers remain unique. This error does not require changing Atlas Network Access.

Database failures return a safe `detail`, a category in `code`, and a `reference` that matches the backend error log. The log includes the method, route, exception type, and MongoDB error code, without credentials, request bodies, or driver error text. Categories distinguish connectivity, database authentication, database permissions, uniqueness conflicts, document validation, unsupported transactions, and other operations. User authentication errors remain HTTP 401; database credentials/roles are backend configuration failures and do not sign users out.

Backend tests run with `cd backend && .venv/bin/pytest -q`. Set `TEST_MONGODB_URI` through your environment to a test-capable MongoDB replica set to exercise persistence and rollback. The fixture creates and cleans up uniquely named `aptest_*` databases; it never substitutes a production database name. Transaction tests skip mongomock and standalone MongoDB rather than pretending to verify persistence. Frontend checks: `cd frontend && npm test && npm run build`.
