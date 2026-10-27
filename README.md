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
- `OPENAI_API_KEY`: optional. Enables `/assistant/chat`, `/schedule/interpret` and AI reading of text and images in `/plan/interpret` via the OpenAI Responses API (without it, typed plans use the built-in parser and images are refused). Never commit a real key; leave blank to use structured scheduling without AI.
- `OPENAI_MODEL`: optional model id for those endpoints (default `gpt-4o-mini`; it must accept images for timetable photos).

Frontend (`frontend/.env`):

- `VITE_API_URL`: browser API base URL, default `/api`.
- `API_PROXY_TARGET`: Vite development proxy target, default `http://127.0.0.1:8000`.
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`: the Firebase Web app config. These are public identifiers, not secrets. If they are missing, the app shows a setup message instead of the login page.

Tests optionally read `TEST_MONGODB_URI`. Tests create randomly named databases prefixed `autoplan_auth_test_`, then delete only those databases. Use a dedicated local/test MongoDB instance with permission to create indexes and databases.

`.env` files are ignored by Git; committed `.env.example` files contain placeholders only. Production should serve the app and `/api` through the same HTTPS origin, forwarding `/api/*` to the backend with the `/api` prefix removed (for example `/api/auth/*` to `/auth/*` and `/api/avatars/*` to `/avatars/*`). Vite's development proxy is not a production deployment. `npm run preview` alone does not provide the API proxy.

## Authentication API

Signup, login, Google sign-in, password reset and logout happen in the browser through the Firebase SDK. Every API request sends `Authorization: Bearer <Firebase ID token>`.

- `GET /auth/me`: verifies the token, creates the MongoDB user on first sign-in (keyed by Firebase `uid`), keeps name/email in step with Firebase, and returns `{id, name, email, avatarUrl}`; 401 otherwise.
- `PUT /auth/avatar`: replaces the signed-in user's avatar with the raw image in the request body (`Content-Type: image/jpeg`, `image/png` or `image/webp`; at most 5 MB, checked against the file's own signature). Returns the profile with a new `avatarUrl` such as `/avatars/<random id>`. The image is stored in the `avatars` collection, separate from the user record, and the previous image is deleted only after the profile points at the new one. Errors: 413 (too large), 415 (wrong format), 401 (not signed in).
- `DELETE /auth/avatar`: removes the signed-in user's avatar and returns the profile.
- `GET /avatars/{id}`: serves an avatar image without a token (an `<img>` can't send one). Each upload gets a new unguessable id, so responses are cached as immutable. Firebase Storage is not used, so avatars work on the free Spark plan.
- `DELETE /auth/account`: deletes the user's tasks, work sessions, events, availability, plan, avatar images and user record, then returns 204. The frontend then deletes the Firebase account.
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

Work is placed in this order: **priority tier first** (High, Medium, Low), then earliest deadline, then earliest start, then task id, so ties always break the same way. Dependencies are respected (a task waits for the tasks it depends on; a cycle is reported as `dependency_cycle`). Deadline risk is calculated (`atRisk`, slack) and shown as a warning, but it **never overrides the priority you chose**: a Low task due tomorrow does not jump ahead of a High task due Friday.

After the earliest-fit pass, a bounded **local repair** looks at each task that is still short, in priority order. It may move unlocked, automatic, future sessions of the same or lower tier (at most 4 victims per attempt, 20 attempts in total, 6 per task), re-places the victims afterwards, and keeps the change only when the lexicographic score strictly improves: for each tier from High to Low, (number of fully scheduled tasks, which tasks are fully scheduled in deadline order, scheduled minutes). So a repair can never trade a High task for Medium work, or an earlier deadline for more total minutes. Locked, manual and in-progress sessions and all events are never moved. Displaced work keeps its task; its lost minutes are listed as unscheduled with the reason `displaced_by_priority`.

Minutes that cannot be placed are reported per task with reason codes (`deadline_passed`, `insufficient_capacity`, `daily_limit`, `no_contiguous_slot`, `unsplit_exceeds_focus_limit`, `beyond_planning_window`, `dependency_unallocated`, `displaced_by_priority`, and others). This is a heuristic: an unplaced task is **not** proof that no schedule exists. “Can this fit?” separates what is proven from what is not (below).

**Why not a solver?** OR-Tools is in `requirements.txt` but unused. At this project's scale (a student's week: tens of tasks, a few hundred five-minute slots per day) the deterministic heuristic plus bounded repair finishes in milliseconds and its decisions can be explained line by line. The focus/break rules (a run may cross task boundaries, a free gap counts as rest but a meeting does not, breaks are reserved during allocation) are awkward to express in CP-SAT, and an optimal-but-opaque answer would be harder to explain in chat. The cost is that the result is not guaranteed optimal; that is why only input-based facts are ever called proof.

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

Chat requests are parsed deterministically first and fall back to OpenAI only for intent classification: today's plan, busy time, generate, explain what didn't fit, request a break ("I need a 30-minute break now"), repair, and move a task. "Today's tasks" lists today's saved and proposed sessions, breaks and proposed events with their times, and lists deadlines separately. Proposed items are labelled as not saved. A message that lists tasks or events (several lines, or a length plus a date) goes to plan entry instead. "Add a task called …" is read by the same parser (so "due Friday at noon" stays 12:00 PM; with no time the deadline is the end of the day, shown as such) and offers **Confirm tasks** / **Edit** instead of saving a Medium task directly.

### Confirmations (pending actions)

Deleting tasks and saving drafts without scheduling are **pending actions** stored by the API (`app/pending_actions.py`), never a sentence the chat model has to remember. A proposal has an id, a type, the exact targets with their names (and, for deletions, how many scheduled sessions go with them), a validated payload, a version and a status (`awaiting_confirmation`, `processing`, `succeeded`, `cancelled`, `failed`). The chat shows buttons for it: **Delete task** / **Cancel**, **Confirm tasks** / **Edit**, and for a schedule preview **Apply schedule** / **Cancel**. Typing "confirm" runs the one open action through the same handler, or asks which one when several are open; "1" or "1 and 3" is resolved against the exact numbered list shown before.

- `POST /actions/delete-tasks` `{taskIds}` and `POST /actions/create-items` `{drafts, batchId}` propose; `GET /actions` lists open ones (they survive a refresh).
- `POST /actions/{id}/confirm` `{version}` runs it once: other users' ids are 404, a wrong version or a schedule change since the proposal is 409, the status moves to `processing` atomically so a double click cannot run it twice, and the change plus `succeeded` are written in one transaction. A repeat confirm returns `duplicate: true` and changes nothing. A failure is kept on the action with its message and can be retried.
- `POST /actions/{id}/cancel` changes nothing else.

## Plan entry: text and images → drafts → the same scheduler

The composer in the chat takes multi-line text (Enter sends, Shift+Enter adds a line) and an image attachment (JPG, PNG or WebP, up to 5 MB, checked by signature on the backend). The pipeline has separate stages; the model only reads input, and every time on the calendar comes from the engine:

1. **Interpretation** (`plan_extraction.py`): text or image → structured drafts. With `OPENAI_API_KEY`, the OpenAI Responses API returns structured output validated against a strict schema; times and dates come back as strings that the backend converts and checks itself. The prompt forbids guessing AM/PM, semester dates or recurrence bounds, and asks for the original wording of each row. Without a key, typed text is read by a deterministic built-in parser; images need the key and return a clear 503. Relative dates ("tomorrow", "Friday") are resolved against the server's current time in the user's timezone. Provider failures (rate limit, timeout, refusal, bad output) return 429/504/502/422 with the user's input kept in the composer.
2. **Review** (`plan_drafts.py`): business rules turn missing, ambiguous, unreadable or invalid fields into focused questions. A deadline is never treated as a scheduled date. Kinds are kept apart: a **flexible task** (work minutes, deadline, split rules), a **fixed event** (date or weekly repeat with first and last dates, start and end), and a **flexible event** (a length the engine places; one contiguous block unless splitting is allowed). A weekly class is never turned into a one-time event: without semester dates it stays blocked until they are given. Answers (in the chat or the panel) update the same draft through `/plan/clarify`.
3. **Scheduling and validation**: drafts go through the same service, engine and independent validator as Generate/Repair. Draft tasks appear as `draft:<id>` and draft fixed events as busy time.
4. **Preview and Apply**: the preview (mode `plan`) shows new sessions, reserved breaks, proposed events, moves, removals and unscheduled minutes. Apply creates the tasks, events and sessions in one transaction, after the usual staleness check. Each draft gets a unique `draft_key` (`owner:batch:draft`), so a double submit cannot save it twice.

### Can this fit?

`POST /plan/feasibility` changes no saved data (not even a stored proposal; the response says `savedDataChanged: false`). It runs the engine three times on one snapshot: saved work alone, the drafts with no displacement, and the drafts with bounded displacement. The status is one of:

- `fits_without_moving`: everything fits in unused time.
- `fits_after_changes`: everything fits if the listed lower-priority sessions move; their tasks are kept and any minutes they lose are listed.
- `no_plan_found`: the heuristic found no complete plan within the search limits. This is **not** proof.
- `proven_infeasible`: only when a cause follows from the inputs alone: a deadline already passed, an earliest start at or after the deadline, a dependency cycle, a one-piece item longer than the focus or daily limit, more work than all free time in its window (an upper bound ignoring every flexible session), no free block long enough for a one-piece item, or a fixed event overlapping another fixed commitment.

Each item lists its causes marked proven or not proven. The planning horizon and search limits are stated. Alternatives (allow splitting, a 21-day window, raise the priority) are offered as new previews; nothing is relaxed silently.

### Plan API

- `POST /plan/interpret` `{text, image?: {mediaType, dataBase64, name}, batchId}` → `{provider, drafts: [{draft, issues, ready}], notes, now, timeZone}`
- `POST /plan/review` `{drafts, horizonDays, batchId}` → reviewed drafts
- `POST /plan/clarify` `{draft, field, answer, otherDraftIds}` → the same draft, updated
- `POST /plan/feasibility` `{drafts, horizonDays}` → the result above
- `POST /plan/preview` `{drafts, horizonDays, batchId}` → a schedule preview (mode `plan`), applied with `POST /schedule/apply`

Drafts with open questions are refused with 422 by feasibility and preview. Only selected (ticked) items are checked: an unticked incomplete item never blocks the others, but a selected item may not depend on an unticked one. In the review panel, editing a field makes its value the answer: its "unclear" flag and question are cleared at once and the backend re-checks; an answer for drafts that changed meanwhile is ignored. Questions appear next to their fields, a summary links to each item that still needs something, and disabled buttons say what is missing. Not enough time is a scheduling result (a partial plan with its unscheduled minutes listed, which can be applied), not a question.

### Manual check (the acceptance scenario)

1. Set availability to 9 AM–12 PM every day in America/New_York.
2. Add **Asm** (High, 60 min) and **Test revision** (Medium, 60 min), both due tomorrow.
3. At 8 AM, click **Generate Schedule**. Expect: 9:00–9:50 Asm, 9:50–10:00 Break, 10:00–10:10 Asm, 10:10–10:50 Test revision, 10:50–11:00 Break, 11:00–11:20 Test revision.
4. Ask the chat "Today's tasks": the same six items are listed as proposed, and the deadlines appear as "Next due" tomorrow.
5. **Apply**, then refresh: the sessions are saved. Pressing Apply again writes nothing.

The acceptance scenario and the other scenarios run as backend API tests (`tests/test_schedule_api.py`). `backend/tests/test_frontend_fixture.py` checks that the frontend's captured fixture still matches the API (`UPDATE_FIXTURES=1` rewrites it). Live OpenAI calls are not covered by CI.

### Classroom demonstration (plan entry)

Offline, without a browser or database server: `cd backend && .venv/bin/python tests/plan_demo.py`. It walks through a bulk message (fit check, preview, Apply, a second Apply that writes nothing), a timetable image with a canned model answer (weekly classes, AM/PM and semester-date questions, answers updating the same draft), urgent High work displacing saved Low work, and a proven capacity shortfall.

In the app (MongoDB replica set needed for Apply):

1. Set availability to 9 AM–12 PM every day in America/New_York.
2. In the chat, type three lines and press Enter: `Lab report 90 min due tomorrow high priority`, `Advisor meeting today 11-11:30am`, `Gym 30 min sometime today, low priority`. The review panel above the calendar shows a task, a fixed event and a flexible event; nothing is saved.
3. Press **Can this fit?** (“fits without moving existing work”), then **Preview on calendar**. The calendar shows the dashed proposed sessions, the reserved break and the proposed meeting; ask the chat “Today’s tasks” to see the same items.
4. **Apply**, refresh, sign out and in: the tasks, the event and the sessions are still there. Pressing Apply twice writes nothing extra.
5. With `OPENAI_API_KEY` set, attach a timetable photo. Check that each class is weekly, that unclear times and missing semester dates are asked about, answer in the chat, then preview.
6. Add `Problem set 100 min due today 12pm high priority` on a day already planned with Low work, press **Can this fit?**, and see which sessions would move and how many minutes the Low task loses.

### Known limitations

- Allocation is a deterministic heuristic with bounded repair, not an optimal solver. “No plan found” is reported as such and never as proof.
- Breaks are only reserved between work runs. A manual or locked session longer than the focus length is left as the user placed it; new work is never added to extend such a run.
- A requested break always starts now; a break at a later time should be added as an event.
- External calendar events are a snapshot from the last sync.
- Plan entry: the built-in text parser handles common phrasings (lengths, “due Friday 5pm”, “11-11:30am”, “weekday evenings”, “after X”); anything else should be fixed in the review panel or read with the AI. Recurring drafts are weekly only. Images need `OPENAI_API_KEY`. Live OpenAI text and image extraction is not covered by automated tests (the model is mocked).
- A flexible event is placed once in the planning window; weekly flexible events are not supported yet.

## Current scope

Sprint 1 includes Firebase login/signup (email/password and Google), password reset, logout, and account deletion; MongoDB task CRUD and completion; saved weekday availability and time zone; and the sketch-based workspace: a top bar (menu, month title, reminders bell, user menu with theme toggle), a Today's Tasks sidebar with Add Task, a day/week/month calendar, and an AI chatbox panel. New accounts start empty.

Tasks have a due date and an optional due time (11:59 PM if left blank), remaining duration, split limits, optional earliest start, and dependencies. The user can place **work sessions** manually or generate them with **Generate Schedule**. Sessions and breaks show as blocks in the time grid; proposed sessions are drawn dashed until Apply; locked/manual sessions are preserved when replanning.

**Events** (classes, meetings, appointments, meetups) are fixed blocks of time with an optional location and an optional weekly repeat until a last date. They block work sessions and auto-scheduling. Google Calendar and Outlook import is available on the Calendars page. Reminder delivery remains limited to the bell list for due today/tomorrow.

### Schedule persistence diagnostics

The API loads `backend/.env` relative to `app/config.py`, independent of the launch directory. Existing process environment variables take precedence. Task CRUD, schedule previews, and Apply use the same `app.state.db` connection; Firebase token verification remains unchanged.

Apply requires MongoDB transactions (a replica set or transaction-capable sharded deployment). It revalidates the preview and applies its removals, shortenings and inserts plus the preview status in one transaction with snapshot reads and majority write concern. It returns success only after commit; there is no in-memory or non-transactional fallback.

Older databases may have a unique, non-sparse `sessions.jti` index from token storage. Work sessions omit `jti`, so that index rejects additional work sessions with error 11000. Startup builds a partial unique index for documents where `jti` exists before removing the legacy index. It does not remove records or the legacy token TTL index, and token identifiers remain unique. This error does not require changing Atlas Network Access.

Database failures return a safe `detail`, a category in `code`, and a `reference` that matches the backend error log. The log includes the method, route, exception type, and MongoDB error code, without credentials, request bodies, or driver error text. Categories distinguish connectivity, database authentication, database permissions, uniqueness conflicts, document validation, unsupported transactions, and other operations. User authentication errors remain HTTP 401; database credentials/roles are backend configuration failures and do not sign users out.

Backend tests run with `cd backend && .venv/bin/pytest -q`. Set `TEST_MONGODB_URI` through your environment to a test-capable MongoDB replica set to exercise persistence and rollback. A single-node replica set for local testing: `docker run -d --name autoplan-rs -p 127.0.0.1:27018:27017 mongo:8 --replSet rs0 --bind_ip_all`, then `docker exec autoplan-rs mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'` and `TEST_MONGODB_URI='mongodb://127.0.0.1:27018/?directConnection=true'`. The fixture creates and cleans up uniquely named `aptest_*` databases; it never substitutes a production database name. Transaction tests skip mongomock and standalone MongoDB rather than pretending to verify persistence. Frontend checks: `cd frontend && npm test && npm run build`.
