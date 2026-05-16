/**
 * shell.js — WorkTrace dashboard shell.
 *
 * Responsibilities:
 *   1. Auth — first visit prompts for a fine-grained GitHub PAT scoped to
 *      Contents:Read on the private worktrace-data repo. Token cached in
 *      localStorage (per-browser, per-device). Never sent anywhere except
 *      api.github.com directly from the user's browser.
 *   2. Identity — once authed, fetch users/registry.json from the data repo
 *      to know who's on the platform. We don't have a "logged-in user"
 *      concept (the GH PAT belongs to whoever pasted it); the user picks
 *      themselves from the registry on first visit and that choice is
 *      cached in localStorage too.
 *   3. Module loading — read module-registry.json (next to this file),
 *      dynamic-import each enabled module's module.js, call its lifecycle
 *      hooks (init/renderTile/renderDetail) with a `shell` services object.
 *   4. Routing — tile-grid view ↔ detail view. URL hash: #/ or #/<moduleId>.
 *   5. Header — live local date/time, platform title, current user, sign-out.
 *
 * Module contract (each module's default export):
 *   {
 *     id: string,               // matches the registry entry
 *     displayName: string,
 *     description?: string,
 *     schemaVersion: number,
 *     dataPath?: string,        // optional override of "modules/<id>/users"
 *     stylesheet?: string,      // optional path to module.css (relative to module.js)
 *     async init?(shell): void, // one-time setup; can stash state on `this`
 *     async renderTile(container, ctx): void,    // ctx = { shell, currentUser, allUsers, fetchData }
 *     async renderDetail(container, ctx): void,
 *   }
 *
 * Vanilla JS, no framework, no build step. Targets modern evergreen
 * browsers (top-level await, dynamic import, ES2020+).
 */

// ============================================================
// Config + constants
// ============================================================

const LS = {
  pat:       'wt:gh_pat',
  userId:    'wt:user_id',     // the user_id from users/registry.json this browser is viewing as
};

const GITHUB_API = 'https://api.github.com';
const REGISTRY_PATH = 'users/registry.json';

let SHELL_STATE = {
  registry: null,             // module-registry.json (loaded once at boot)
  dataRegistry: null,         // users/registry.json from the data repo
  modules: [],                // [{ definition, container }, ...] in load order
  currentUser: null,          // entry from data registry, e.g. { user_id, display_name, ... }
  headerTimer: null,
};

// ============================================================
// DOM helpers (no jQuery, no nothing)
// ============================================================

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    if (typeof c === 'string' || typeof c === 'number') {
      node.appendChild(document.createTextNode(String(c)));
    } else {
      node.appendChild(c);
    }
  }
  return node;
}

function show(sel) { $(sel).hidden = false; }
function hide(sel) { $(sel).hidden = true; }

// ============================================================
// GitHub API helpers
// ============================================================

/**
 * Fetch a JSON file from the private data repo using the cached PAT.
 *
 * @param {string} path  Path within the repo (e.g., 'users/registry.json').
 * @returns {Promise<any>} Parsed JSON.
 * @throws {Error} On 401 (bad token), 404 (path missing), other HTTP errors.
 */
async function ghFetchJSON(path) {
  const reg = SHELL_STATE.registry.data_repo;
  const url = `${GITHUB_API}/repos/${reg.owner}/${reg.name}/contents/${path}?ref=${reg.branch}`;
  const pat = localStorage.getItem(LS.pat);
  if (!pat) throw new Error('No PAT in localStorage — please sign in.');

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.raw',
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Authentication failed. Your PAT may be invalid or revoked. Please sign in again.');
  }
  if (res.status === 404) {
    throw new Error(`File not found at ${path}.`);
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * List directory contents in the data repo (uses GitHub's contents API
 * which returns an array for directories). Returns filename → path.
 */
async function ghListDir(path) {
  const reg = SHELL_STATE.registry.data_repo;
  const url = `${GITHUB_API}/repos/${reg.owner}/${reg.name}/contents/${path}?ref=${reg.branch}`;
  const pat = localStorage.getItem(LS.pat);
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`Failed to list ${path}: HTTP ${res.status}`);
  const items = await res.json();
  return items.filter(i => i.type === 'file');
}

