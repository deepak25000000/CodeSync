# CodeSync security & privacy

## Threat model (what we defend against)

| Asset | Threat | Control |
|---|---|---|
| GitHub token | Theft from the extension | The extension **never receives it** — it authenticates to CodeSync with a scoped API token only |
| GitHub token | Theft from the database | Encrypted at rest with Fernet; key supplied via `CREDENTIALS_KEY` env var, never committed; logs redact `token`/`authorization`/`secret` fields recursively |
| GitHub token | Leak in process memory/logs | Tokens are only decrypted inside a single sync call; redaction helper strips `Bearer …` and sensitive keys from structured logs |
| API token | Theft / replay | Stored as SHA-256 hash only; shown once; individually revocable; last-used timestamp recorded |
| API token | Brute force | Per-token sliding-window rate limit (default 120 req/min) + separate stricter budget on the PAT/OAuth endpoints keyed by client IP |
| User repos | Overwrite of hand-written files | Worker checks the `codesync-fp:` marker; a file without it is never clobbered (`CONFLICT`, permanent failure) |
| User repos | Path traversal via titles/settings | Filenames are slugified to `[a-z0-9-]`; `root_folder`/`branch` validated against strict regexes (`..` rejected) |
| Browser | Malicious page spoofing the extension | Content scripts run only on the four allow-listed hosts; all runtime messages are schema-validated with strict whitelists (unknown types rejected) |
| Browser | Remote code execution via extension CSP | No inline scripts, no remote scripts, no `eval`; MV3 default CSP |
| Server | Oversized payloads | `MAX_REQUEST_BYTES` middleware (default 2 MB) → `413` |
| Server | CORS abuse | CORS disabled unless explicitly allow-listed via `CORS_ORIGINS` |
| Server | Unhandled errors leaking internals | Generic 500 handler returns a constant message; details go to structured logs only |
| OAuth | CSRF / forged callback | Random `state` bound to an HttpOnly cookie, single-use, 10-minute TTL, stored hashed |
| Supply chain | Secret committed | `.gitignore` excludes `.env` / `*.db`; CI has no secrets; no credential appears in source, fixtures or tests |

## Credential lifecycle

1. User connects GitHub through the portal (OAuth or PAT).
2. Backend validates the token against `GET /user`, encrypts it (`CredentialCipher`,
   Fernet with SHA-256-derived key when a passphrase is supplied), stores it in
   `oauth_connections.access_token_encrypted`.
3. The user receives a `cs_…` API token once; only its SHA-256 is persisted.
4. `DELETE /account` removes the user row and cascades to tokens, credentials,
   submissions, jobs and attempts.

## Extension data

`chrome.storage.local` holds the sync queue, settings and a small history — no
credentials. The API token is stored with the other settings; clearing the extension's
storage or revoking the token from the portal/API immediately disables it.

## Reporting

This repository has no published security contact yet; treat it as a personal project.
Before deploying publicly, set a real `CREDENTIALS_KEY`, put the backend behind TLS,
and restrict `CORS_ORIGINS` / host permissions to what you actually use.
