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
* **Language-accurate files.** The extension detects the language you actually
  submitted in (25+ languages: Python/Python3, C++, Java, JavaScript, TypeScript,
  Go, Rust, Kotlin, Swift, C#, Ruby, PHP, Scala, Dart, Elixir, Erlang, R, Bash,
  SQL dialects, …) and the backend maps it to the matching file extension — a
  contract test parses the extension's language table so the two can never drift.

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

**Install from a release (no Node.js needed):**

1. Grab `extension/release/codesync-extension-vX.Y.Z.zip` from this repository,
   extract it into any folder (keep it somewhere stable).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select the extracted folder.
3. Open the extension **Options** and follow the **First-time setup** card: set the
   API base URL (`http://127.0.0.1:8000`), paste the API token from the portal, pick
   a repository (or create one), enable the platforms you use, save.
4. Solve and submit a problem on LeetCode / GeeksforGeeks / CodeChef — the solution
   file (in the language you submitted), `progress.json` and a progress README
   section land in your repo automatically.

**Build from source (contributors):**

```bash
cd extension
npm install
npm test             # full suite
npm run release      # test + build + release zip in extension/release/
npm run build        # plain build -> dist/ (load *this* in chrome://extensions)
```

After any code change, run `npm run build` and press **Reload** on the extension
card in `chrome://extensions` — `dist/` is a build artifact and is never committed.

## Testing

```bash
# backend — 148 tests: unit + API integration + E2E against a mocked GitHub
cd backend && pytest

# extension — 134 tests: adapter fixtures, language contract, bridge, queue/backoff, manifest
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
| [docs/RELEASE.md](docs/RELEASE.md) | Cutting a release, packaging, versioning |
| [docs/STORE_LISTING.md](docs/STORE_LISTING.md) | Chrome Web Store submission package |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phase plan |
| [docs/FINAL_REPORT.md](docs/FINAL_REPORT.md) | Delivery report, test results, known limits |
