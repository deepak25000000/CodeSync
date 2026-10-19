# CodeSync

Automatically push your accepted coding solutions from **LeetCode**, **GeeksforGeeks**
and **CodeChef** into your own GitHub repository — with a Chrome extension that watches
for submissions and a FastAPI backend that owns the GitHub credentials, deduplication
and retry logic. **NeetCode** is supported as a manual-sync companion (it is a
practice organizer, not a judge — see [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)).

```
Chrome extension (MV3)                     FastAPI backend                      GitHub
┌──────────────────────────┐   HTTPS/JSON   ┌─────────────────────────┐   REST   ┌─────────┐
│ content adapters         │ ─────────────▶ │ auth (OAuth one-click)  │ ───────▶ │         │
│ background queue+retry   │  Bearer token  │ idempotent submissions  │  Contents│ your    │
│ popup / options UI       │                │ sync worker + scheduler │   API    │ repo    │
└──────────────────────────┘                │ encrypted credentials   │          │ (DSA-   │
                                            └─────────────────────────┘          │Solutions)│
```

Key properties:

* **One-click setup for users.** Install the extension, press *Sign in with GitHub*,
  pick a repository — done. No token to copy, ever (the API token is issued by the
  backend and stored in the extension automatically).
* **The extension never sees a GitHub token.** Credentials live only on the server,
  encrypted at rest with Fernet (`CREDENTIALS_KEY`).
* **Exactly-once semantics.** Submissions are fingerprinted (`platform + submission id`,
  else content hash); replaying an event never creates a second commit. The generated
  file embeds a `codesync-fp:` marker, and the worker refuses to clobber files it did
  not create.
* **Durable retries.** Jobs run through `QUEUED → SYNCING → SYNCED` with bounded
  exponential backoff + jitter, rate-limit awareness and a full per-attempt audit log.
* **Language-accurate files.** The extension detects the language you actually
  submitted in (25+ languages) via the DOM, the editor bridge *or* the code itself,
  and the backend maps it to the matching file extension — with a contract test that
  parses the extension's language table so the two can never drift.

---

## Using the extension (user guide)

### 1 · Install

1. Grab `extension/release/codesync-extension-vX.Y.Z.zip` from this repository and
   extract it anywhere (keep the folder — Chrome loads from it).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and
   select the extracted folder. Pin the CodeSync icon.

### 2 · Connect (Options page)

Right-click the extension icon → **Options**, then under **Connection**:

1. **API base URL** — leave `http://127.0.0.1:8000` if the backend runs on your
   machine, or enter your hosted URL (e.g. `https://codesync.yourdomain.com`). For a
   remote URL the browser asks for host permission once — allow it.
2. Press **Sign in with GitHub**. A GitHub window opens; authorize, and the backend
   issues your API token which is stored in the extension automatically.
   *Backend without an OAuth app?* Open *"Connect with a GitHub PAT instead"* and
   paste a GitHub PAT (`repo` scope) — same one-step result.
   *Advanced:* a token copied from the backend portal can still be pasted into the
   **API token** field manually.

### 3 · Choose the repository

Still in Options, under **Repository**:

* Pick an existing repository from the dropdown, **or create one** right there
  (name + optional private checkbox).
* Set **Branch** (default `main`) and **Root folder** (default `DSA-Solutions`).
* Toggle the platforms you use, leave **Auto-sync** on, press **Save settings**.

### 4 · Solve — and forget about it

Submit a solution as usual on LeetCode / GeeksforGeeks / CodeChef. When the verdict
appears, the extension detects it (title, verdict, full code, language), and within
seconds your repo gets:

* `…/LeetCode/0001-two-sum.py` — the solution, in the language you submitted,
  with a provenance header (platform, problem, verdict, submission id, fingerprint)
* `…/progress.json` — machine-readable progress
* `…/README.md` — a human-readable progress table

Verdicts that trigger a sync: LeetCode **Accepted**, GeeksforGeeks **Problem Solved
Successfully**, CodeChef **Correct**. Rejected/pending attempts are never pushed.

**Manual sync** — anything the detector can't catch (or NeetCode lists): open the
problem page, click the extension icon → **Sync this page**, or use **Manual
submission** in Options. The popup's **Queue** shows every job with its state,
error code and a **Retry** button.

---

## Hosting the backend — production-ready, free for life

The backend needs somewhere to run. The easiest path needs **no payment
information anywhere**:

* **Render Free + Neon Postgres** — sign up with GitHub only (no card): Render
  runs the app from the repo's `Dockerfile`, Neon keeps the database safe across
  restarts. ~20 minutes, zero server admin.
* Alternative: your **own free-forever VM** (Oracle Always Free — needs card
  verification, never charged) with Docker, or even **your own PC** behind a free
  Cloudflare tunnel.

Full step-by-step for all three: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
After deploying, users just set the **API base URL** in the extension options and
press **Sign in with GitHub** — no other configuration anywhere.

---

## Quickstart — backend (development)

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
API token** for the extension (optional now — the extension can sign in by itself).
Interactive API docs are at `/docs`.

Prefer containers?

```bash
export CREDENTIALS_KEY=$(python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())")
docker compose up --build
```

## Quickstart — extension (contributors)

**Install from a release (no Node.js needed):**

1. Grab `extension/release/codesync-extension-vX.Y.Z.zip`, extract it into any folder.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   select the extracted folder.
3. Follow **Using the extension** above.

**Build from source:**

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
# backend — 208 tests: unit + API integration + E2E against a mocked GitHub
cd backend && pytest

# extension — 147 tests: adapter fixtures, language contract, bridge, auth, queue/backoff, manifest
cd extension && npm test
```

Both suites are fully deterministic: no network, no live sites, no real GitHub.

## Security at a glance

* API tokens are stored as SHA-256 hashes only; plaintext is shown exactly once.
* GitHub tokens are encrypted server-side (Fernet) and never leave the backend.
* One-click sign-in redirects are locked to `https://<extension-id>.chromiumapp.org/`
  — the OAuth callback can never be used as an open redirector.
* Strict input validation (Pydantic), per-token sliding-window rate limits, request
  size caps, CSP-clean extension (no remote code, no inline scripts), host allowlists,
  recursive log redaction.

Full details: [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Free-forever hosting with no payment info (Render+Neon), VM, or your PC |
| [docs/MANUAL_SETUP.md](docs/MANUAL_SETUP.md) | Human checklist to finish the project: local, deploy, connect, cleanup |
| [docs/API.md](docs/API.md) | Endpoint reference, payloads, error model |
| [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) | What each platform adapter can and cannot do |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and controls |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common failures and fixes |
| [docs/ACCEPTANCE_TESTS.md](docs/ACCEPTANCE_TESTS.md) | Human verification checklist (live sites) |
| [docs/RELEASE.md](docs/RELEASE.md) | Cutting a release, packaging, versioning |
| [docs/STORE_LISTING.md](docs/STORE_LISTING.md) | Chrome Web Store submission package |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phase plan |
| [docs/FINAL_REPORT.md](docs/FINAL_REPORT.md) | Delivery report, test results, known limits |

## Contributors

* **Deepak Thorat** ([@deepak25000000](https://github.com/deepak25000000)) — creator &
  maintainer: idea and requirements, live testing on the real platforms, and the
  GitHub side of the project.
* **OpenCode** — the AI coding agent (MiMo model) that designed and built this
  repository: architecture, FastAPI backend, Chrome MV3 extension, the full 355-test
  suites, documentation and release packaging — credited here the same way Claude is
  credited in other repositories.

Built with [OpenCode](https://opencode.ai).

MIT © Deepak Thorat.
