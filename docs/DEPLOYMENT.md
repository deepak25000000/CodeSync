# Deploying the CodeSync backend — production-ready, free for life

This guide runs the backend in Docker on a **free-forever** server. The recommended
target is **Oracle Cloud Always Free** (a real VM you keep for as long as your Oracle
account is in good standing — no credit card charges, no request limits). The stack
(FastAPI + SQLite + one worker) is tiny: ~150 MB RAM, a few hundred MB disk.

Alternatives that also work with the same compose file: any VPS, a home server, or
**Google Cloud's free-tier e2-micro** (US regions only,1 GB RAM — enough).

---

## 0. What you get

```
Chrome extension ──HTTPS──▶ Cloudflare Tunnel ──▶ docker compose (your VM)
   (any user)                                     FastAPI + SQLite on a volume
                                                      │
                                                      └──▶ GitHub Contents API
```

* Users connect the extension with **one click** ("Sign in with GitHub") — no tokens
  to copy, no config on the coding sites.
* The server holds the GitHub credentials (encrypted at rest); the extension never
  sees them.

---

## 1. Create the free-forever server (Oracle Cloud Always Free)

1. Sign up at <https://www.oracle.com/cloud/free/> (always-free account; a credit card
   is only used for identity verification).
2. **Create a VM:**
   * Menu → **Compute → Instances → Create instance**
   * Image: **Canonical Ubuntu24.04 (or22.04)** — pick the **aarch64/Arm** build if offered
   * Shape: **VM.Standard.A1.Flex** with **1 OCPU /6 GB** (Always Free allows up to
     4 OCPU /24 GB across instances — more than enough)
   * Add an **SSH key** you control (or generate one with `ssh-keygen`)
   * Boot volume:20 GB is plenty
   * Save the instance's **public IP**
3. Allow ingress traffic (your firewall/security list): **SSH only (port22)**. Nothing
   else needs to be open — the tunnel (step3) connects *outbound*, and the API is not
   exposed publicly.
4. Connect: `ssh -i ~/.ssh/yourkey ubuntu@<PUBLIC_IP>`

---

## 2. Install Docker and get the project onto the VM

```bash
# Docker (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker

# The project (either clone from GitHub, or copy the repo with scp)
git clone https://github.com/deepak25000000/CodeSync.git
cd CodeSync
```

Create the environment file:

```bash
cp .env.example .env
nano .env       # or vim
```

Minimum required values:

```dotenv
CREDENTIALS_KEY=<generate: python3 -c "import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())">
ENVIRONMENT=production
PUBLIC_BASE_URL=https://<your-domain-or-tunnel-url>
# Optional but recommended — enables one-click "Sign in with GitHub" (step4):
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

`CREDENTIALS_KEY` encrypts stored GitHub credentials — generate a fresh random value
per deployment and never commit it.

---

## 3. Put it behind HTTPS (free)

The extension and GitHub OAuth both want a stable **HTTPS** URL. Two options:

### Option A — you own a domain (recommended, stable URL)

Use a **Cloudflare tunnel** (free) so the VM needs no open inbound ports and gets a
stable HTTPS URL. Everything is configured from the Cloudflare dashboard — no
certificate or firewall work:

1. **Add the domain to Cloudflare** — free account at <https://dash.cloudflare.com>
   → *Add a domain* → follow the wizard (it asks you to change the nameservers at
   your registrar) → wait until the domain shows **Active**.
2. **Create the tunnel:** *Zero Trust → Networks → Tunnels → Create a tunnel →
   Cloudflared* → name it `codesync` → the next screen shows an install command
   containing your **tunnel token** — copy it (private; you'll run it on the VM).
3. **Add the public hostname** on the same page: *Public Hostname → Add a public
   hostname* → Subdomain `codesync`, Domain `yourdomain.com`, Service `HTTP`,
   URL `http://127.0.0.1:8000` → Save.
4. **On the VM**, install cloudflared and start the tunnel service:

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
sudo cloudflared service install <TOKEN-FROM-STEP-2>
sudo systemctl enable --now cloudflared
```

5. Verify it is live: `curl -s https://codesync.yourdomain.com/api/v1/health`

