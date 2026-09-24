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
```

`npm run preview` serves the production build after `npm run build`.

## Navigation

The frontend uses hash URLs, matching the prototype. The initial URL opens Login. Available screens are `#/login`, `#/home`, `#/tasks`, `#/assistant`, `#/analytics`, `#/calendar`, `#/profile`, and `#/settings`. Browser back/forward navigation and direct links are supported without server rewrite rules. Unknown routes show a recovery link.

Each screen lives in `src/screens/`. Shared layout, icons, headings, and placeholder states live in `src/components/`. Global design tokens live in `src/index.css`; responsive layout styles live in `src/App.css`.

The desktop sidebar expands at widths above 1100px, becomes an icon rail on tablets, and becomes a dismissible menu at 640px and below. The mobile menu supports Escape, focus containment, and background scroll locking.

## Demo scope

Use `demo@autoplan.app` / `autoplan` on Login, or choose the preview link. This is local demo validation, not authentication; workspace routes are intentionally publicly accessible. Sign out returns to the Login screen. All screen data is placeholder content, and no API requests or backend changes are involved. Tasks, planning, analytics, calendar connections, account editing, and settings are not implemented yet.

Typography uses Google Fonts (Manrope and DM Sans), with system-font fallbacks when unavailable.
