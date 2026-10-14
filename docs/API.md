# CodeSync API reference

Base URL: `http://127.0.0.1:8000` · prefix: `/api/v1` · interactive docs: `/docs`.

## Authentication

All `/api/v1` endpoints except `GET /health`, `GET /meta`, `GET /auth/github/start`,
`GET /auth/github/callback` and `POST /auth/pat` require:

```
Authorization: Bearer cs_…
```

Tokens are issued by the portal (`GET /`) via GitHub OAuth or a personal access token,
or by `POST /auth/token` for an already-authenticated caller. Only SHA-256 hashes of
tokens are stored; a token is displayed exactly once.

### Error model

Non-2xx responses are always:

```json
{ "detail": { "code": "SOME_CODE", "message": "human readable" } }
```

Validation failures (422) use FastAPI's standard field-error list. Rate limiting
returns `429` with `Retry-After` and `{"code": "RATE_LIMITED"}`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness: `{status, app, version, environment}` |
| GET | `/meta` | Version, OAuth availability, rate-limit config, platform matrix |
| POST | `/auth/pat` | Body `{token}` (GitHub PAT) → validates against GitHub, stores the encrypted credential, returns `{api_token, user, github_login}` |
| GET | `/auth/github/start` | Redirects to GitHub OAuth (requires `GITHUB_CLIENT_ID/SECRET`) |
| GET | `/auth/github/callback` | OAuth callback; renders a one-time token page |
| POST | `/auth/token` | Mint an additional API token for the current user |
| GET | `/auth/me` | `{id, github_login, created_at, github_connected, settings, platforms}` |
| GET | `/auth/tokens` / DELETE `/auth/tokens/{id}` | List/revoke API tokens (never exposes secrets) |
| POST | `/submissions` | Idempotent ingestion (see below) |
| GET | `/submissions` | Paginated list (`page`, `per_page`, `platform`, `verdict`) |
| GET | `/submissions/{id}` | Single submission (owner only, else 404) |
| POST | `/sync` | `{submission_id}` → queue a job (or report the existing one) |
| POST | `/sync/{id}/retry` | Re-queue a FAILED job |
| GET | `/sync` | Job list (`page`, `per_page`, `state`) |
| GET | `/sync/{id}` | Job detail incl. `attempts_log` |
| GET | `/settings` / PATCH `/settings` | Repo binding, branch, root folder, auto-sync |
| GET | `/platforms` / PUT `/platforms/{id}` | Capability matrix + per-platform toggles |
| GET | `/repos` / POST `/repos` | List/create repositories via the stored GitHub credential |
| GET | `/github/connection` | Verify the stored credential still works |
| GET | `/stats` | Counts by verdict, platform and job state |
| DELETE | `/account` | Irreversible deletion of the user and all associated rows |

### POST /submissions

```json
{
  "platform": "leetcode",
  "title": "Two Sum",
  "language": "python",
  "code": "class Solution: ...",
  "external_id": "1001",
  "problem_id": "1",
  "url": "https://leetcode.com/problems/two-sum/",
  "verdict": "accepted",
  "submitted_at": "2026-10-14T09:00:00Z",
  "metadata": {"difficulty": "easy"},
  "auto_sync": null
}
```

Response `201`:

```json
{
  "submission": {"id": 7, "status": "VALIDATED", "fingerprint": "…", "...": "…"},
  "duplicate": false,
  "sync_job_id": 12
}
```

* Fingerprint = sha256 of `id|{platform}|{external_id}` when an id is present, else
  `content|{platform}|{url}|{language}|{sha256(code)}` — replaying the same event is
  always a `duplicate: true` no-op.
* Verdict mapping: `accepted`/`manual` → `VALIDATED` (queued when auto-sync is on),
  `rejected` → `REJECTED`, `pending` → `DETECTED`, `unknown` → `UNSUPPORTED`.
* Disabled platforms are rejected with `403 PLATFORM_DISABLED`.

### Job lifecycle

`QUEUED → SYNCING → SYNCED` on success; failures go to `RETRY_PENDING` (bounded
exponential backoff, `max_attempts = 5`) or straight to `FAILED` for permanent errors
(`NO_REPOSITORY`, `AUTH_MISSING`, `CONFLICT`, `INVALID_VERDICT`, `CODE_UNAVAILABLE`,
`AUTH_EXPIRED`, `PERMISSION_DENIED`, `NOT_FOUND`, `VALIDATION`).

Each successful sync writes up to three commits to `{root_folder}/`:

1. `LeetCode/0001-two-sum.py` — header metadata (incl. `codesync-fp:` marker) + the
   verbatim solution code
2. `progress.json` — merged, idempotent index of every synced solution
3. `README.md` — progress table between `<!-- codesync:progress:begin/end -->` markers
   (other content is never touched)
