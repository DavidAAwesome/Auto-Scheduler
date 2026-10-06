# AutoPlan

React + TypeScript frontend, FastAPI backend, and MongoDB persistence for accounts, tasks, and weekly availability. Firebase Authentication handles sign-in (email/password and Google); the API verifies Firebase ID tokens and keeps each user's data in MongoDB.

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

In the [Firebase console](https://console.firebase.google.com/), open your project and:

1. Under **Authentication → Sign-in method**, enable **Email/Password** and **Google**.
2. Under **Authentication → Settings → Authorized domains**, make sure `localhost` and `127.0.0.1` are listed.
3. Under **Project settings → Your apps**, add a Web app if needed and copy its config values into the `VITE_FIREBASE_*` keys in `frontend/.env`.
4. Set `FIREBASE_PROJECT_ID` in `backend/.env` to the same project ID.

Start the API in one terminal:

```sh
cd backend
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend in another terminal, from the repository root:

```sh
npm run dev --prefix frontend -- --host 127.0.0.1 --port 5173 --strictPort
```

Open <http://127.0.0.1:5173/#/signup> and create an account. There are no built-in demo credentials. Stop any existing development server using these ports before starting another. To restart the persistent MongoDB container later, run `docker start autoplan-mongo`.

## Environment variables

Backend (`backend/.env`; never expose these with a `VITE_` prefix):

- `MONGODB_URI`: required connection URI; example `mongodb://127.0.0.1:27017`. Database credentials belong here only.
- `DATABASE_NAME`: MongoDB database, default `auto_scheduler`.
- `FIREBASE_PROJECT_ID`: required; the Firebase project whose ID tokens the API accepts. Must match `VITE_FIREBASE_PROJECT_ID`.
- `ALLOWED_ORIGINS`: comma-separated exact frontend origins, without paths. Examples include localhost and 127.0.0.1 on ports 5173/5174. Wildcards are rejected.

Frontend (`frontend/.env`):

- `VITE_API_URL`: browser API base URL, default `/api`.
- `API_PROXY_TARGET`: Vite development proxy target, default `http://127.0.0.1:8000`.
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`: the Firebase Web app config. These are public identifiers, not secrets. If they are missing, the app shows a setup message instead of the login page.

Tests optionally read `TEST_MONGODB_URI`. Tests create randomly named databases prefixed `autoplan_auth_test_`, then delete only those databases. Use a dedicated local/test MongoDB instance with permission to create indexes and databases.

`.env` files are ignored by Git; committed `.env.example` files contain placeholders only. Production should serve the app and `/api` through the same HTTPS origin, forwarding `/api/auth/*` to backend `/auth/*`. Vite's development proxy is not a production deployment. `npm run preview` alone does not provide the API proxy.

## Authentication API

Signup, login, Google sign-in, password reset and logout happen in the browser through the Firebase SDK. Every API request sends `Authorization: Bearer <Firebase ID token>`.

- `GET /auth/me`: verifies the token, creates the MongoDB user on first sign-in (keyed by Firebase `uid`), keeps name/email in step with Firebase, and returns `{id, name, email}`; 401 otherwise.
- `DELETE /auth/account`: deletes the user's tasks, availability, plan and user record, then returns 204. The frontend then deletes the Firebase account.
- `GET /protected`: requires a valid token and returns the current user's ID.

The API checks the token's RS256 signature against Google's published keys, plus its expiry, audience (`FIREBASE_PROJECT_ID`) and issuer. It returns 503 if Google's keys can't be fetched. Firebase manages passwords; MongoDB stores none. Browser mutations validate Origin, and CORS permits only configured origins.

The frontend restores sessions through Firebase on refresh, gates workspace screens, shows API errors, and supports logout from Profile and the sidebar. Name and email stay on Profile. Signup shares the responsive two-column Login design.

## Validation

From the repository root:

```sh
npm run build --prefix frontend
npm run lint --prefix frontend
npm test --prefix frontend
cd backend
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 .venv/bin/python -m pytest -q
```

Without `TEST_MONGODB_URI`, mock-database tests run and real-MongoDB tests explicitly skip. Coverage includes signup persistence/hash verification, unique emails, wrong passwords, validation, current user, forged/expired/revoked tokens, session rotation, logout replay rejection, user isolation, cookie flags, and CORS/origin checks.

Sprint 1 verification: 68 backend tests passed (34 mock, 34 real MongoDB 8), plus 14 frontend tests, lint, and production build. Browser checks covered signup, login, task creation/edit/completion/deletion, availability save/load, refresh, calendar display, logout, and a second account with no access to the first account’s data. MongoDB records from the browser-created accounts were inspected directly. No Atlas or production deployment has been tested. See [SPRINT1.md](SPRINT1.md) for the detailed report and Codex disclosure draft.

## Workspace API

All workspace routes use the existing authentication dependency. Owners are taken only from the session; extra input fields such as `user_id` are rejected. Responses have `Cache-Control: no-store`.

- `GET /tasks`: current user's tasks, ordered by deadline.
- `POST /tasks`: create `{title, deadline, minutes, priority, category}`; returns 201 with task `{id, title, deadline, minutes, priority, category, done}`.
- `GET /tasks/{id}`: get an owned task.
- `PUT /tasks/{id}`: edit its fields, preserving completion.
- `PATCH /tasks/{id}/completion`: `{done: true}` or `{done: false}`.
- `DELETE /tasks/{id}`: delete owned task; returns 204.
- `GET /availability`: saved settings, or defaults (all days disabled, UTC, reminders off).
- `PUT /availability`: save `{days, timeZone, reminders}`. Each day has `{day, enabled, start, end}`. Include all seven weekdays exactly once, Monday=0 through Sunday=6. Start/end are integer minutes after midnight. End must follow start and may equal 1440 (24:00). Overnight windows are not supported. `timeZone` is a valid IANA identifier.

Unknown tasks and tasks owned by other users both return 404. Missing or revoked authentication returns 401. Invalid input returns 422. MongoDB creates an owner/deadline index for tasks and a unique owner index for availability at startup. Calendar derives its view from the same tasks and settings; it needs no separate duplicate database collection.

## Current scope

Sprint 1 includes real login/signup/logout, MongoDB task CRUD and completion, saved weekday availability/timezone, and a responsive weekly calendar plus deadline agenda. Name and email remain on Profile. New accounts start empty. The production app no longer imports the old browser demo store; it is retained only for prototype fixtures and regression tests. Existing localStorage tasks are not automatically migrated or uploaded.

The calendar displays due dates and recurring available hours; it does not allocate tasks into time slots. External calendar sync and the scheduling engine belong to Sprint 2. Reminder preferences save, but actual reminders belong to Sprint 3. Assistant and Analytics remain placeholders. Password reset and email verification are not implemented and are outside the supplied Sprint 1 checklist.

The current verification preview uses temporary local MongoDB on port 27019, with a runtime-generated signing secret. For durable local use, follow Local setup above: its MongoDB container uses a named data volume and `backend/.env` preserves the signing secret. Do not treat the temporary verification container as your permanent project database.