// ============================================================
// Auth flow
// ============================================================

async function tryAuth(pat) {
  // Validate by hitting the registry path. If 401 → bad token. If 404 → repo
  // exists but registry not in place yet (unusual). If 200 → good.
  const reg = SHELL_STATE.registry.data_repo;
  const url = `${GITHUB_API}/repos/${reg.owner}/${reg.name}/contents/${REGISTRY_PATH}?ref=${reg.branch}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.raw',
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Invalid token, or your PAT doesn\'t have Contents:Read on this repo.');
  }
  if (!res.ok) {
    throw new Error(`Validation request failed: HTTP ${res.status}.`);
  }
  return res.json(); // the parsed registry
}

function bindLoginForm() {
  const input = $('#wt-pat-input');
  const submit = $('#wt-login-submit');
  const errBox = $('#wt-login-error');

  async function doLogin() {
    const pat = input.value.trim();
    if (!pat) return;
    errBox.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const registry = await tryAuth(pat);
      // Auth succeeded — persist and proceed.
      localStorage.setItem(LS.pat, pat);
      SHELL_STATE.dataRegistry = registry;
      await afterAuth();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  }

  submit.addEventListener('click', doLogin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

function signOut() {
  localStorage.removeItem(LS.pat);
  localStorage.removeItem(LS.userId);
  location.reload();
}

// ============================================================
// User picker — first visit (or when stored user_id no longer exists)
// ============================================================

async function chooseUser() {
  const users = SHELL_STATE.dataRegistry.users.filter(u => u.active);
  if (users.length === 1) {
    // Trivial case — only one user. Pick them.
    SHELL_STATE.currentUser = users[0];
    localStorage.setItem(LS.userId, users[0].user_id);
    return;
  }
  const cachedId = localStorage.getItem(LS.userId);
  if (cachedId) {
    const found = users.find(u => u.user_id === cachedId);
    if (found) {
      SHELL_STATE.currentUser = found;
      return;
    }
  }
  // Prompt: render an inline picker into #wt-app and wait for the click.
  show('#wt-app');
  const app = $('#wt-app');
  app.innerHTML = '';
  app.appendChild(
    el('div', { class: 'wt-detail' },
      el('h2', { class: 'wt-detail__title' }, 'Who are you?'),
      el('p', { class: 'wt-tile__desc' }, 'Pick yourself from the registry. Your choice is remembered per browser.'),
      el('div', { class: 'wt-grid', style: 'margin-top: 16px;' },
        ...users.map(u =>
          el('div', {
              class: 'wt-tile',
              onclick: () => {
                SHELL_STATE.currentUser = u;
                localStorage.setItem(LS.userId, u.user_id);
                renderShell();
              },
            },
            el('h3', { class: 'wt-tile__name' }, u.display_name),
            el('p', { class: 'wt-tile__desc' }, `@${u.github_login}`),
            el('p', { class: 'wt-tile__desc', style: 'margin-top: 12px;' },
              `Modules: ${(u.modules_enabled || []).join(', ') || '(none)'}`)
          )
        )
      )
    )
  );
  // Wait — chooseUser is called from afterAuth; the click handler reruns renderShell
  // which calls chooseUser again (now with a cached id), which returns immediately.
  // We throw a special sentinel to unwind the call stack so afterAuth doesn't try
  // to render the grid before the user picks.
  throw new Error('__pending_user_choice__');
}

// ============================================================
// Header
// ============================================================

function renderHeader() {
  const header = $('#wt-header');
  header.innerHTML = '';
  const dateEl = el('div', { class: 'wt-header__date' });
  const titleEl = el('div', { class: 'wt-header__title', html:
    '<span class="wt-accent">WorkTrace</span> — AI-Powered Developer Productivity Platform' });
  const userEl = el('div', { class: 'wt-header__user' },
    el('span', { class: 'wt-header__user-name' }, SHELL_STATE.currentUser?.display_name || ''),
    el('button', { class: 'wt-header__signout', onclick: signOut, title: 'Sign out' }, 'Sign out')
  );
  header.append(dateEl, titleEl, userEl);
  show('#wt-header');

  // Live clock — updates every second. Stop the previous timer if any.
  if (SHELL_STATE.headerTimer) clearInterval(SHELL_STATE.headerTimer);
  const tick = () => {
    const now = new Date();
    const date = now.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dateEl.textContent = `${date} · ${time}`;
  };
  tick();
  SHELL_STATE.headerTimer = setInterval(tick, 1000);
}

// ============================================================
// Module lifecycle
// ============================================================

async function loadModule(moduleEntry) {
  const moduleUrl = `./modules/${moduleEntry.id}/module.js`;
  const mod = await import(moduleUrl);
  const def = mod.default;
  if (!def || def.id !== moduleEntry.id) {
    throw new Error(`Module ${moduleEntry.id}: default export missing or id mismatch`);
  }

  // Lazy-load module's stylesheet (if declared)
  if (def.stylesheet) {
    const cssId = `wt-module-css--${def.id}`;
    if (!document.getElementById(cssId)) {
      const link = document.createElement('link');
      link.id = cssId;
      link.rel = 'stylesheet';
      link.href = `./modules/${moduleEntry.id}/${def.stylesheet}`;
      document.head.appendChild(link);
    }
  }

  // shell services object — modules use this to fetch data.
  //
  // Per-user-repo model (Phase 5a+): each user's data repo holds exactly
  // one user's data, stored at `modules/<id>/data.json`. No per-user
  // subdirectories. fetchUserData / listAllUserData take a `dataRepoOverride`
  // arg for admin views that iterate across multiple repos — Phase 5d wires
  // that up. For non-admin users, the single fetchMyData() is all they need.
  const shellApi = {
    currentUser: SHELL_STATE.currentUser,
    allUsers: SHELL_STATE.dataRegistry.users.filter(u => u.active),
    /** Fetch the current user's data file for this module. */
    async fetchMyData() {
      const dataPath = def.dataPath || `modules/${def.id}/data.json`;
      return ghFetchJSON(dataPath);
    },
    /** Fetch a specific user's data file for this module.
     * In Phase 5a, only one user exists in a given data repo, so this is
     * functionally equivalent to fetchMyData(). Phase 5d's admin view will
     * extend this with a `dataRepoOverride` to fetch across user repos. */
    async fetchUserData(_userId) {
      const dataPath = def.dataPath || `modules/${def.id}/data.json`;
      return ghFetchJSON(dataPath);
    },
  };

  if (typeof def.init === 'function') {
    await def.init(shellApi);
  }
  return { definition: def, shellApi };
}

// ============================================================
// Routing — hash-based
// Routes:
//   #/                 → grid (tile view)
//   #/<moduleId>       → detail view for one module
// ============================================================

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '').trim();
  if (!h) return { name: 'grid' };
  return { name: 'detail', moduleId: h };
}

function go(route) {
  if (route.name === 'grid') location.hash = '#/';
  else if (route.name === 'detail') location.hash = `#/${route.moduleId}`;
}

