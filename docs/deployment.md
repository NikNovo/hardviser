# Manual deployment

Publishing this repository does not deploy it. CI runs tests and secret checks only. Connecting GitHub to an existing Vercel project, changing production settings, enabling live payments or applying database migrations requires a separate approved release.

## Components and configuration

- The repository root is the Vite application plus Vercel API functions in `api/`. Keep the Vercel root directory at the repository root. Build with `npm run build`; output is `dist/`.
- The Python bridge and ingestion worker are separate services. Follow `backend/README.md` for the pinned dependencies, model prerequisites, database initialization and service templates. The backend is not included in the Vercel upload.
- Supply deployment values through the hosting environment or mode-0600 private files. `.env.example` files document names but are not deployable credentials. Preserve their browser/server boundaries.
- The Vercel bridge URL must be an HTTPS origin without credentials, query, fragment or path suffix. The API code appends `/v1/public-rag/chat` and the operation path itself.
- `SEVERUS_RAG_BRIDGE_HMAC_KEY` is the same 32-byte key, encoded as 64 lowercase hexadecimal characters, on the bridge and Vercel. Generate it privately, never in browser variables or command output.
- Keep the bridge on a private/listen-loopback interface and publish only the intended signed route through your approved reverse proxy. Do not expose PostgreSQL or runtime files.
- Configure email delivery, the permitted authentication origin and Turnstile with your own provider accounts. Do not copy another environment's secrets, customer identities or site configuration.

## RevenueCat sandbox

1. Configure a dedicated sandbox app and the monthly `plans` offering. Packages are `pro`, `ultra_pro`, and `max`, with products `pro_monthly`, `ultra_pro_monthly`, and `max_monthly`. This client rejects trial/promotional price phases.
2. Set the browser public key and sandbox environment only through the public variables documented in the root template. The SDK must also identify its environment as sandbox.
3. Set the backend API v2 read key, canonical project ID, app ID and sandbox environment through `backend/.env.example`'s server-only names. The backend key does not belong in Vercel build variables.
4. Apply migration `006_sandbox_billing.sql` after the preceding application migrations, using the migration owner role. Record its marker transactionally. Do not run a full production bootstrap script merely to apply one migration.
5. Create a webhook at the public site origin plus `/api/revenuecat-webhook`, restricted to the dedicated app and **Sandbox only**. Do not use a deployment URL protected by a hosting login gate.
6. Set a newly generated Authorization value and enable HMAC signing. Store the exact provider signing secret and Authorization value in Vercel's server-only environment. Changing Vercel environment values requires rebuilding/redeploying the function.
7. Send a real provider TEST event and verify HTTP 200 plus durable ignored-event storage. Incorrect signatures must return 401; a TEST event must not grant access.
8. Enable the bounded recovery timer described in the backend documentation, with the same database/configuration/import path as the bridge. Observe its result before relying on unattended recovery.

The browser's successful checkout result is not an entitlement grant. Server-side provider verification is authoritative. Sandbox status does not enable live charges, AI credits, consultations or different production quotas. Live billing needs its own approved commercial and technical rollout.

## Release and rollback

- Record the current frontend deployment and actual backend import path; inspect the running service rather than trusting an old directory name.
- Preserve a verified application backup, private configuration, source snapshot and replay-state backup before database/service changes. Keep backups outside the repository.
- Drain in-flight requests before switching the bridge. Preserve unrelated proxy routes and services.
- Use bounded lock/statement timeouts for migrations. Verify table ownership and runtime privileges after commit.
- Confirm an actual HTTP listener and the current process's completed retrieval-index warm-up, not just `systemctl active`.
- Verify the public application, account isolation, billing status and webhook signature gates. Exercise only explicitly approved synthetic accounts; do not make paid AI calls or purchases as an implicit smoke test.
- Roll back a compatible frontend/backend pair if required. Keep additive schema and audit history. Never restore old database or replay-state snapshots over newer user activity merely to undo a code deployment.
