# Cutting a CodeSync extension release

A release is a reproducible, versioned zip that anyone can install without Node.js.

## Versioning

* Semantic versioning, kept in lockstep in **two** files:
  `extension/manifest.json` → `version` and `extension/package.json` → `version`.
* Bump rules: `patch` (fixes), `minor` (new capability), `major` (breaking
  onboarding/migration for existing users).
* The manifest version is what Chrome (and the Web Store) uses to detect updates.

## Checklist

```bash
cd extension
npm run release        # = npm test && npm run build && node release.mjs
```

1. **Tests** — the command runs the whole vitest suite first; a red suite aborts
   the release. Both suites must be green: `cd backend && pytest` too.
2. **Build** — `dist/` is regenerated from source (including the PNG icons);
   it is a gitignored artifact and must never be committed.
3. **Zip** — `release/codesync-extension-v{VERSION}.zip` contains the `dist/`
   files at the zip root (store method, UTF-8 names) plus a `.sha256` sidecar.
   Verify it extracts and `manifest.json` sits at the root.
4. **Commit** — commit the source changes *and* the new zip + sidecar to the
   local repository with a conventional message
   (`chore(release): v1.2.0`), per the git workflow in `AGENTS.md`.
5. **Push / tag** — only when explicitly requested (`git push`, `git tag`).
   GitHub is never an automatic step.

## Installing a release build

Extract the zip into a stable folder → `chrome://extensions` → Developer mode →
**Load unpacked** → select the folder. After extracting, users never rebuild;
they only repeat "Load unpacked" when installing a newer release zip.

## Web Store

`docs/STORE_LISTING.md` covers the submission package, listing copy, permission
justifications and the privacy-policy requirement.