window.addEventListener('hashchange', () => renderRoute());

// ============================================================
// Render
// ============================================================

async function renderRoute() {
  const app = $('#wt-app');
  app.innerHTML = '';
  show('#wt-app');

  const route = currentRoute();
  if (route.name === 'grid') {
    const grid = el('div', { class: 'wt-grid' });
    app.appendChild(grid);
    for (const m of SHELL_STATE.modules) {
      const tile = el('div', { class: 'wt-tile', onclick: () => go({ name: 'detail', moduleId: m.definition.id }) },
        el('div', { class: 'wt-tile__header' },
          el('h3', { class: 'wt-tile__name' }, m.definition.displayName),
          el('span', { class: 'wt-tile__desc' }, m.definition.description || '')
        ),
        el('div', { class: 'wt-tile__body' },
          el('div', { class: 'wt-tile__placeholder' }, 'Loading…')
        )
      );
      grid.appendChild(tile);
      // Render asynchronously — failures in one tile don't block others.
      m.definition.renderTile(tile.querySelector('.wt-tile__body'), m.shellApi)
        .catch(err => {
          tile.querySelector('.wt-tile__body').innerHTML = '';
          tile.querySelector('.wt-tile__body').appendChild(
            el('p', { class: 'wt-tile__placeholder', style: 'color: var(--wt-danger);' },
              `Error: ${err.message}`)
          );
        });
    }
  } else if (route.name === 'detail') {
    const m = SHELL_STATE.modules.find(x => x.definition.id === route.moduleId);
    if (!m) {
      app.appendChild(el('p', { class: 'wt-error' }, `Unknown module: ${route.moduleId}. ` ));
      return;
    }
    const wrap = el('div', { class: 'wt-detail' },
      el('button', { class: 'wt-detail__back', onclick: () => go({ name: 'grid' }) }, '← Back'),
      el('h2', { class: 'wt-detail__title' }, m.definition.displayName)
    );
    const body = el('div');
    wrap.appendChild(body);
    app.appendChild(wrap);
    try {
      await m.definition.renderDetail(body, m.shellApi);
    } catch (err) {
      body.appendChild(el('p', { class: 'wt-error' }, `Error: ${err.message}`));
    }
  }
}

