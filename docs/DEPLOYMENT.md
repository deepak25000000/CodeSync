# Deploying the CodeSync backend — production-ready, free for life

Two recommended paths, both $0/month:

| | **Option A — Render + Neon** | **Option B — your own VM** |
|---|---|---|
| Payment info | **None, anywhere** | Card required by the VM provider (Oracle verification) |
| Effort | ~20 minutes, no server admin | ~1–2 hours, full control |
| Always-on | Yes, with a free keep-alive ping | Yes, always |
| Best for | Almost everyone | Tinkerers, full-control fans |

> **Option C** (zero signups at all — run it on your own PC) is at the bottom.

The stack is tiny: FastAPI + one worker, ~150 MB RAM, a few hundred MB disk.

---

## Option A — Render Free + Neon Postgres (no payment info needed)

Both services let you sign up with **GitHub/email only — no credit card**:

* **Render** hosts the app (free web service plan; its docs confirm services run
  without any payment method on file).
* **Neon** provides the database. Render's free instances have an *ephemeral disk*
  (local files are wiped on every restart), so the SQLite file must live in an
  external Postgres instead — Neon's free tier (0.5 GB, ~200× what this app needs)
  is more than enough. The backend accepts Neon's connection string as-is.

### A1 · Create the free Postgres database (Neon)

1. Go to <https://neon.tech> → **Sign up with GitHub** (no card asked).
2. Create a project, e.g. `codesync` (region nearest to you).
3. On the project's **Connection details** page, copy the connection string —
   it looks like:
   `postgres://codesync_owner:xxxxx@ep-xxx.aws.neon.tech/neondb?sslmode=require`
   Keep it; you paste it in step A3.

*(Supabase works the same way: create a project → Settings → Database → connection
string, use the `Postgres` URI.)*

### A2 · Deploy the backend on Render

1. Go to <https://render.com> → **Sign up with GitHub** (no card asked).
2. **New + → Web Service** → connect the GitHub repository
   `deepak25000000/CodeSync` (Render asks to install its GitHub app — allow it for
   this repo).
