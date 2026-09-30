# MailFlow

MailFlow is a reliable email scheduling and delivery platform. This repository contains a TypeScript workspace, PostgreSQL/Prisma source of truth, Google sign-in with database-backed sessions, durable BullMQ scheduling, Ethereal delivery, distributed timing limits, and Elasticsearch delivery search.

## Requirements

- Node.js 24 or newer and npm 11 or newer
- Docker Desktop with the WSL 2 backend on Windows, or Docker Engine and the Compose plugin on Linux/macOS
- Enough Docker memory for Elasticsearch (allow at least 2 GB for the local service stack)

The frontend uses port `5173`, the API uses `4000`, PostgreSQL uses `5432`, Redis uses `6379`, and Elasticsearch uses `9200` by default. Ports can be changed in the root `.env` file.

For Google sign-in, create an OAuth 2.0 **Web application** client in Google Cloud Console. Register the exact redirect URI configured by `GOOGLE_REDIRECT_URI`; the local default is `http://localhost:4000/api/auth/google/callback`. Add the client ID, client secret, redirect URI, and a unique random `GOOGLE_OAUTH_STATE_SECRET` of at least 32 characters to root `.env`. The local frontend origin defaults to `http://localhost:5173`.

## Local infrastructure

Copy `.env.example` to `.env` in the repository root. The example values are for local development only; replace passwords and configure access controls before using any shared environment.

Start PostgreSQL, Redis, and Elasticsearch:

```sh
npm run infra:up
```

Check service status and logs:

```sh
docker compose ps
npm run infra:logs
```

Stop the containers while keeping their named data volumes:

```sh
npm run infra:down
```

The Compose file uses named volumes for PostgreSQL and Elasticsearch data. Redis runs with append-only persistence (`appendonly yes`, `appendfsync everysec`) and a named data volume. Elasticsearch runs as a single local development node with security disabled and its port bound to loopback; do not expose this development configuration to a network. Elastic recommends pinning a specific image version and binding its data volume; this project pins `9.5.4` and uses a named volume.

On Linux or WSL, Elasticsearch can require a larger `vm.max_map_count` setting. If its container exits during startup, inspect `docker compose logs elasticsearch` and follow Elastic's host requirements before retrying.

## Environment files

- Root `.env.example` is the canonical infrastructure and API example used by Compose and the API/worker development commands.
- `backend/.env.example` lists API-specific settings.
- `worker/.env.example` lists worker-specific settings.
- `frontend/.env.example` contains only the public browser API origin. Copy it to `frontend/.env.local` if you need to change the Vite value; never put server secrets in frontend variables.

The API and worker validate `DATABASE_URL`, `REDIS_URL`, `ELASTICSEARCH_URL`, `API_PORT`, `LOG_LEVEL`, and `NODE_ENV` at startup. Invalid configuration exits with field-level messages and never prints secret values.

`ELASTICSEARCH_API_KEY` is optional for secured Elasticsearch deployments. Local Compose has security disabled, so it is not required.

Campaign scheduling and delivery use `MIN_DELAY_MS` (minimum sender spacing), `MAX_EMAILS_PER_HOUR_PER_SENDER` (per-user hourly ceiling), `MAX_RECIPIENTS_PER_CAMPAIGN`, `WORKER_CONCURRENCY` (default `10`), and `DELIVERY_MAX_ATTEMPTS` (default `3`). Each campaign's `hourlyLimit` is an additional hourly ceiling.

## Prisma and PostgreSQL data model

The Prisma schema is in `backend/prisma/schema.prisma`; the migration history is in `backend/prisma/migrations`. Prisma Client is generated from the schema into `backend/src/generated/prisma` before backend builds and type checks.

```sh
npm run db:generate --workspace @mailflow/api
npm run db:migrate:dev --workspace @mailflow/api -- --name init
npm run db:migrate:status --workspace @mailflow/api
npm run test:db --workspace @mailflow/api
```

The backend scripts read the root `.env`. User-owned records carry ownership relations, and the data access helpers require an owner ID for campaign and delivery lookups. PostgreSQL foreign keys and unique constraints provide referential integrity and duplicate prevention.

## Install and run

Install workspace dependencies from the repository root:

```sh
npm install
```

Run all three development processes:

```sh
npm run dev
```

Or run one process at a time:

```sh
npm run dev:api
npm run dev:worker
npm run dev:frontend
```

