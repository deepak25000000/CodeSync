# Acceptance tests (human, live environment)

Everything automated is covered by `backend/pytest` (145 tests) and
`extension/npm test` (113 tests). This checklist is for the parts that **cannot** be
honest without real accounts: live platform DOMs, real GitHub, a real browser.

Prerequisites: backend running with a real `CREDENTIALS_KEY`, extension built and
loaded, a GitHub account with a `repo`-scoped token, and accounts on the platforms
you want to verify.

## A. Connection

| # | Step | Expected |
|---|---|---|
| A1 | Open `http://127.0.0.1:8000` | Portal renders; OAuth button only when configured |
| A2 | Connect with a PAT | One-time `cs_…` token shown; GitHub avatar/login echoed |
| A3 | Paste token into extension Options → *Test connection* | Green chip with your GitHub login |
| A4 | Revoke the token via `DELETE /auth/tokens/{id}`, then *Test connection* | Fails with `AUTH_INVALID` |

## B. LeetCode

| # | Step | Expected |
|---|---|---|
| B1 | Submit an accepted solution | Within seconds popup shows 1 queued item |
| B2 | Wait for the job | State → SYNCED; repo gains `DSA-Solutions/LeetCode/NNNN-slug.<ext>` |
| B3 | Check `progress.json` + README in the repo | Both updated; README keeps your other content |
| B4 | Re-submit the same page / press *Sync now* | No new commit (fingerprint dedupe) |
| B5 | Submit a wrong answer | No queue item (verdict `rejected`) |

## C. GeeksforGeeks / CodeChef

Repeat B1–B4 per platform. Note GFG often shows code only on the result page — verify
the code body is complete, not truncated.

## D. NeetCode

| # | Step | Expected |
|---|---|---|
| D1 | Visit a NeetCode problem page | No auto-detected submission |
| D2 | Options → Manual submission (paste code) | Item queued with verdict `manual`, syncs to `NeetCode/` |

## E. Failure handling

| # | Step | Expected |
|---|---|---|
| E1 | Stop the backend, click *Sync now* | Items stay pending with a network error; resume works after restart |
| E2 | Delete the repo on GitHub, then sync | `NOT_FOUND`, job FAILED after retries; no crash |
| E3 | Reconnect GitHub with a token lacking write access | `PERMISSION_DENIED`, permanent failure |
| E4 | Hand-create a file at the target path, then sync | `CONFLICT`; your file is untouched |

## F. Privacy

| # | Step | Expected |
|---|---|---|
| F1 | `chrome://extensions` → inspect service worker → storage | No GitHub token present |
| F2 | Backend logs during a sync | No `ghp_`/`Bearer` values, secrets redacted |
| F3 | `DELETE /account` | Login + every dependent row gone; token rejected |

Record results (pass/fail, browser, date) below when you run this:

| Date | Browser | Tester | Result |
|---|---|---|---|
| — | — | — | pending human run |
