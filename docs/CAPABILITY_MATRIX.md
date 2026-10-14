# Platform capability matrix

Adapters live in `extension/src/adapters/` and are mirrored server-side in
`backend/app/platforms.py` (served by `GET /api/v1/meta` and `GET /api/v1/platforms`).
Every claim marked *fixture-tested* is verified by the vitest suites in
`extension/tests/adapters/` against sanitized DOM fixtures — not against live sites
(see [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md)).

| Capability | LeetCode | GeeksforGeeks | CodeChef | NeetCode |
|---|---|---|---|---|
| Submission detection | yes | yes | yes | **no** |
| Verdict extraction (`accepted`/`rejected`/`pending`) | yes | yes | yes | **no** |
| Solution code extraction (editor DOM) | yes | yes (result page) | yes | **no** |
| Problem metadata (title / id / url) | yes | yes | yes | yes |
| Submission id | yes | no | yes | no |
| Timestamp | yes | yes | yes | no |
| Requires login | yes | yes | yes | no |
| Auto-sync | yes | yes | yes | **manual only** |
| Manual sync (paste code in Options → *Manual submission*) | yes | yes | yes | yes |
| Fixture-tested | yes | yes | yes | yes |

## Why NeetCode is limited

NeetCode (neetcode.io) is a practice tracker / roadmap, not a judge: it renders
problems and links out to the platform that actually runs your code. It exposes no
accepted-submission event, no verdict and no stored submission code, so no honest
"auto-sync on accept" integration is possible. CodeSync therefore:

* recognizes NeetCode pages and captures **problem metadata** (title, id, URL),
* lets you associate that metadata with the linked platform problem,
* supports an explicit **manual sync** (you paste the solution in the extension
  Options; the verdict is recorded as `manual` and the solution is committed like any
  other).

## DOM reality check

Adapters fall through several selector families per field and degrade to `null`
instead of throwing. Live sites A/B-test markup constantly; when a selector breaks,
the submission is not silently mis-synced — the verdict comes back `unknown`, the
submission is stored as `UNSUPPORTED`, and nothing is queued.
