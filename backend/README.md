# Backend

This directory contains the Hardviser Python API, ingestion worker, database migrations, tests, and the small Knowledge Base runtime import closure required by retrieval. Backend data, deployment secrets, model weights, and Knowledge Base databases are not part of this repository.

## Rights and provenance

`vendor/knowledge-base/` contains the retrieval subset of the project's own Knowledge Base source and the corresponding exact dependency locks. `vendor/knowledge-base/UPSTREAM.sha256` records upstream checksums for the unmodified files. Three vendored files have their runtime-root defaults changed to user-local portable paths, and `privacy.py` reads removal-request identifiers from private configuration instead of source. No open-source license is granted for this code; see the root README. `model.lock.json` identifies the exact upstream embedding model revision and asset checksums; the model weights themselves are downloaded locally and are not committed.

## Python and dependencies

Use CPython **3.10.12**. `.python-version` pins that interpreter. `requirements.in` lists direct dependencies and `requirements.lock` combines the complete pinned embedding runtime with pinned backend/test dependencies. The upstream PDF extraction lock carries a wheel hash and is installed separately with hash enforcement. PyTorch is pinned to its CPU build; the installer uses the PyTorch CPU wheel index and wheel-only installs.

From this directory, create a virtual environment with the pinned interpreter and install the lock:

```sh
uv python install 3.10.12
uv venv --python 3.10.12 --seed .venv
PYTHON=.venv/bin/python bin/install-deps.sh
```

The exact Python patch version is checked before installation and before tests/model preparation. Do not replace the lock with an unpinned package install.

## Pinned model setup

Set a user-local test/runtime Knowledge Base root, then prepare the exact model snapshot:

```sh
export HIS_APP_TEST_KB_ROOT="$HOME/.cache/hardviser-test/knowledge-base"
PYTHON=.venv/bin/python bin/setup-model.sh
```

Preparation downloads only the pinned `intfloat/multilingual-e5-small` revision. Its pinned model card declares `license: mit`; the exact card URL is in `vendor/knowledge-base/model.lock.json`.
The vendored encoder verifies upstream weight/tokenizer SHA-256 values, configuration Git blob IDs, Python/dependency versions, and the final artifact-manifest hash. It fails closed on mismatch; there is no fake encoder or alternate-model fallback.
Weights stay outside the repository under the selected root's `runtime/embeddings/` directory. Initial setup needs network access; later encoder use reads only the verified local artifacts.

## Disposable PostgreSQL tests

The full test suite requires PostgreSQL 16 with the `vector` extension. For local development, start an isolated `pgvector` container bound only to loopback. The `trust` auth mode below is for this disposable local container only; do not use it for a shared or production database.

```sh
docker run --rm --detach --name hardviser-pg-test \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --publish 127.0.0.1:5432:5432 \
  pgvector/pgvector:pg16
```

First run the isolated bootstrap guard smoke, then provision the exact disposable database, apply all backend migrations, and run the complete suite and HTTP smoke check. The bootstrap is fresh-cluster-only and runs once: it rejects an existing test database, app roles, or any non-system database without changing them.

```sh
bin/test-postgres-bootstrap-guard-smoke.sh
```

It creates a private, unexposed PostgreSQL container, checks both pre-existing-role and unrelated-database refusals, and removes that container. It needs Docker; `psql` client tools are required for the normal bootstrap and are installed by CI.

```sh
HIS_APP_TEST_DATABASE=hardissoft_app_test \
  HIS_APP_TEST_HOST=127.0.0.1 HIS_APP_TEST_PORT=5432 \
  bin/test-postgres-bootstrap.sh

HIS_APP_TEST_DATABASE=hardissoft_app_test \
  PYTHON=.venv/bin/python bin/test.sh

HIS_APP_TEST_DATABASE=hardissoft_app_test \
  .venv/bin/python bin/http-smoke.py
```

`test-postgres-bootstrap.sh` runs only after read-only preflight confirms a fresh PostgreSQL 16 cluster, the `vector` extension, and a superuser administrator. It refuses non-loopback hosts, any database name other than `hardissoft_app_test`, and any cluster that is not fresh; it never adopts, repairs, or drops an existing database or role. Run it once against the dedicated disposable PostgreSQL instance shown above. Tests truncate rows only in the named test database, using the `app_owner` role. Test operations connect as the restricted `app_runtime` role. The test runner clears inherited app, bridge, billing, and libpq environment variables, forces the local test database, and rejects a test Knowledge Base root containing PostgreSQL connection configuration. All tests run without skipped coverage. The HTTP smoke test uses the pinned model rather than an encoder fallback.

`http-smoke.py` loads the checksum-verified CPU model and exercises the real local API over signed HTTP. It creates two synthetic users in the verified test database, checks login and `/auth/me`, confirms a user's attempt to update the other user's project is hidden as `not_found`, and verifies billing sync fails closed with no RevenueCat configuration or entitlement write. It then deletes both fixture users; no provider credentials or MUSE call are used.

CI must provide the same PostgreSQL 16 + pgvector service, loopback-only access, and disposable database. Run the same interpreter, dependency install, model preparation, bootstrap, full-suite, and HTTP-smoke commands above; do not substitute unit-only selections or skip database/model coverage. Stop the local fixture when finished:

```sh
docker stop hardviser-pg-test
```

## Runtime configuration and data

`backend/.env.example` lists backend-only variable names with blank secrets and non-production defaults. It is a template, not a deployable configuration. In a deployment, keep the real environment file outside the repository with restrictive ownership and permissions. The bridge binds to loopback; expose it only through the separately configured application gateway. RevenueCat settings are deployment secrets; the sample environment selects sandbox mode and contains no identifiers or keys.

The application database defaults to loopback PostgreSQL, database `hardviser_app`, and restricted role `app_runtime`. Migrations are in `migrations/`. The bootstrap script in this directory is intentionally test-only; provision a deployment database and roles separately, then apply migrations with an authorized administrator. Never point the test bootstrap or test runner at a deployment database.

Actual retrieval also requires separately provisioned, authorized Knowledge Base runtime configuration and corpus data under `HIS_KB_ROOT`, including its private PostgreSQL connection configuration. Neither that configuration nor any corpus, database, model weight, bridge key, billing credential, or production identifier is included here. Tests use a user-local empty Knowledge Base root, not deployment data.

Exact removal-request identifiers (names or handles that must be redacted from retrieved text) are personal data, so they are deployment configuration, not source. Store them as a JSON array of strings in `$HIS_KB_ROOT/config/privacy-request-identifiers.json` with the rest of the private Knowledge Base configuration; use `[]` when no removal request applies. The file is required: retrieval fails while it is missing, unreadable or malformed, so a deployment cannot silently drop requested redactions. `bin/test.sh` creates `[]` in its empty test root.

The `systemd/` files are generic unit examples. They use `/opt/hardviser/backend`, `/etc/hardviser/backend.env`, and `/var/lib/hardviser`; review and adapt them before installing. They are not enabled or started by repository scripts. The backup service has no default remote destination: encrypted offsite upload requires an explicit age recipient, rclone destination, and systemd-provided rclone credential. The backup archive includes the configured private backend environment file, so protect local snapshots and configure encrypted offsite storage before enabling its timer.

`bin/retrieval_load.py` is for authorized isolated staging only. It can create real database load and must never be pointed at production.
