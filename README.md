# CodeSync

Automatically push your accepted coding solutions from **LeetCode**, **GeeksforGeeks** and
**CodeChef** into your own GitHub repository — with a Chrome extension that watches for
submissions and a FastAPI backend that owns the GitHub credentials, deduplication and
retry logic. **NeetCode** is supported as a metadata/manual-sync companion (it is a
practice organizer, not a judge — see [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)).

```
Chrome extension (MV3)                     FastAPI backend                      GitHub
┌──────────────────────────┐   HTTPS/JSON   ┌─────────────────────────┐   REST   ┌─────────┐
│ content adapters         │ ─────────────▶ │ auth (OAuth / PAT)      │ ───────▶ │         │
│ background queue+retry   │  Bearer token  │ idempotent submissions  │  Contents│ your    │
│ popup / options UI       │                │ sync worker + scheduler │   API    │ repo    │
└──────────────────────────┘                │ encrypted credentials   │          │ (DSA-   │
                                            └─────────────────────────┘          │Solutions)│
```

Key properties:

* **The extension never sees a GitHub token.** Credentials live only on the server,
  encrypted at rest with Fernet (`CREDENTIALS_KEY`).
* **Exactly-once semantics.** Submissions are fingerprinted (`platform + submission id`,
  else content hash); replaying an event never creates a second commit. The generated
  file embeds a `codesync-fp:` marker, and the worker refuses to clobber files it did
  not create.
* **Durable retries.** Jobs run through `QUEUED → SYNCING → SYNCED` with bounded
  exponential backoff + jitter, rate-limit awareness and a full per-attempt audit log.

## Repository layout

```
backend/            FastAPI app (app/api, app/services), alembic migrations, pytest suite
extension/          Chrome MV3 extension (esbuild + vitest), adapters per platform
docs/               Audit, implementation plan, API reference, security, acceptance tests
.github/workflows/  CI (backend pytest/ruff/mypy + extension vitest/build)
Dockerfile, docker-compose.yml
```

## Quickstart — backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp ../.env.example .env
# edit .env: set CREDENTIALS_KEY (required) — generate one with:
python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"
alembic upgrade head            # or let the app auto-create tables in dev
uvicorn app.main:app --reload --port 8000
```

Open <http://127.0.0.1:8000> — the portal walks you through connecting GitHub
(OAuth app or personal access token with the `repo` scope) and hands you a **one-time
API token** for the extension. Interactive API docs are at `/docs`.

Prefer containers?

```bash
export CREDENTIALS_KEY=$(python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())")
docker compose up --build
```

## Quickstart — extension

```bash
cd extension
npm install
npm run build          # outputs dist/
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   select `extension/dist`.
2. Open the extension **Options**: set the API base URL (`http://127.0.0.1:8000`),
   paste the API token from the portal, pick a repository (or create one), and enable
   the platforms you use.
3. Solve and submit a problem on LeetCode / GeeksforGeeks / CodeChef — the solution
   file, `progress.json` and a progress README section land in your repo automatically.

## Testing

```bash
# backend — 145 tests: unit + API integration + E2E against a mocked GitHub
cd backend && pytest

# extension — 113 tests: adapter fixtures, schema validation, queue/backoff, manifest
cd extension && npm test
```

Both suites are fully deterministic: no network, no live sites, no real GitHub.

## Security at a glance

* API tokens are stored as SHA-256 hashes only; plaintext is shown exactly once.
* GitHub tokens are encrypted server-side (Fernet) and never leave the backend.
* Strict input validation (Pydantic), per-token sliding-window rate limits, request
  size caps, CSP-clean extension (no remote code, no inline scripts), host allowlists,
  recursive log redaction.

Full details: [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/API.md](docs/API.md) | Endpoint reference, payloads, error model |
| [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) | What each platform adapter can and cannot do |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and controls |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common failures and fixes |
| [docs/ACCEPTANCE_TESTS.md](docs/ACCEPTANCE_TESTS.md) | Human verification checklist (live sites) |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phase plan |
| [docs/FINAL_REPORT.md](docs/FINAL_REPORT.md) | Delivery report, test results, known limits |
