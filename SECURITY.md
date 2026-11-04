# Security

This repository is public. Every commit, issue, pull request and workflow log is visible to anyone and remains in history. Never commit credentials, user or customer data, Knowledge Base corpus or configuration, removal-request identifiers, operational data or production configuration.

## Report an issue

Use GitHub private vulnerability reporting when available, or contact the repository owner privately through an existing trusted channel. Do not open an issue containing credentials, customer data, browser exports or production configuration. Include a minimal reproduction using synthetic accounts and redact sensitive values.

## Configuration boundaries

- Values prefixed `VITE_` are compiled into browser code. They must never contain a secret.
- RevenueCat secret API keys belong only on the backend. Webhook authorization/signing secrets and the bridge HMAC belong only in the relevant server environment.
- Examples contain empty secret fields. Local `.env` files, database dumps, runtime SQLite state, backups, SSH keys and browser sessions must not be committed.
- Sandbox billing does not authorize live charges or change production quotas. Never bypass server-side entitlement verification.
- Tests and CI must use isolated databases and synthetic accounts, never production data or credentials.

## Before pushing

Review the exact staged files and complete Git history, not just the working tree. Run both independent secret scanners with result verification disabled; retain findings privately and never upload raw scanner reports. Review files that automated rules may miss: documentation, fixtures, metadata and dependency URLs.

The `Secret scan` workflow runs Gitleaks and TruffleHog on history with immutable tool versions and no credential-verification calls. It prints only counts and exit statuses. An inconclusive/failed scan is a failed gate, not a clean result.

If a secret is committed, stop publication. Revoke/rotate exposed credentials through the owner and remove the secret from all unpublished history. Deleting it in a later commit does not remove it from earlier commits. Never rewrite an already shared history without coordination.

## CI and deployment

Workflows use read-only repository permissions and hosted runners. They do not use production secrets or deploy automatically. Do not add an untrusted-code `pull_request_target` workflow or connect this repository to an existing production deployment without explicit approval.
