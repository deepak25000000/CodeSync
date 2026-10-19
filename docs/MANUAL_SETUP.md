# Manual setup checklist — completing CodeSync

Everything below is work only a **human** can do (your accounts, your browser, your
GitHub). The code, tests, release package and docs are already finished:

* Backend: **208 tests** passing, ruff/format/mypy clean, Postgres verified
* Extension: **147 tests** passing, release `extension/release/codesync-extension-v1.1.3.zip`
* Docs: README (user guide), DEPLOYMENT (free hosting), SECURITY, API, TROUBLESHOOTING

Work through the phases in order. Each ends with a **Done when** check.

---

## Phase 1 — Finalize the local setup (5 min)

1. `chrome://extensions` → CodeSync → **⟳ reload** → version must show **1.1.3**
2. Options → **Connection** — you should already be connected
   (*Connected as deepak25000000*). If not: expand *"Connect with a GitHub PAT
   instead"* → paste your GitHub PAT (`repo` scope) → **Connect**. No token
   copying anywhere.
3. Under **Repository**: confirm the repo/branch/root folder are set → **Save settings**.

**Done when:** connection chip is green and an accepted submission on any of
LeetCode / GFG / CodeChef lands in your repo within seconds (auto-sync), or via
**Sync this page** in the popup.

## Phase 2 — Deploy the backend for production (25 min, no payment info)

Follow [docs/DEPLOYMENT.md](DEPLOYMENT.md) **Option A**, in short:

1. **Neon** (<https://neon.tech>, GitHub signup, no card) — create project
   `codesync`, copy the `postgres://…sslmode=require` connection string.
2. **Render** (<https://render.com>, GitHub signup, no card) — *New → Web
   Service* → repo `deepak25000000/CodeSync` → Runtime **Docker** → Plan **Free**
   → env vars: `DATABASE_URL` (Neon string as-is), `PUBLIC_BASE_URL`
   (`https://<your-service>.onrender.com`), `CREDENTIALS_KEY` (generate with the
   Fernet one-liner) → Create → wait for the build (migrations run automatically).
3. **UptimeRobot** (email signup, no card) — HTTP monitor on
   `https://<your-service>.onrender.com/api/v1/health`, every 5 min (keeps the
   free instance awake; data lives in Neon so nothing is ever lost anyway).
4. **GitHub OAuth app** — Settings → Developer settings → OAuth Apps → New:
   callback `https://<your-service>.onrender.com/api/v1/auth/github/callback` →
   put Client ID/secret into Render env vars → *Manual Deploy → Trigger*.

**Done when:** `…/api/v1/health` returns JSON over HTTPS and the portal page loads.

## Phase 3 — Connect the extension to production (5 min)

1. Options → **API base URL** → `https://<your-service>.onrender.com` → allow the
   host permission if Chrome asks.
2. **Sign in with GitHub** → GitHub authorize page → **Authorize**. The API token
   is issued and stored automatically — nothing to copy.
3. Pick/create your repository under **Repository** → **Save settings**.

**Done when:** a fresh accepted submission syncs through the **production** URL
(reload the extension first so all workers restart cleanly).

## Phase 4 — Security cleanup (10 min)

1. **Rotate the GitHub PAT** (an old one was exposed in chat):
   github.com → Settings → Developer settings → Personal access tokens →
   *Tokens (classic)* → **Generate new token (classic)** → scope **✓ repo** →
   copy it → paste into the extension's PAT box → **Connect** (backend re-validates
   and stores it encrypted) → then **Delete** the old token on GitHub.
2. **Retire the test repo:** tell me **"clean up"** — I unbind it and delete
   `DSA-Solutions` via the API — or delete it yourself (repo → Settings → Danger
   Zone). Then create your real repository in the extension's **Repository**
   dropdown (or keep DSA-Solutions if you'd rather not delete it).

**Done when:** the old token is revoked on GitHub and the extension is bound to
your final repository.

## Phase 5 — Publish the project (1 min)

1. Say **"push"** — I push all local commits (code, docs, v1.1.3 release) to
   `github.com/deepak25000000/CodeSync`.
2. *(Optional, later)* Chrome Web Store: a $5 one-time developer account; say
   **"store build"** and I'll prepare the submission package
   ([docs/STORE_LISTING.md](STORE_LISTING.md)).

---

## Day-to-day usage (after setup)

Just solve and submit as usual — the extension detects the verdict and the file
lands in your repo with a provenance header, `progress.json` and a README table.
Use the popup for status/queue/**Sync this page**, and Options to change
repository, branch, root folder or enabled platforms.

Say-words reference: **"push"** (publish to GitHub) · **"clean up"** (delete test
repo + unbind) · **"restart backend"** (local uvicorn) · **"store build"** (Web
Store package).
