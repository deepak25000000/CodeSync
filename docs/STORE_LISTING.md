# Chrome Web Store submission package

Artifact to upload: `extension/release/codesync-extension-v{VERSION}.zip`
(produced by `npm run release`; `manifest.json` must sit at the zip root).

## Listing copy

**Name:** CodeSync — Sync coding solutions to GitHub

**Summary** (≤ 127 chars):
> Auto-save accepted solutions from LeetCode, GeeksforGeeks and CodeChef straight
> into your GitHub repository.

**Category:** Developer tools · **Language:** English

**Description:**

> CodeSync watches your coding-practice sites and keeps a GitHub repository of
> your accepted solutions up to date — automatically.
>
> • Detects accepted submissions on LeetCode, GeeksforGeeks and CodeChef
>   (plus NeetCode for manual sync).
> • Saves each solution as a properly named file in the language you actually
>   submitted (Python, C++, Java, JavaScript, TypeScript, Go, Rust and 20+ more).
> • Keeps a `progress.json` index and a progress table in your repo README.
> • Exactly-once syncs: fingerprints prevent duplicate commits on retries.
> • Your GitHub credentials never reach the extension — they stay encrypted on
>   your own CodeSync backend.

**Screenshots** (required, ≥ 2): 1280×800 or 640×400 — popup queue view, and a
GitHub repository showing synced solution files.

## Single purpose

"Detect accepted coding submissions on practice sites and sync them to the
user's GitHub repository." Every permission below serves that purpose.

## Permission justifications (store form)

| Permission | Justification |
|---|---|
| `storage` | Remembers API base URL, token and queue state between sessions. |
| `alarms` | Retries queued syncs with backoff without holding the service worker awake. |
| Host access `http://127.0.0.1/*`, `http://localhost/*` | Talks to the user's own CodeSync backend. |
| Content script access to leetcode.com, geeksforgeeks.org, codechef.com, neetcode.io | Reads the submission the user just made on those sites (verdict, code, language, title). |
| Optional host permission (any site) | Only requested when the user points the backend at a non-localhost address. |

No `scripting`, `tabs`, `webRequest`, `downloads` or `identity` permissions; no
remote code, no inline scripts (asserted by the manifest test suite).

## Privacy

* **Data collected: none by the developer.** All traffic goes to the backend URL
  the user configures (their own server by default).
* API tokens are stored as SHA-256 hashes; GitHub tokens are encrypted
  server-side (Fernet) and never leave the backend.
* A **privacy policy URL is required** in the dashboard when the extension
  handles authentication/tokens — publish `docs/SECURITY.md` content (or a
  derived policy) at a public URL and reference it in the listing.

## Submission steps

1. `npm run release` (green tests, fresh `dist/`, zip + sha256 produced).
2. Chrome Web Store Developer Dashboard → new item → upload the zip.
3. Fill listing copy, screenshots, permission justifications, privacy policy URL.
4. Publish for review; subsequent releases: bump both versions, re-run
   `npm run release`, upload over the existing item.