function renderShell() {
  hide('#wt-login');
  renderHeader();
  renderRoute();
}

// ============================================================
// Boot sequence
// ============================================================

async function afterAuth() {
  // We already have SHELL_STATE.dataRegistry from tryAuth(); otherwise refetch.
  if (!SHELL_STATE.dataRegistry) {
    SHELL_STATE.dataRegistry = await ghFetchJSON(REGISTRY_PATH);
  }
  try {
    await chooseUser();
  } catch (err) {
    if (err.message === '__pending_user_choice__') return;
    throw err;
  }
  // Load all enabled modules from the registry
  const enabled = SHELL_STATE.registry.modules.filter(m => m.enabled);
  SHELL_STATE.modules = [];
  for (const entry of enabled) {
    try {
      const loaded = await loadModule(entry);
      SHELL_STATE.modules.push(loaded);
    } catch (err) {
      console.error(`Failed to load module ${entry.id}:`, err);
      // Continue loading others
    }
  }
  renderShell();
}

async function boot() {
  // 1. Load module-registry.json (always required)
  try {
    SHELL_STATE.registry = await (await fetch('./module-registry.json')).json();
  } catch (err) {
    document.body.innerHTML =
      '<div style="padding:32px;font-family:sans-serif;color:#c0392b;">' +
      'Failed to load module-registry.json. The dashboard is misconfigured.' +
      '</div>';
    return;
  }

  // 2. Check for cached PAT — if present, try to auto-sign-in
  const pat = localStorage.getItem(LS.pat);
  if (pat) {
    try {
      SHELL_STATE.dataRegistry = await tryAuth(pat);
      await afterAuth();
      return;
    } catch (err) {
      // Bad cached token — fall through to login screen
      console.warn('Cached PAT failed:', err.message);
      localStorage.removeItem(LS.pat);
    }
  }

  // 3. Show login screen
  bindLoginForm();
  show('#wt-login');
}

document.addEventListener('DOMContentLoaded', boot);
