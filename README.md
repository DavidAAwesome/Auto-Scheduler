# AutoPlan

React + TypeScript frontend, FastAPI backend, and MongoDB persistence for accounts, tasks, and weekly availability. The existing auth module and database connection now handle accounts and sessions. The unfinished Firebase path and hardcoded demo login have been removed.

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

Generate a signing secret, then put the result in `JWT_SECRET` in `backend/.env`:

```sh
backend/.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(48))'
```

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
- `JWT_SECRET`: required random secret, at least 32 characters. Placeholders are rejected. Changing it signs everyone out.
- `SESSION_SECONDS`: lifetime, default `604800` (7 days), allowed range 60–2592000.
- `COOKIE_SECURE`: `false` for local HTTP; `true` for production HTTPS.
- `ALLOWED_ORIGINS`: comma-separated exact frontend origins, without paths. Examples include localhost and 127.0.0.1 on ports 5173/5174. Wildcards are rejected.

Frontend (`frontend/.env`):

- `VITE_API_URL`: browser API base URL, default `/api`.
- `API_PROXY_TARGET`: Vite development proxy target, default `http://127.0.0.1:8000`.

Tests optionally read `TEST_MONGODB_URI`. Tests create randomly named databases prefixed `autoplan_auth_test_`, then delete only those databases. Use a dedicated local/test MongoDB instance with permission to create indexes and databases.

`.env` files are ignored by Git; committed `.env.example` files contain placeholders only. Production should serve the app and `/api` through the same HTTPS origin, forwarding `/api/auth/*` to backend `/auth/*`. Vite's development proxy is not a production deployment. `npm run preview` alone does not provide the API proxy.

## Authentication API

- `POST /auth/signup`: JSON `{name, email, password}`; returns 201 and `{id, name, email}`, and signs in. Passwords must be 8–128 characters and cannot be all whitespace.
- `POST /auth/login`: JSON `{email, password}`; returns 200 and the public user. Invalid credentials return 401 with a generic error.
- `GET /auth/me`: returns the signed-in public user, or 401.
- `POST /auth/logout`: revokes the current MongoDB session, clears the cookie, and returns 204. Repeated logout is safe.
- `GET /protected`: existing protected endpoint; requires a valid, unrevoked session and returns the current user's ID.

Emails are trimmed and lowercased with a MongoDB unique index. Duplicate signup returns 409. Passwords use salted Argon2id hashes; responses exclude passwords and hashes. Sessions use HS256 JWTs in an HttpOnly, SameSite=Lax cookie and a MongoDB session record. Expired/revoked sessions are rejected independently of TTL cleanup. The existing bearer dependency accepts the same tokens; the frontend uses cookies and never stores tokens in localStorage. Browser mutations validate Origin; credentialed CORS permits only configured origins.

The frontend restores sessions from `/auth/me` after refresh, gates workspace screens, shows API errors, and supports logout from Profile and the sidebar. Name and email stay on Profile. Signup shares the responsive two-column Login design.

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