The API and worker both replay pending PostgreSQL queue-outbox rows to BullMQ at startup and when the Redis connection becomes ready again. The worker consumes due jobs and sends individual messages through the configured Ethereal SMTP account.

## API probes

- `GET http://localhost:4000/health` is a liveness check. It returns HTTP 200 while the API process can respond.
- `GET http://localhost:4000/ready` checks PostgreSQL, Redis, and Elasticsearch. It returns HTTP 200 when PostgreSQL and Redis are reachable, and includes the Elasticsearch state in the response; it returns HTTP 503 when a required delivery dependency is unavailable.

Elasticsearch is an optional search projection for readiness: `/ready` returns HTTP 200 while PostgreSQL and Redis are healthy, and reports Elasticsearch separately if it is unavailable. This keeps the worker and scheduling API available during a search outage.

## Operations dashboard and diagnostics

The BullMQ Board is available locally at `http://localhost:4000/admin/queues` after signing in with Google. The route and all Board API/static routes require the existing MailFlow session cookie. The Board is read-only; it cannot pause, retry, remove, or otherwise mutate jobs. It shows the `mailflow-email-deliveries` queue and its waiting, delayed, active, completed, and failed jobs. Queue payloads contain the delivery UUID only; recipient addresses and message bodies remain in PostgreSQL and owner-scoped APIs.

The API exposes a lightweight liveness endpoint at `/health` and dependency readiness at `/ready`. Readiness reports PostgreSQL, Redis, and Elasticsearch independently. PostgreSQL and Redis determine `ready` because they are required to accept and process delivery work; Elasticsearch is an optional search projection, so its outage appears as `elasticsearch: "error"` without making the service unready. Health and readiness responses contain no credentials.

The worker concurrency is configured with `WORKER_CONCURRENCY` (default `10`). `DELIVERY_MAX_ATTEMPTS` is validated from `1` to `10` (default `3`) and uses exponential backoff beginning at `max(1000ms, MIN_DELAY_MS)`. Retries are bounded; SMTP outcomes that may have crossed the submission boundary remain `delivery_unknown` and are not resent automatically. BullMQ uses a 7-day age threshold / 10,000-job target for completed jobs and a 30-day age threshold / 20,000-job target for failed jobs. Age cleanup is opportunistic during job finalization, so jobs can remain longer when the queue is idle. PostgreSQL remains the durable status/history source while the Board provides a bounded operational view during continued processing.

Structured JSON logs identify the service and include queue/job/delivery/campaign/user identifiers where available. Useful event messages include queue connection/reconciliation, worker active/completed/stalled/retried jobs, timing deferrals, SMTP outcomes, search indexing failures, and Slack alert failures. Passwords, OAuth/client secrets, tokens, cookies, and connection strings are redacted or omitted; message bodies are not logged.

Run operational endpoint, Board access, queue visibility, and retention checks with:

```sh
npm run test:operations --workspace @mailflow/api
```

The Redis durability/reconnect probe is `npm run test:redis-restart --workspace @mailflow/api`. It intentionally restarts the local Compose Redis container, then checks the delayed job and worker recovery; run it when no other local work depends on Redis.

## Integrated verification (Phase 11)

Run the isolated 1,000-recipient API-to-database-to-BullMQ test with `npm run test:load --workspace @mailflow/api`. It creates a temporary test user, schedules future-dated jobs without starting an SMTP worker, verifies delivery/outbox/queue counts and deterministic due times, and removes only that test user's jobs and records. No external email is sent. Duplicate recipients are included; an invalid-recipient request is expected to return 400 without persisting a campaign.

Worker integration tests use an injected in-memory SMTP transport seam. `WORKER_CONCURRENCY` is exercised with concurrent workers; distributed sender/campaign limits, UTC deferral, spacing, and reservation replay are covered by `npm run test:rate-limits --workspace @mailflow/worker`. Restart probes cover worker replacement and Redis restart (`npm run test:redis-restart --workspace @mailflow/api`), PostgreSQL persistence/live-client recovery (`npm run test:postgres-restart --workspace @mailflow/api`), and API handoff replay in scheduling tests. The production worker still uses configured Ethereal SMTP. PostgreSQL/job idempotency and delivery claims prevent repeated known sends, while an uncertain result after SMTP submission begins becomes `delivery_unknown`; SMTP cannot promise mathematical exactly-once delivery.