3. Configure:
   * **Name:** `codesync`
   * **Runtime:** `Docker` (auto-detected from the repo's `Dockerfile`)
   * **Instance Type:** **Free**
4. **Advanced → Environment variables** (or *Environment* tab after creation) — set:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from A1 (paste as-is) |
   | `PUBLIC_BASE_URL` | `https://<your-service>.onrender.com` (shown after creation) |
   | `CREDENTIALS_KEY` | run once locally: `python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"` |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | optional — filled in A5 for one-click sign-in |

   *(Alternatively use **New + → Blueprint** to pick up the repo's `render.yaml`,
   then fill the same variables in the dashboard.)*
5. **Create Web Service** — Render builds the Docker image and deploys. The
   container runs migrations (`alembic upgrade head`) on start.
6. Verify: open `https://<your-service>.onrender.com/api/v1/health` — JSON means
   it's live. The portal page renders at `/`.

✅ **Data safety:** all state (users, tokens, submissions) is in Neon — Render
restarts, redeploys and spin-downs can no longer lose it.

### A3 · Keep it awake (recommended)

A free Render instance **spins down after ~15 minutes without traffic**; the next
request takes ~30–60 s to wake it (the extension's queue retries automatically, so
nothing breaks either way — a keep-awake ping just makes syncs instant).

Free, no-card keep-alive: <https://uptimerobot.com> (sign up with email) →
**Add new monitor** → type `HTTP` → URL `https://<your-service>.onrender.com/api/v1/health`
→ interval **5 minutes** → save. The service now never spins down.

> Free plan budget:750 instance-hours/month; always-on uses ~730 — it fits.
> If Render ever suspends the service for the month, your data is untouched in
> Neon and it resumes automatically next month.

### A4 · Create the GitHub OAuth app (enables one-click sign-in)

On github.com: **Settings → Developer settings → OAuth Apps → New OAuth App**:

| Field | Value |
|---|---|
| Application name | CodeSync |
| Homepage URL | `https://<your-service>.onrender.com` |
| Authorization callback URL | `https://<your-service>.onrender.com/api/v1/auth/github/callback` |

Copy the **Client ID** and generate a **Client secret**, put both into the Render
environment variables (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), then
**Manual Deploy → Trigger Manual Deploy** so they take effect.

### A5 · Connect the extension

1. Install the extension (see README), open **Options**.
2. **API base URL** → `https://<your-service>.onrender.com`.
3. Press **Sign in with GitHub** → authorize → the token is stored automatically.
   *(No OAuth app? Use the PAT fallback — same one-step result.)*
4. Pick/create your repository → **Save settings**. Done — submit a problem and
   watch it land in GitHub.

### A6 · Day-2 operations

* **Updates:** `git push` to `master` → Render redeploys automatically.
* **Logs:** Render dashboard → service → Logs.
* **Database backup:** Neon free keeps your data continuously; optionally run a
  `pg_dump` now and then. Worst case, a lost DB only means users reconnect with
  one click and re-pick their repository.

---

## Option B — your own VM (full control)

Works on any VPS. [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/)
is the best free-forever VM — but like AWS/GCP/Azure it **verifies identity with a
credit card** (never charged on the free tier). If you're fine with that:

1. **Create the VM:** Oracle → Compute → Instances → Create → image **Canonical
   Ubuntu24.04**, shape **VM.Standard.A1.Flex** (1 OCPU /6 GB — Always Free allows
   up to4 OCPU/24 GB), paste your SSH public key (`ssh-keygen -t ed25519`), create.
   Open **SSH (22) only** in the security list. If the shape reports *"Out of
   capacity"*, try another region (Mumbai/Phoenix usually work).
2. **Install Docker and fetch the project:**

```bash
ssh -i ~/.ssh/yourkey ubuntu@<PUBLIC_IP>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
git clone https://github.com/deepak25000000/CodeSync.git && cd CodeSync
cp .env.example .env
python3 -c "import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"   # -> CREDENTIALS_KEY
nano .env    # set CREDENTIALS_KEY, ENVIRONMENT=production, PUBLIC_BASE_URL
```

3. **HTTPS:** free **Cloudflare tunnel** — add your domain to a free Cloudflare
   account (nameserver wizard) → *Zero Trust → Networks → Tunnels → Create a
   tunnel (Cloudflared)* → copy the install command → on the VM run it → in the
   dashboard add Public Hostname `codesync.yourdomain.com → http://127.0.0.1:8000`.
   Set `PUBLIC_BASE_URL=https://codesync.yourdomain.com`. *(No domain? Run
   `cloudflared tunnel --url http://127.0.0.1:8000` for a free ephemeral
   `*.trycloudflare.com` URL and use the PAT connect instead of OAuth.)*
4. **Start:** `docker compose up -d --build` → `docker compose ps` shows
   `healthy`; SQLite lives in the persistent `./data` folder — back it up with
   `tar czf backup.tgz data/`.
5. GitHub OAuth app (A4 with your domain) + extension setup (A5) as above.

---

## Option C — run it on your own PC (zero accounts)

No cloud at all: start the backend locally (README quickstart), then expose it:

```bash
cloudflared tunnel --url http://127.0.0.1:8000    # prints a free https://…trycloudflare.com URL
```

Point the extension at that URL and connect with the PAT fallback. Caveats: your
PC must be on while you solve, the URL changes on each tunnel restart, and use
`CREDENTIALS_KEY` + a real domain later if you share it with others.

---

## Security checklist (any option)

* [ ] `CREDENTIALS_KEY` is a long random value, stored only on the server
* [ ] `ENVIRONMENT=production`
* [ ] HTTPS is on (Render/tunnel provide it) — GitHub OAuth requires it
* [ ] Rate limiting left enabled (`RATE_LIMIT_ENABLED=true`)
* [ ] Database backups considered (Neon: occasional `pg_dump`; VM: `data/` tarball)

## Troubleshooting

| Symptom | Fix |
|---|---|
| Extension "Sign in with GitHub" fails | Backend has no OAuth app → use the PAT option, or set `GITHUB_CLIENT_ID/SECRET` and redeploy |
| `OAUTH_NOT_CONFIGURED` on the portal | OAuth env vars missing/empty |
| Extension can't reach a remote URL | Browser asks for host permission on first save — allow it; URL must match exactly |
| Container/Render crash-loop at start | Usually invalid `CREDENTIALS_KEY` or an unreachable `DATABASE_URL` — check logs |
| First request after idle is slow | Free instance spun down — add the keep-alive monitor (A3) |
| Data lost after restart | You're on SQLite with an ephemeral disk — switch to `DATABASE_URL` + Neon (A1) |

More: [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
