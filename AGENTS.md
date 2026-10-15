# CodeSync — project rules

## Git workflow (mandatory)

Every change made to this project **must be committed to the local git repository** the
moment it is complete and verified (tests/build passing where applicable).

- **Commit locally, always.** Never leave modified or new files sitting uncommitted.
  `git status` must be clean after each unit of work.
- **Pushing to GitHub is a separate, explicit step.** Only run `git push` when the user
  explicitly asks for it. By default: local commits only.
- **Never stage secrets**: `.env`, tokens, keys, credentials. Review `git status` and
  stage only the files relevant to the change.
- **Commit messages**: conventional and specific — `fix(scope): …`, `feat(scope): …`,
  `docs: …`, `chore: …`, with a short body explaining what/why.
- **Pre-existing working-tree changes not made by you** (possible work-in-progress of the
  user): don't silently discard them — leave them uncommitted, include them only if they
  belong to the change at hand, or ask the user.

## Context

FastAPI backend (`backend/`) + Chrome MV3 extension (`extension/`). See `README.md` for
quickstart, `docs/` for architecture and capability docs. Extension tests: `npm test`;
build: `npm run build`.