Measured 1,000-recipient run in this environment: **1,002 submitted → 1,000 accepted** (2 duplicates removed); **1,000 PostgreSQL delivery rows, 1,000 enqueued outbox rows, and 1,000 BullMQ jobs**, with 0 handoff failures. The API request took **1,927.33 ms**, count queries **58.22 ms**, queue job lookups **53.33 ms**, and the measured test body **2,291.79 ms**. This test leaves all jobs delayed in the future and sends no email. Run the existing workspace suites with their named `test:*` scripts, followed by `npm run typecheck` and `npm run build`.

## Google sign-in and sessions

The API exposes `GET /api/auth/google/start` to begin the Google authorization-code flow, `GET /api/auth/google/callback` to validate state/PKCE and the Google identity token, `GET /api/auth/me` to return the current MailFlow user, and `POST /api/auth/logout` to revoke the current session. The API stores only the Google subject, email, name, and avatar URL; Google access/refresh tokens are not retained. OAuth state, nonce, and the PKCE verifier are encrypted in a short-lived HttpOnly, SameSite=Lax callback cookie. MailFlow session tokens are random opaque values in HttpOnly, SameSite=Lax cookies while only their SHA-256 hashes are stored in PostgreSQL. Sessions expire after `SESSION_TTL_HOURS` (default 168 hours) and logout records revocation. In production cookies are Secure and `FRONTEND_ORIGIN` must match the deployed frontend origin.

Until the Google settings are configured together, the Google start endpoint returns HTTP 503; no mock login is provided. The React frontend uses the real sign-in endpoint, loads `/api/auth/me`, displays the signed-in profile, and revokes the session on logout.

## Frontend user flows

The responsive React + TypeScript + Tailwind frontend provides the Google sign-in screen and authenticated workspace pages for overview, campaign composition, scheduled deliveries, sent/failed deliveries, Elasticsearch search, and Slack settings. Run it with `npm run dev:frontend`; set the public `VITE_API_BASE_URL` in `frontend/.env.local` only when the API is not at `http://localhost:4000`.

The composer accepts CSV files with an `email` column and plain text files with line, comma, or semicolon separators. It shows valid unique addresses, invalid entries, duplicates, and the total detected count before scheduling. Invalid addresses prevent submission. Campaign creation calls the authenticated `POST /api/campaigns` endpoint; queue timing remains backend-owned.

Delivery lists use the authenticated `/api/deliveries` endpoint and server pagination. Search uses `GET /api/deliveries/search` with recipient, subject, status, date range, and pagination filters. Slack settings use the real OAuth start route and the authenticated connection, channel, save, and disconnect endpoints. Browser requests include the HttpOnly application session cookie; no OAuth or Slack secret is included in frontend configuration.

The frontend parser tests run with `npm test --workspace @mailflow/frontend`.

All other `/api/*` application routes and the reserved `/admin/queues/*` route require a valid application session. The BullMQ dashboard itself is not part of this phase.

Run the auth integration checks against the configured PostgreSQL database:

```sh
npm run test:auth --workspace @mailflow/api
```

## Campaign scheduling and queue handoff

Authenticated scheduling endpoint:

- `POST /api/campaigns` accepts `subject`, `body`, `recipients`, `startAt` (ISO 8601 with timezone), `delayMs`, and `hourlyLimit`.
- `GET /api/campaigns?page=1&pageSize=25` lists only the signed-in user's campaigns.
- `GET /api/campaigns/:campaignId/deliveries?page=1&pageSize=25&status=scheduled` lists deliveries for an owned campaign.
- `GET /api/deliveries?page=1&pageSize=25&status=scheduled&campaignId=...` lists the signed-in user's deliveries.

The API trims and lowercases recipients for deduplication, then creates the campaign, per-recipient delivery records, and pending queue-outbox records in one PostgreSQL transaction. Each unique delivery is assigned its own due time (`startAt + position × delayMs`) and deterministic BullMQ job ID. The outbox handoff adds delayed jobs in batches and marks rows enqueued only after Redis acknowledges the add. If the process stops after the database commit, startup reconciliation replays pending rows; deterministic job IDs and retained BullMQ job records make a repeated add converge on the same job. PostgreSQL remains the durable source of truth.

Redis outages do not roll back an accepted database schedule. The API leaves the outbox row pending and retries on startup or Redis reconnection. There is no cron or polling scheduler. The queue contains delayed scheduling jobs only: no worker processor, SMTP sending, delivery status lifecycle, hourly enforcement, or minimum-spacing enforcement is included in Phase 4. `delayMs` controls intended scheduled times; the requested `hourlyLimit` is validated and saved for later rate-limiting work.

