# AutoPlan frontend

React + TypeScript + Vite frontend for the AutoPlan workspace. The visual shell follows the prototype's warm neutral background, purple accents, and rounded cards.

## Run locally

Use Node.js 24 LTS (supported by the project's ESLint dependency).

```sh
npm ci
npm run dev
```

## Checks

```sh
npm run build
npm run lint
npm test
```

`npm run preview` serves the production build after `npm run build`.

## Navigation

The frontend uses hash URLs, matching the prototype. The initial URL opens Login. Available screens are `#/login`, `#/home`, `#/tasks`, `#/assistant`, `#/analytics`, `#/calendar`, `#/profile`, and `#/settings`. Browser back/forward navigation and direct links are supported without server rewrite rules. Unknown routes show a recovery link.

Each screen lives in `src/screens/`. Shared layout, icons, headings, and placeholder states live in `src/components/`. Global design tokens live in `src/index.css`; responsive layout styles live in `src/App.css`.

The desktop sidebar expands at widths above 1100px, becomes an icon rail on tablets, and becomes a dismissible menu at 640px and below. The mobile menu supports Escape, focus containment, and background scroll locking.

## Demo scope

Use `demo@autoplan.app` / `autoplan` on Login. `src/screens/LoginPage.tsx` matches the prototype’s two-column login, hiding the preview column at 760px and below. This is UI-only demo validation, not real authentication. The demo session is stored in sessionStorage (with a memory fallback); workspace views show Login while signed out. Profile’s “Log out of demo” and sidebar Sign out clear that session. Tasks support add, edit, complete/reopen, delete, case-insensitive title search, and All/Open/Done filters. Home and Calendar use the same task store; changes persist under `autoplan.demo.workspace.v2` in localStorage and synchronize on storage events across tabs. The first load seeds sample data; empty task lists stay empty after reload. Scheduling, analytics, external calendar connections, account editing, and settings remain future work. No API requests or backend changes are involved.

Typography uses Google Fonts (Manrope and DM Sans for the workspace; Outfit and DM Sans for Login), with system-font fallbacks when unavailable.

## Data and source verification

- `src/types/models.ts`: Task, Availability, CalendarEvent, ScheduledBlock, and workspace types.
- `src/data/sampleData.ts`: sample task labels, priorities, durations, categories, and calendar event; dates are relative to first use.
- `src/services/mockData.ts`: validation, CRUD, subscriptions, browser persistence, storage-error handling, and task selectors.
- `src/components/TaskForm.tsx`: shared accessible modal form with native field validation.
- `tests/mockData.test.ts`: store, search/filter, persistence, and error-path regression tests.

The repository did not contain the prototype's `app.js`. Its private source download was blocked by automatic approval review. Task fields and sample labels were verified from the normal prototype UI; exact source parity remains unverified. Availability, CalendarEvent, and ScheduledBlock are explicitly provisional contracts, not claimed transcriptions of that source. Supply the local `app.js` to reconcile these types and any remaining behavior differences. Demo state uses a separate versioned key from the unfinished earlier mock service; it does not overwrite that older key.
