# Hardviser

Hardviser is a project workspace for product-development context, decisions, files, readiness, suppliers, intellectual-property records, funding, and work requests. It combines browser-local workspace data with optional authenticated API features. The in-app legal pages describe the preview and its limits; they are not executed customer agreements.

## Repository layout

- `src/` — React browser application and Vite entry point.
- `api/` — same-origin Vercel Functions for application, admin, chat, email sign-in, and sandbox billing operations.
- `backend/` — Python service components used by the API bridge and storage/retrieval features.
- `test/` — Node.js tests run by the root npm script.
- `public/` — static assets, including IBM Plex fonts and owner-provided artwork.

The browser stores some workspace data locally; it is not automatically synchronized between browsers. The application also has authenticated server-backed features when their API and external service configuration is available. Review the in-app Privacy & data handling page before entering information.

## Development

Use Node.js 18, 20, or 22 or newer (the locked Vite version's supported engine range), then install from the lockfile and use the repository scripts:

```sh
npm ci
npm test
npm run build
```

`npm run dev` starts the Vite browser app. `npm run preview` serves a built browser bundle. Neither Vite command runs the Vercel API Functions; the `/api/*` routes need the Vercel runtime (for local full-stack work, use the Vercel CLI's `vercel dev`). The root test command uses Node's built-in test runner and does not require production credentials.

## Hosting and configuration

`vercel.json` configures Vite, builds with `npm run build`, and publishes `dist/`. API requests are same-origin under `/api/`; the Vercel Functions call the separately operated Python bridge where required. The Vercel deployment configuration also keeps the app out of search indexing.

Environment variables belong to three different runtimes:

1. **Browser build (`VITE_*`)** — Vite embeds these values in public JavaScript. Never put a secret, private URL, or production credential in a `VITE_*` variable. The RevenueCat public key and Turnstile site key are public client values; leave their examples empty.
2. **Vercel Functions** — configure server-only values in the Vercel project environment, not in browser variables. This includes bridge authentication, email delivery, Turnstile verification, and feature switches.
3. **Python backend** — configure backend service values in that service's environment. Do not expose backend credentials or internal service identifiers to the browser.

See [`.env.example`](.env.example) for browser-build and Vercel API variable names. Backend-only settings and service setup are documented in [`backend/README.md`](backend/README.md), with the backend environment template at [`backend/.env.example`](backend/.env.example). Secrets and identifiers are intentionally empty; these files are references, not ready-to-run deployment files. Set only values for the relevant environment and never commit real credentials or private deployment identifiers.

### RevenueCat is sandbox-only

Billing in this codebase is restricted to RevenueCat's `sandbox` environment. The browser billing UI remains disabled until a sandbox environment and public key are configured. The API and Python service reject or require sandbox configuration; do not configure production RevenueCat credentials or use this repository for production billing.

## Legal and third-party notices

The application retains its functional Code of Conduct, NDA review draft, Terms, Privacy, and Intellectual Property pages. Public third-party and asset attribution is available in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and at [`/notices/THIRD_PARTY_NOTICES.txt`](public/notices/THIRD_PARTY_NOTICES.txt). IBM Plex's OFL text is retained at [`public/fonts/OFL.txt`](public/fonts/OFL.txt).

No license is granted: the source is published for reference, and all rights are reserved by its owner. The third-party notices do not grant a license to the Hardviser application, its brand artwork, or other owner-provided assets.
