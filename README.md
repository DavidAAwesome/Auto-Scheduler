# AutoPlan

React + TypeScript frontend, FastAPI backend, and MongoDB persistence for tasks and weekly availability. Sign-in uses **Firebase Authentication** (email/password and Google); the API verifies each request's Firebase ID token and stores data per Firebase user.

## Local setup

Prerequisites: Python 3.13, Node.js 24 LTS, and MongoDB (local, Docker, or Atlas). Run from the repository root. For an existing MongoDB deployment, skip Docker and set its URI in `backend/.env`.

```sh
docker run -d --name autoplan-mongo -p 127.0.0.1:27017:27017 -v autoplan-mongo-data:/data/db mongo:8
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
cp -n backend/.env.example backend/.env
cp -n frontend/.env.example frontend/.env
npm ci --prefix frontend
```

Firebase setup (once per team): in the Firebase console for the project, open **Authentication → Sign-in method** and enable **Email/Password** and **Google**. Put the web app's config values in `frontend/.env` (`VITE_FIREBASE_*`) and the same project ID in `backend/.env` as `FIREBASE_PROJECT_ID`. No service-account file is needed: the API only verifies ID tokens.

If you use MongoDB Atlas, add your current IP address under **Network Access**; otherwise the API fails at startup with an SSL handshake error.

Start the API in one terminal:

```sh
cd backend
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend in another terminal, from the repository root:

```sh
npm run dev --prefix frontend -- --host 127.0.0.1 --port 5173 --strictPort
```

Open <http://127.0.0.1:5173/#/signup> and create an account, or use **Continue with Google**. There are no built-in demo credentials. Stop any existing development server using these ports before starting another. To restart the persistent MongoDB container later, run `docker start autoplan-mongo`.

## Environment variables

Backend (`backend/.env`; never expose these with a `VITE_` prefix):

- `MONGODB_URI`: required connection URI; example `mongodb://127.0.0.1:27017`. Database credentials belong here only.
- `DATABASE_NAME`: MongoDB database, default `auto_scheduler`.
- `FIREBASE_PROJECT_ID`: required; must match `VITE_FIREBASE_PROJECT_ID`. Used to verify Firebase ID tokens.
- `ALLOWED_ORIGINS`: comma-separated exact frontend origins, without paths. Examples include localhost and 127.0.0.1 on ports 5173/5174. Wildcards are rejected.

Frontend (`frontend/.env`):

- `VITE_API_URL`: browser API base URL, default `/api`.
- `API_PROXY_TARGET`: Vite development proxy target, default `http://127.0.0.1:8000`.
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`: the Firebase web app config (public values).

Tests optionally read `TEST_MONGODB_URI`. Tests create randomly named databases prefixed `autoplan_auth_test_`, then delete only those databases. Use a dedicated local/test MongoDB instance with permission to create indexes and databases.

`.env` files are ignored by Git; committed `.env.example` files contain placeholders only. Production should serve the app and `/api` through the same HTTPS origin, forwarding `/api/auth/*` to backend `/auth/*`. Vite's development proxy is not a production deployment. `npm run preview` alone does not provide the API proxy.

## Authentication API

The frontend signs users in with the Firebase SDK and sends `Authorization: Bearer <Firebase ID token>` on every API request. The backend verifies the token's signature, project, and expiry, then upserts a `users` document keyed by the Firebase uid (`{_id: uid, email, name}`). Passwords never reach the API or MongoDB.

- `GET /auth/me`: returns `{id, name, email}` for the signed-in user; 401 without a valid token.
- `DELETE /auth/account`: deletes the user's tasks, availability, and profile, and returns 204. The frontend then deletes the Firebase account.
- `GET /protected`: returns the caller's uid (auth smoke test).

Browser mutations validate `Origin`; CORS permits only configured origins.

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

## Current scope

Sprint 1 includes Firebase login/signup (email/password and Google), password reset, logout, and account deletion; MongoDB task CRUD and completion; saved weekday availability and time zone; and the sketch-based workspace: a top bar (menu, month title, reminders bell, user menu with theme toggle), a Today's Tasks sidebar with Add Task, a day/week/month calendar, and an AI chatbox panel. New accounts start empty.

Tasks have a due date and an optional due time (11:59 PM if left blank). The user splits each task's work into **work sessions** on any days before it is due, by clicking an empty calendar slot, using "Plan work time", or from the task card. Sessions show as blocks in the time grid, and each task shows how much of its estimate is planned. Placing sessions automatically is future-sprint work.

**Events** (classes, meetings, appointments, meetups) are fixed blocks of time with an optional location and an optional weekly repeat until a last date, which covers a class schedule. They appear as solid teal blocks, are listed with work sessions in Today's Tasks, and block work sessions from being planned over them. One occurrence of a repeating event can be removed without deleting the series. External calendar sync and the scheduling engine belong to Sprint 2 (the Google/Outlook menu entries are placeholders). Reminder delivery and natural-language entry belong to Sprint 3 (the bell lists tasks due today/tomorrow; the chatbox is a placeholder).