Set `PUBLIC_BASE_URL=https://codesync.yourdomain.com` in `.env` (before
`docker compose up`, step 5).

> No domain? Free options: [eu.org](https://eu.org) (free subdomain you can put on
> Cloudflare; approval can take days) or a cheap registrar (~₹100/yr). Otherwise use
> Option B.

### Option B — no domain (quick tunnel)

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

It prints an `https://….trycloudflare.com` URL. Set that as `PUBLIC_BASE_URL`.
**Caveats:** the URL changes when the tunnel restarts (update it in the extension
afterwards), and GitHub's OAuth callback can't be pre-registered — so users connect
with the **PAT option** in the extension instead of one-click OAuth (step6).

---

## 4. Create the GitHub OAuth app (enables one-click sign-in)

Only needed for Option A. On GitHub: **Settings → Developer settings → OAuth Apps →
New OAuth App**:

| Field | Value |
|---|---|
| Application name | CodeSync |
| Homepage URL | `https://codesync.yourdomain.com` |
| Authorization callback URL | `https://codesync.yourdomain.com/api/v1/auth/github/callback` |

Copy the **Client ID**, generate a **Client Secret**, and put both in `.env`
(`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`).

---

## 5. Start the backend

```bash
docker compose up -d --build
docker compose ps          # healthy within ~10s (built-in healthcheck)
curl http://127.0.0.1:8000/api/v1/health
```

The container runs migrations on start (`alembic upgrade head`), runs as a non-root
user, stores the SQLite database in the `./data` folder (survives rebuilds), and
restarts automatically on reboot/crash.

Visit `https://codesync.yourdomain.com` — the portal should render.

---

## 6. Connect the extension (what your users do)

1. Install the extension (`extension/release/codesync-extension-vX.Y.Z.zip` → extract →
   `chrome://extensions` → Developer mode → **Load unpacked**).
2. Open **Options → Connection** → set **API base URL** to your URL → press
   **Sign in with GitHub**. The backend issues the API token and stores it in the
   extension automatically — nothing to copy.
   * No OAuth app (Option B)? Open *"Connect with a GitHub PAT instead"* and paste a
     GitHub PAT with the `repo` scope — same one-step result.
3. Under **Repository**: pick an existing repo or create one, choose branch and root
   folder, press **Save settings**.
4. Solve and submit a problem — the solution lands in the repo automatically.

---

## 7. Operating it

```bash
docker compose logs -f            # live logs
docker compose pull && docker compose up -d --build   # update after git pull
```

**Backups** — the whole state is one SQLite file in `./data`:

```bash
tar czf codesync-backup-$(date +%F).tgz data/
```

Copy it off-box periodically (or `scp` it home). Restore = stop the container, untar
`data/`, start again.

**Resource usage** — steady state ~150 MB RAM; the free VM shape is far beyond what
this needs.

### Security checklist

* [ ] `CREDENTIALS_KEY` is a long random value, stored only on the server
* [ ] `ENVIRONMENT=production`
* [ ] Only SSH (22) open inbound; API reachable through the tunnel only
      (compose binds `127.0.0.1:8000` by default)
* [ ] HTTPS is on (tunnel or Let's Encrypt) — GitHub OAuth requires it
* [ ] Rate limiting left enabled (`RATE_LIMIT_ENABLED=true`)
* [ ] `docker compose` volumes backed up

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Extension "Sign in with GitHub" fails | Backend has no OAuth app configured → use the PAT option, or set `GITHUB_CLIENT_ID/SECRET` and restart |
| `OAUTH_NOT_CONFIGURED` on the portal | Same as above — OAuth env vars missing/empty |
| Extension can't reach a remote URL | Browser asks for host permission on first save — allow it; URL must be the exact `PUBLIC_BASE_URL` |
| Container unhealthy | `docker compose logs backend` — usually a missing/invalid `CREDENTIALS_KEY` |
| Database lost after redeploy | You're not using the bundled compose file's `./data` volume — mount persistent storage |

More: [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