Run the PostgreSQL + Redis integration scenario (requires the root `.env` services):

```sh
npm run test:scheduling --workspace @mailflow/api
```

## Ethereal email worker

Create a real test account at [Ethereal Email](https://ethereal.email/) and put its credentials in the root `.env`:

```text
ETHEREAL_HOST=smtp.ethereal.email
ETHEREAL_PORT=587
ETHEREAL_USER=your-generated-user
ETHEREAL_PASSWORD=your-generated-password
# Optional; defaults to ETHEREAL_USER
ETHEREAL_FROM=MailFlow <your-generated-user>
WORKER_CONCURRENCY=10
DELIVERY_MAX_ATTEMPTS=3
```

Restart the worker after changing credentials. Each due BullMQ job refers to one PostgreSQL `EmailDelivery`. The worker takes a row lock, changes `scheduled` to `processing`, and creates a `DeliveryAttempt` before it calls Nodemailer. It writes `smtpStartedAt` immediately before SMTP submission. A successful SMTP response stores the message ID and `sentAt`; a clear 5xx refusal becomes `failed`; explicit 4xx responses and known connection errors before the DATA phase may be retried with bounded exponential backoff. A transport error after SMTP DATA begins is uncertain, so the worker marks `delivery_unknown` and suppresses resend.

BullMQ recovers a crashed active job as stalled and delivers it again. If the same deterministic job returns and its attempt never crossed the SMTP boundary, the worker records that interrupted attempt and safely starts another bounded attempt. If the boundary was crossed, it records an unknown outcome instead. A terminal BullMQ worker failure also settles a delivery left in `processing`. SMTP cannot guarantee exactly-once delivery: if Ethereal accepted a message but the worker lost the response or crashed before persisting success, MailFlow records `delivery_unknown` to avoid a potentially duplicate resend.

Run worker lifecycle integration tests against local PostgreSQL and Redis:

```sh
npm run test:delivery --workspace @mailflow/worker
```

These tests exercise the database claim, concurrency, retries, terminal states, and crash recovery with a test transport seam. A real inbox check requires actual Ethereal credentials.

## Distributed timing and hourly limits

The worker reserves send slots with atomic Redis Lua operations. It applies a fixed UTC hour window to both the campaign's `hourlyLimit` and `MAX_EMAILS_PER_HOUR_PER_SENDER`, then coordinates sender spacing across campaigns and worker instances. Each delivery has an idempotent Redis reservation, so redelivery of that job does not consume hourly capacity a second time. A separate atomic sender gate runs immediately before SMTP to prevent concurrent workers from starting messages too close together.

When a reservation is in the future, the worker records a nonterminal timing attempt and moves the active BullMQ job to its delayed set with `moveToDelayed`. The delivery stays `scheduled`; the job remains visible as delayed in BullMQ and becomes eligible later. Reservations and counters are in Redis with bounded expirations; the Docker Redis service uses AOF persistence, so worker restarts retain the counters. If a job wakes after its assigned UTC window has passed, it reserves capacity again in the current window before sending.

Reservations are conservative: a permanent SMTP rejection or an uncertain SMTP result does not refund an already reserved slot, so a window can be underused. `delivery_unknown` remains terminal and is never automatically resent. Minimum spacing is enforced by Redis across campaigns for one MailFlow user. Campaign limits and sender limits are both applied; the earlier constraint wins.

The Redis Lua transaction touches sender and campaign keys together. They share a Redis Cluster hash slot so the reservation remains atomic; this concentrates rate-limit traffic on one Redis shard, which is a scaling trade-off for jointly enforcing both ceilings.

Run the distributed timing integration test against local PostgreSQL and Redis:

```sh
npm run test:rate-limits --workspace @mailflow/worker
```

## Elasticsearch delivery search

PostgreSQL is authoritative for deliveries. A database trigger marks a durable `search_index_outbox` row pending in the same transaction whenever a delivery is created or updated. The API and worker index pending rows as a best-effort projection into `mailflow-email-deliveries-v1`; a document ID is the delivery UUID, so reindexing replaces the same document. Search indexing errors are recorded in the outbox and never roll back a campaign, SMTP result, or delivery status.

The mapping keeps owner/campaign/status and normalized recipient fields exact-filterable, recipient substring searchable, subject text searchable, and timestamps typed as dates. The authenticated endpoint is `GET /api/deliveries/search` and supports `recipient`, `subject`, `status`, `scheduledFrom`, `scheduledTo`, `sentFrom`, `sentTo`, `page`, and `pageSize`. Results are always filtered to the current user's ID. Elasticsearch outages return HTTP 503 for search while campaign scheduling and SMTP delivery continue from PostgreSQL/BullMQ.

Pending outbox rows are retried on API/worker startup, after campaign creation, after worker delivery processing, and opportunistically during search. There is no polling scheduler. To repair a backlog after an Elasticsearch outage, run `npm run search:reconcile --workspace @mailflow/api`; use `-- --all` to rebuild the index from every PostgreSQL delivery. Outbox state and error metadata remain available in PostgreSQL for inspection.

Run search indexing and ownership integration checks (requires PostgreSQL and Elasticsearch):

```sh
npm run test:search --workspace @mailflow/api
```

## Slack connection and sender-limit alerts

Create a Slack app with bot token scopes `chat:write`, `chat:write.public`, `channels:read`, and `groups:read`. Add the exact redirect URL `http://localhost:4000/api/slack/oauth/callback` to the app's OAuth redirect URLs for local work. Configure `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`, `SLACK_OAUTH_STATE_SECRET` (at least 32 characters), and `SLACK_TOKEN_ENCRYPTION_KEY` (a base64url encoded random 32-byte key) in the ignored root `.env`. For hosted use, register the hosted callback URI and use independent production credentials and encryption key. The variable names are in `.env.example`; it contains no credential values.

An authenticated user starts at `GET /api/slack/oauth/start`, completes Slack's real OAuth consent screen, then selects a channel from `GET /api/slack/channels` with `PUT /api/slack/channel` and `{ "channelId": "..." }`. `GET /api/slack/connection` returns workspace and selected-channel metadata only. `DELETE /api/slack/connection` disconnects. The bot token is encrypted with AES-256-GCM in `slack_connections` and is never returned to the browser.

When Redis atomically finds the per-user sender hourly ceiling reached, the worker tries to create one `SlackAlert` for that user and fixed UTC hour. PostgreSQL's unique `(user_id, hour_window_start)` constraint elects a single worker to send the Slack message. Missing connections are recorded as skipped and do not affect delivery; selecting a channel later retries a skipped alert from the current UTC hour. Slack API failures are recorded as failed and logged without failing or un-delaying an email. The existing `SlackAlert` row also suppresses additional notifications for the same sender/hour.

## Build and type checks

```sh
npm run typecheck
npm run build
```

## Structured logs

API requests and service events are logged as structured JSON with a service name and ISO timestamp. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or another supported Pino level. Sensitive fields such as passwords, tokens, and authorization headers are redacted.

## Production deployment

The production Compose layout builds separate API/worker and frontend images. The API and worker share the same PostgreSQL, Redis, Elasticsearch, and environment configuration, but run as independent processes. A one-shot migration service applies committed Prisma migrations before API/worker startup. Caddy terminates HTTPS for the frontend and API hostnames and renews certificates automatically. Only Caddy publishes ports 80/443; PostgreSQL, Redis, Elasticsearch, API, and frontend have no host-published ports. PostgreSQL uses a named volume, Redis uses AOF plus a named volume, and Elasticsearch uses a named volume.

For production, use two HTTPS hostnames under the same registrable domain, such as `app.example.com` and `api.example.com`. This keeps the `SameSite=Lax` session cookie available to credentialed frontend requests while the API sets `Secure; HttpOnly` cookies. Point both DNS names to the Docker host and allow inbound TCP 80/443 (and optionally UDP 443 for HTTP/3). Store secrets in the hosting provider's secret manager and inject them into the deployment; do not commit `.env.production`.

Prepare the production environment file and review its values:

```sh
cp .env.production.example .env.production
# Edit .env.production: replace every placeholder and use real domains/secrets.
docker compose --env-file .env.production -f docker-compose.production.yml config --quiet
```

Deploy or update the containers:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml up --build -d
docker compose --env-file .env.production -f docker-compose.production.yml ps
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=100 api worker ingress
```

The deployment must use the exact callback URIs in the provider consoles:

- Google: `https://<API_DOMAIN>/api/auth/google/callback`
- Slack: `https://<API_DOMAIN>/api/slack/oauth/callback`

Set `FRONTEND_ORIGIN` to the exact frontend origin including `https://`, and set `VITE_API_BASE_URL` to the HTTPS API origin. Google state/nonce/PKCE and Slack state validation remain enabled. The application only stores Google profile identity; Slack bot tokens are encrypted with `SLACK_TOKEN_ENCRYPTION_KEY`. `ELASTICSEARCH_API_KEY` is needed only when using a secured Elasticsearch cluster. The included single-node Elasticsearch disables its own authentication and is intended only on a private deployment network; use managed secured Elasticsearch for a separately managed cluster. For stronger production isolation, place the Compose host behind a cloud firewall and inject secrets using a managed secrets service.

Do not use Ethereal for customer/production sending. Ethereal is a safe demo inbox; this assignment has no production mail provider. For the demo, create an Ethereal account and inject `ETHEREAL_HOST`, `ETHEREAL_PORT`, `ETHEREAL_USER`, and `ETHEREAL_PASSWORD`, with optional `ETHEREAL_FROM`. A successful send returns an SMTP message ID and Ethereal's account UI provides the preview. Never put recipient addresses for real customers in a demo campaign.

The final dependency audit found four high-severity advisories in the pinned Prisma 7.10.0 dependency chain (`@prisma/config`/`deepmerge-ts` and `mysql2`). npm's proposed automatic fix changes Prisma to major version 6, so it was not applied without compatibility validation. Treat a public production launch as blocked on selecting and validating a patched Prisma release; the current database/type/build/regression checks pass on the existing Prisma version. Nodemailer was updated to 10.0.13 and its delivery integration suite passes.

### Configuration reference

`deploy` values are also present in `.env.production.example`; local defaults are in `.env.example`. Keep frontend variables public and server credentials private.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `API_PORT`, `LOG_LEVEL` | API/worker runtime mode, listen port, structured log level |
| `DATABASE_URL` | PostgreSQL connection string; production Compose uses `postgres` as the private service host |
| `REDIS_URL` | Redis connection string including authentication in production |
| `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` | Elasticsearch endpoint and optional API key |
| `FRONTEND_ORIGIN`, `VITE_API_BASE_URL` | Exact browser origin allowed by API CORS and browser API origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Web OAuth client and callback |
| `GOOGLE_OAUTH_STATE_SECRET` | Random secret of at least 32 characters for protected OAuth state |
| `SESSION_COOKIE_NAME`, `SESSION_TTL_HOURS` | Application cookie name and database session lifetime |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` | Slack OAuth app and callback |
| `SLACK_OAUTH_STATE_SECRET` | Random secret of at least 32 characters for Slack OAuth state |
| `SLACK_TOKEN_ENCRYPTION_KEY` | Base64url-encoded random 32-byte AES-GCM key |
| `ETHEREAL_HOST`, `ETHEREAL_PORT`, `ETHEREAL_USER`, `ETHEREAL_PASSWORD`, `ETHEREAL_FROM` | Demo SMTP transport and sender identity |
| `WORKER_CONCURRENCY` | Concurrent delivery processors per worker process (default 10) |
| `DELIVERY_MAX_ATTEMPTS` | Bounded BullMQ attempts (default 3, maximum 10) |
| `MIN_DELAY_MS` | Minimum spacing between sends per user |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Per-user hourly delivery ceiling |
| `MAX_RECIPIENTS_PER_CAMPAIGN` | Maximum input recipients accepted for one campaign |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Production Compose PostgreSQL initialization |
| `REDIS_PASSWORD` | Production Compose Redis `requirepass`; use the same secret in `REDIS_URL` |
| `APP_DOMAIN`, `API_DOMAIN` | Public DNS names managed by Caddy |
| `VITE_API_BASE_URL` | Build-time public HTTPS API URL for the frontend image |
| `ES_JAVA_OPTS` | Elasticsearch heap setting for the included private single-node service |

Generate random keys without printing existing secrets:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Production smoke test

After DNS, OAuth providers, and secrets are configured, verify `/health` and `/ready`, then use safe test addresses and Ethereal only: Google login/logout; dashboard; CSV validation counts; schedule a small campaign; confirm scheduled state in the UI and BullMQ Board; wait for worker processing; verify Ethereal message ID/preview and `sent` state; search by recipient; connect Slack, select a channel, and disconnect/reconnect. To verify a real Slack limit alert, configure a deliberately low test sender limit and send only to controlled Ethereal addresses. Do not run this procedure until all OAuth callbacks and SMTP credentials use the production/demo settings intended for that environment.

## Final regression verification

Run the Phase 2–11 suites against the local test services:

```sh
npm run test:db --workspace @mailflow/api
npm run test:auth --workspace @mailflow/api
npm run test:scheduling --workspace @mailflow/api
npm run test:delivery --workspace @mailflow/worker
npm run test:rate-limits --workspace @mailflow/worker
npm run test:search --workspace @mailflow/api
npm run test:slack --workspace @mailflow/api
npm test --workspace @mailflow/frontend
npm run test:operations --workspace @mailflow/api
npm run test:redis-restart --workspace @mailflow/api
npm run test:load --workspace @mailflow/api
npm run test:postgres-restart --workspace @mailflow/api
npm run typecheck
npm run build
npm run db:migrate:status --workspace @mailflow/api
```

The restart probes restart the local Compose Redis/PostgreSQL containers. Run them only when those services are not being used by other local work. The load test schedules 1,000 recipients without starting SMTP delivery. The worker tests inject a test transport and do not send external messages. See Phase 11 above for measured results from the verified run.

## Reliability and consistency summary

- **Source of truth:** PostgreSQL owns users, campaigns, delivery state, attempts, and queue outbox records. Redis/BullMQ executes durable delayed work; Redis uses AOF persistence in Compose.
- **Handoff and restart recovery:** each delivery and deterministic job identity are committed with an outbox row. API/worker startup and Redis reconnect reconcile incomplete handoffs; repeated queue insertion converges on the same job ID.
- **Rate limits and spacing:** atomic Redis reservations coordinate the campaign's fixed UTC hourly ceiling, sender-wide hourly ceiling, and sender-wide spacing across workers. Reservations are conservative: if a job reserves capacity but fails before sending, that slot can remain consumed for the current UTC window, favoring safety over maximum utilization.
- **Concurrency and retry:** worker concurrency is configurable; PostgreSQL claims protect a delivery from simultaneous processing. Transient-safe errors receive bounded exponential retries. BullMQ retains completed jobs for a 7-day/10,000-job target and failed jobs for a 30-day/20,000-job target; cleanup is opportunistic. PostgreSQL keeps authoritative history.
- **SMTP uncertainty:** SMTP has no transaction shared with PostgreSQL. After SMTP submission begins, a lost response may mean the message was accepted or not. MailFlow records `delivery_unknown` and avoids blind resend, so the system does not claim exactly-once SMTP delivery.
- **Search:** Elasticsearch is an eventually consistent projection from PostgreSQL. Index outbox reconciliation repairs missing documents; search may lag or be unavailable during an Elasticsearch outage without preventing scheduling or sending.
- **Slack:** OAuth identifies the workspace; the signed-in user selects the destination channel. Encrypted token storage and a unique user/UTC-hour alert row prevent token disclosure and repeat alert spam.

## Five-minute demo sequence

1. **0:00–0:25:** Continue with Google and show the signed-in dashboard/profile.
2. **0:25–1:10:** Compose a short email, upload a small CSV, and show total, valid, invalid, and duplicate counts.
3. **1:10–1:35:** Set a near-future start time, sender spacing, and campaign hourly cap; schedule.
4. **1:35–2:05:** Show the scheduled rows and BullMQ waiting/delayed state.
5. **2:05–2:50:** Show worker processing, Ethereal message preview/ID, and the sent row.
6. **2:50–3:15:** Search for the recipient and show the indexed result.
7. **3:15–3:45:** Show connected Slack workspace/channel (or connect/select if the OAuth setup is ready).
8. **3:45–4:30:** Briefly explain rate-limit deferral and durable restart recovery; use the recorded test evidence instead of restarting services mid-demo.
9. **4:30–5:00:** Recap PostgreSQL authority, distributed limits, and the `delivery_unknown` SMTP boundary.

## Submission readiness

Keep the repository private. Before submission, verify `.env` and `.env.production` are ignored, inspect `git status` and the GitHub remote, scan the staged files for credentials, create the private GitHub repository, push source, then grant `Mitrajit` and `Yadav036` the required repository access. This workspace currently has no Git remote and GitHub CLI is not authenticated, so repository creation and collaborator verification must be completed after GitHub access is configured.
