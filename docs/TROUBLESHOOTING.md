# Troubleshooting

## Backend

**`CREDENTIALS_KEY is not configured` (500 on connect)**
Generate a key and put it in `backend/.env`:
`python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"`

**`401 GITHUB_REJECTED` when connecting a PAT**
The token is invalid, expired, or lacks the `repo` scope. Classic PATs need `repo`;
fine-grained PATs need *Contents: Read and write* on the target repository.

**`AUTH_MISSING` / job fails immediately**
The stored GitHub connection was revoked or never existed. Reconnect via the portal
(`/`). The API token and the GitHub connection are separate; revoking one does not
re-issue the other.

**`NO_REPOSITORY`**
Pick a repository in the extension Options (or `PATCH /api/v1/settings` with
`{"repo_full_name": "owner/repo"}`).

**`CONFLICT` on sync**
A file already exists at the target path and was not created by CodeSync (no
`codesync-fp:` marker). Rename/remove that file or change `root_folder`, then retry
the job.

**`PERMISSION_DENIED`**
The GitHub token cannot write to that repository. Check the repo's Settings →
Collaborators, and the token scopes.

**`RATE_LIMITED` (from GitHub)**
The job is re-queued with `RETRY_PENDING`; GitHub resets the window (hourly for
personal tokens). Nothing to do — or wait and hit `POST /sync/{id}/retry`.

**Server won't start: `ModuleNotFoundError: No module named 'app'`**
Run uvicorn from `backend/` (or set `PYTHONPATH` to the `backend` directory).

**Tables missing**
Dev mode auto-creates them on startup. Otherwise run `alembic upgrade head` in
`backend/`.

## Extension

**Nothing syncs**
Open Options → *Test connection*. If it fails: token wrong, backend down, or host
permission missing. Non-`localhost` API bases require granting the optional host
permission when prompted.

**Adapters detect nothing**
Make sure you are on a submission/result page while logged in to the platform.
Adapters are fixture-tested against sanitized DOMs — live sites change their markup;
check the queue view in Options for adapter errors and see
[ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md).

**Queued item stuck with `NO_TOKEN`**
Set the API token in Options.

**Duplicate entries**
Duplicates are impossible by fingerprint; the popup may still show historical items.
*Clear failed* / *Sync now* re-drives the queue safely — replayed events are no-ops.

**Load unpacked fails**
Build first: `cd extension && npm run build`, then select `extension/dist`
(not `extension/`).

## Data & privacy

Everything CodeSync stores server-side is listed in `docs/API.md` (users,
oauth_connections, api_tokens, user_settings, platform_integrations, submissions,
sync_jobs, sync_attempts). `DELETE /account` removes all of it.
