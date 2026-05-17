# worktrace-app

Public dashboard for **WorkTrace** — an AI-powered developer productivity platform.

This repository holds **only HTML/JS/CSS**. No data, no credentials. All data lives in private per-user repos (`worktrace-data-<username>`); all credentials live in [`worktrace-auth`](https://github.com/kjain-Cloudforia/worktrace-auth) as AES-GCM ciphertext.

**Live dashboard:** https://kjain-Cloudforia.github.io/worktrace-app/

## Architecture at a glance

```
                            Browser (no backend)
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
        worktrace-app        worktrace-auth      worktrace-data-<u>
        (PUBLIC)             (PUBLIC,            (PRIVATE,
        HTML/JS/CSS          ciphertext only)    one per user)
        Pages source         users/<u>.json      modules/<m>/data.json
                             escrow/<u>.json
                             admin.recovery.json
```

Three repos, separated by what's in them:
- **`worktrace-app`** (this repo) — dashboard code. Public so GitHub Pages serves it free.
- **`worktrace-auth`** — encrypted credentials. Public because the *ciphertext* is safe to expose.
- **`worktrace-data-<u>`** — per-user data. Private; one per user.

## How a sign-in works

```
1. User opens https://kjain-Cloudforia.github.io/worktrace-app/
2. Types username + password
3. Browser fetches worktrace-auth/users/<username>.json (no PAT needed — public file)
4. Browser runs PBKDF2(password, salt, 600_000 iters) → AES-256 key
5. Browser AES-GCM-decrypts the embedded ciphertext → user's GitHub PAT
6. Browser uses the PAT to fetch worktrace-data-<username>/modules/<m>/data.json
7. Dashboard renders the user's modules
```

The password never leaves the browser. The PAT is cached in `sessionStorage` for the duration of the tab (gone on tab close). If the password is wrong, AES-GCM's MAC check fails — no false positives.

## Repository layout

```
worktrace-app/
├── README.md                       ← this file
├── ONBOARDING.md                   ← new-teammate walkthrough
└── docs/                           ← GitHub Pages source folder
    ├── index.html                  ← shell skeleton
    ├── shell.js                    ← auth, login, modal infra, module loader, recovery
    ├── shell.css                   ← global styles + password-field reveal toggle
    ├── module-registry.json        ← which modules to load, in what order
    ├── auth/
    │   └── auth.js                 ← Web Crypto wrapper: PBKDF2 + AES-GCM
    ├── schema/
    │   └── auth-user/v1.json       ← user-record schema
    └── modules/
        ├── timesheet/
        │   ├── module.js           ← tile + detail views
        │   └── module.css
        └── admin/
            ├── module.js           ← roster, create/reset/revoke users, view-as-X
            └── module.css
```

## Modules

| Module | Tile view | Detail view | Visibility |
|---|---|---|---|
| **Timesheet** | Latest entry + counts | Week-by-week timeline of all entries | All users (admin's record has `hideForAdmin`) |
| **Admin Console** | Roster aggregates (member / admin / repo counts) | User cards with View timesheet · Reset password · Revoke buttons + Add team member | Admin only (`requiresAdmin: true`) |

## Adding a new module

1. Create `docs/modules/<id>/module.js` exporting a default object matching the module contract documented in `docs/shell.js`.
2. Optional: `docs/modules/<id>/module.css`, referenced via `stylesheet: 'module.css'` in the export.
3. Add an entry to `docs/module-registry.json`.
4. Commit + push. GitHub Pages rebuilds in ~30s.

The module contract:

```js
export default {
  id: 'mymodule',
  displayName: 'My Module',
  description: 'One-line description',
  schemaVersion: 1,
  stylesheet: 'module.css',          // optional
  requiresAdmin: false,              // gate to admin-only?
  hideForAdmin: false,               // hide for admin records?
  dataPath: 'modules/mymodule/data.json',  // path inside user's data repo

  async init(shell) { /* one-time setup */ },
  async renderTile(container, ctx) { /* small tile view */ },
  async renderDetail(container, ctx) { /* full-screen detail view */ },
};
```

The shell exposes via `ctx`:
- `ctx.currentUser` — public fields of the signed-in user
- `ctx.fetchMyData()` — read this module's data file from the current user's data repo
- `ctx.fetchUserDataFromRepo(ownerRepo)` — admin: read another user's data
- `ctx.ghFetch(ownerRepo, path)` — raw GitHub Contents API helper
- `ctx.commitAuth(path, body, message)` — write to `worktrace-auth` (admin uses this for write ops)
- `ctx.deleteAuth(path, message)` — delete from `worktrace-auth` (admin uses for revoke)
- `ctx.openModal(contents)` / `ctx.closeModal()` — modal overlay helpers

## Password recovery

Two flows, both built into the dashboard:

1. **User forgot password →** admin uses Admin Console → Reset password. Recovery code unlocks the user's escrow file; admin sets a new temporary password.
2. **Admin forgot password →** Login screen → "Admin: forgot password?" Recovery code unlocks `admin.recovery.json`; admin sets a new password and is auto-signed-in.

The recovery code is a 24-char Crockford-base32 string (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`, ~120 bits). Admin stashes it offline (1Password, paper) at setup. See [`worktrace-auth/README.md`](https://github.com/kjain-Cloudforia/worktrace-auth/blob/main/README.md) for the full design rationale.

If both the password AND the recovery code are lost: `~/Documents/DevPlatform/scripts/reset_admin.py` is the last-resort fallback (reads the admin PAT from local `config.json`).

## Privacy & security

- **This repo is public.** Code only, no data.
- **All data fetching happens in the viewer's browser** using their own PAT (which they don't even see — it's decrypted from `worktrace-auth` at login).
- **The PAT lives only in `sessionStorage`** — cleared on tab close.
- **Sign-out clears the cached PAT.** Revoke at GitHub Settings → Developer settings → Personal access tokens if you want a hard kill.
- **`raw.githubusercontent.com` is never used for auth reads.** Always `api.github.com/contents` with `Accept: application/vnd.github.v3.raw` — the raw CDN caches by path and serves stale blobs after writes, which broke us multiple times during recovery work.

## Local development

`docs/index.html` uses native ES module imports, so `file://` won't work. Easiest:

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000/
```

Sign in normally; the local browser hits the real GitHub for auth + data. Iteration cycle is: edit file → refresh page.

## Related repos

- [`worktrace-auth`](https://github.com/kjain-Cloudforia/worktrace-auth) — encrypted credentials store
- `worktrace-data-<username>` — per-user private data repos (one per teammate)
- Local sync layer: `~/Documents/DevPlatform/` on each laptop (`dpsync.py` orchestrator)
