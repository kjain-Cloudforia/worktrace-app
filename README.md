# worktrace-app

Public dashboard for **WorkTrace** — an AI-powered developer productivity platform.

This repository holds **only HTML/JS/CSS**. No data. The data lives in the sibling private repo (`worktrace-data`) and is fetched at runtime by the viewer's browser using a viewer-supplied GitHub PAT.

**Live dashboard:** https://kjain-Cloudforia.github.io/worktrace-app/ *(once GitHub Pages is enabled — Settings → Pages → main branch → `/docs` folder)*

## How it works

```
┌────────────────────────────────────────────────────────────────────┐
│  Your browser (opens dashboard URL)                                │
│  1. Loads index.html + shell.js + module CSS/JS from this repo     │
│  2. First visit: paste a fine-grained PAT with Contents:Read on    │
│     `worktrace-data`. Token cached in localStorage on this device. │
│  3. shell.js fetches users/registry.json from worktrace-data       │
│  4. For each enabled module: dynamic import → renderTile / detail  │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼  (HTTPS, Authorization: Bearer <PAT>)
┌────────────────────────────────────────────────────────────────────┐
│  api.github.com — GitHub Contents API                              │
│  Serves files from worktrace-data/modules/<m>/users/*.json         │
└────────────────────────────────────────────────────────────────────┘
```

The dashboard is a single static page; no backend; nothing is logged on any server.

## Layout

```
worktrace-app/
├── README.md
└── docs/                              ← GitHub Pages source folder
    ├── index.html                     ← shell skeleton
    ├── shell.js                       ← auth, header, login, module loader
    ├── shell.css                      ← global styles
    ├── module-registry.json           ← list of modules to load (in order)
    ├── lib/                           ← vendored libs (Chart.js, etc.) — future
    └── modules/
        ├── timesheet/                 ← Timesheet module
        │   ├── module.js
        │   └── module.css
        ├── <module-2>/                ← future
        └── ...
```

## Adding a new module

1. Create `docs/modules/<id>/module.js` with a default export following the contract in `docs/shell.js`.
2. Optionally create `docs/modules/<id>/module.css` and reference it via `stylesheet: 'module.css'` in the export.
3. Register the module by adding an entry to `docs/module-registry.json`.
4. Commit + push. GitHub Pages rebuilds in ~30s.

No changes to `index.html` or `shell.js` required.

## Privacy

- This repo is **public** by design — but it contains no data, only HTML/JS code.
- All data fetching happens in the viewer's browser using their own PAT scoped to the private `worktrace-data` repo.
- The PAT lives in browser `localStorage` on the viewer's device. It is never sent anywhere except `api.github.com` directly.
- Sign-out clears the cached token from localStorage. Revoke at GitHub Settings → Developer settings → Personal access tokens.

## Local development

Open `docs/index.html` via a local server — `file://` won't work because `import('./modules/...')` requires HTTP. Easiest:

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000/
```
