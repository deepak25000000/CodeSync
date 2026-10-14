# CodeSync — Implementation Plan

Derived from `docs/PROJECT_AUDIT.md` (repo was empty; baseline architecture adopted).

## Architecture

```
┌────────────────────────────┐      HTTPS/JSON (Bearer API token)     ┌──────────────────────┐
│ Chrome extension (MV3)     │ ─────────────────────────────────────▶ │ FastAPI backend       │
│  content scripts/adapters  │                                        │  auth (GitHub OAuth / │
│  background SW (queue,     │                                        │   PAT) + API tokens   │
│   retry/backoff)           │                                        │  submissions (idemp.) │
│  popup + options UI        │                                        │  sync jobs + worker   │
└────────────────────────────┘                                        │  encrypted GitHub     │
        │ detects accepted submissions on                            │   credentials         │
        ▼                                                             └──────────┬───────────┘
  leetcode.com / geeksforgeeks.org / codechef.com / neetcode.io                 │ GitHub REST
                                                                                 ▼
                                                                      user's GitHub repository
                                                                      (DSA-Solutions/…)
```

* **GitHub credentials live only on the server**, encrypted at rest (Fernet, key from
  `CREDENTIALS_KEY`). The extension never sees a GitHub token.
* **Sync lifecycle:** `DETECTED → VALIDATED → QUEUED → SYNCING → SYNCED`, plus
  `REJECTED`, `UNSUPPORTED`, `FAILED`, `RETRY_PENDING`.
* **Dedupe:** unique `(user_id, fingerprint)` on submissions + one job per submission +
  content-hash short-circuit before upload ⇒ replaying an event never creates a second
  commit.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Audit, scaffold, baseline test harness | done |
| 2 | GitHub engine: OAuth/PAT auth, encrypted storage, file generation, Contents API client, dedupe, sync worker, pytest suite (mocked GitHub) | done |
| 3 | LeetCode adapter + full E2E workflow test (mocked GitHub) | done |
| 4 | GeeksforGeeks, CodeChef adapters; NeetCode capability-limited adapter (metadata + cross-platform association only) | done |
| 5 | Popup, options page, queue persistence, retries, pause/resume, messaging, vitest suite | done |
| 6 | Security pass: host allowlist, message schema validation, rate limiting, redacted logging, account deletion | done |
| 7 | CI workflow, Docker, README + docs (setup, API, capability matrix, troubleshooting, security) | done |
| 8 | Full suite run, fixes, honest delivery report | done — see `docs/FINAL_REPORT.md` |

## Key conventions

* Platform logic lives **only** in `extension/src/adapters/*` (one file per platform,
  one shared interface: `detect_page / detect_submission / extract_problem_metadata /
  extract_submission_status / extract_solution_code / normalize_submission /
  report_adapter_health`).
* UI, business logic, persistence and GitHub HTTP are separated in the backend:
  `api/` (routers) → `services/` (logic) → `models.py` (persistence) →
  `services/github.py` (external API).
* No secret ever appears in source, tests, or logs (redaction helper used for headers).
* Tests must be deterministic: fixtures + injected mock transports, never live sites.
