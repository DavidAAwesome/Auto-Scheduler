# Sprint 1 completion report

Date: 2026-10-05. Branch: `frontend-based-on-prototype`. Changes remain on the current branch, uncommitted. Existing uncommitted authentication work was preserved; no branch checkout, reset, commit, or push was performed.

## Inspection and initial status

Inspected React screens, task form/store/types, FastAPI routes and dependency injection, MongoDB connection/indexes, authentication, environment templates, tests, package scripts, and README files. No applicable AGENTS.md was found in the repository or checked ancestor locations.

- Login already used MongoDB, Argon2id, a unique email index, and revocable HttpOnly-cookie sessions. It was reused.
- Task actions already worked against browser storage; server persistence was missing.
- Availability settings were placeholders.
- Database integration covered accounts/sessions, but not tasks/settings.
- Calendar showed local task deadlines and sample events.

## Delivered

Added authenticated MongoDB task CRUD and completion routes and per-user weekly availability save/load. Existing authentication and database patterns remain the only active patterns. Queries always include the session-derived owner; unknown/foreign task IDs return the same 404. Request validation rejects injected owners, invalid dates/durations, malformed weekday sets, invalid timezones, and reversed time ranges.

Connected Tasks, Home, Settings, and Calendar to a shared API-backed store. Kept the existing sidebar/header, login design, task form, colors, cards, and responsive behavior. Added async pending/error handling; the UI updates after a successful server response. Account changes clear the loaded workspace, including protection against late responses. Calendar shows date-only deadlines, completion, and repeating weekday availability in the selected timezone, with week navigation and an all-date agenda.

## Files changed for this request

Backend:
- `backend/app/workspace.py` — new protected task/availability routes and validation.
- `backend/app/database.py` — task owner/deadline and unique availability-owner indexes.
- `backend/app/main.py` — register workspace routes and prevent caching private responses.
- `backend/tests/test_workspace.py` — CRUD, persistence, authentication, ownership, and validation tests.

Frontend:
- `frontend/src/services/workspaceStore.ts`, `workspace.ts` — shared API-backed store.
- `frontend/src/services/taskRules.ts` — extracted existing validation/filter logic.
- `frontend/src/services/authSession.ts` — reset/load server workspace on account changes.
- `frontend/src/services/mockData.ts` — reuse extracted rules; retain fixture-only demo behavior.
- `frontend/src/hooks/useWorkspace.ts`, `components/WorkspaceGate.tsx` — shared subscriptions and load/error UI.
- `frontend/src/App.tsx` — workspace load gate.
- `frontend/src/components/TaskForm.tsx` — await writes and show pending/errors.
- `frontend/src/screens/Tasks.tsx`, `Home.tsx` — use server tasks.
- `frontend/src/screens/Settings.tsx`, `Calendar.tsx`, `Planning.css` — availability form and responsive calendar.
- `frontend/src/types/models.ts`, `utils/calendar.ts` — weekly contract and date/time helpers.
- `frontend/tests/workspace.test.ts` — store/error/race/calendar tests.
- `README.md`, `frontend/README.md`, `SPRINT1.md` — setup, API contracts, report, disclosure.

Earlier uncommitted auth, login/signup/Profile, dependency, and environment-example changes remain in the working tree. They were not a new second implementation in this request.

## Commands and results

From the repository root, these checks were run:

```sh
TEST_MONGODB_URI=mongodb://127.0.0.1:27019 backend/.venv/bin/python -m pytest backend/tests -q
npm test --prefix frontend
npm run build --prefix frontend
npm run lint --prefix frontend
git diff --check
git branch --show-current
```

- Backend: 68 passed, including 34 against real MongoDB 8 and 34 against mongomock. No database checks skipped.
- Frontend: 14 passed, including legacy regression tests plus server-store persistence/error handling, stale-response isolation, and timezone/week calculations.
- TypeScript/production build and ESLint passed.
- Diff check initially found two trailing-whitespace lines; those were removed and the check rerun.
- Dependency deprecation/experimental warnings remain (Starlette/httpx, mongomock datetime, and Node's type stripping); they did not fail tests.

Restarted the previous local API process and launched the updated API on 127.0.0.1:8000 using runtime-only MONGODB_URI, DATABASE_NAME, and a generated JWT_SECRET. The existing Vite development server on 5173 proxied API traffic. Secrets were not written to tracked files or printed. No credentials were committed.

## Browser and database evidence

On the local verification environment:
1. Created a new account and confirmed its task list started empty.
2. Added a task, edited its title/duration to 90 minutes, and completed it.
3. Saved Monday 09:00–12:00 and Wednesday 09:00–15:00, America/New_York, and reminder preference.
4. Reloaded Settings; saved values remained.
5. Opened Calendar; the edited completed task appeared on Oct 7, with the correct weekday hours.
6. Logged out; visiting Tasks showed Login.
7. Logged back in; saved task completion was restored.
8. Created a second account and refreshed Tasks; the first account's task was absent.
9. Created/deleted a disposable task in the second account; it remained deleted after refresh.
10. Inspected desktop calendar (1440px) and mobile calendar/settings (390px). Restored the normal viewport.

A direct MongoDB check confirmed the browser-created first user's Argon2id hash, edited task and completion state, saved timezone/hours, and zero tasks/settings belonging to the second user after its disposable-task deletion. Backend tests additionally attempt foreign-ID GET/PUT/PATCH/DELETE operations and verify rejection without altering the owner's data.

## Remaining scope and limits

No known functional gaps remain against the five supplied Sprint 1 items in the tested local environment. This is a basic deadline/availability calendar, not automatic scheduling. External calendar sync and scheduling remain Sprint 2. Reminder delivery remains Sprint 3; only its preference is saved now. Availability supports one same-day window per weekday.

Testing used isolated local MongoDB, not Atlas or production infrastructure. The preview database on port 27019 is a temporary verification container; use the persistent Docker volume and stable environment secret in README for ongoing development. Existing browser-only prototype tasks are not automatically migrated. No production deployment or production credentials were tested. Instructor acceptance remains their decision.

## Codex disclosure draft — this request only

I used Codex to inspect the current AutoPlan repository and compare its implemented features with the supplied Sprint 1 checklist. For this work, Codex extended the existing FastAPI authentication/database pattern with protected MongoDB task and availability APIs, connected the React task screens to those APIs, implemented the availability form and basic calendar while preserving the prototype styling, and added validation and error handling. Codex wrote and ran automated frontend/backend tests, performed browser checks with local test accounts, inspected MongoDB test records to verify persistence and password hashing, fixed issues found during those checks, and drafted the setup/API documentation and this report. This statement describes only this Sprint 1 completion request; I will document earlier AI use separately.
