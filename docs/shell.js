/**
 * shell.js — WorkTrace dashboard shell.
 *
 * Responsibilities:
 *   1. Auth — username/password sign-in. The dashboard fetches
 *      worktrace-auth/users/<username>.json (public, encrypted blob),
 *      derives an AES-GCM key from the password (PBKDF2 600k iters), and
 *      decrypts the embedded PAT. PAT is cached in sessionStorage so it
 *      stays for the duration of the browser tab and clears on close.
 *   2. Identity — `is_admin` flag on the auth file gates admin features;
 *      `data_repo` field points at the user's per-user data repo.
 *   3. Module loading — read module-registry.json, dynamic-import each
 *      enabled module's module.js, call its renderTile / renderDetail.
 *   4. Routing — tile-grid view ↔ detail view via URL hash: #/ or #/<id>.
 *   5. Header — live local date/time, platform title, current user, sign-out.
 *
 * Module contract (each module's default export):
 *   {
 *     id: string,
 *     displayName: string,
 *     description?: string,
 *     schemaVersion: number,
 *     dataPath?: string,        // path within the data repo (default: modules/<id>/data.json)
 *     stylesheet?: string,
 *     requiresAdmin?: boolean,  // true → module loads only for is_admin users
 *     async init?(shell): void,
 *     async renderTile(container, ctx): void,
 *     async renderDetail(container, ctx): void,
 *   }
 *
 * Vanilla JS, no framework, no build step. Targets modern evergreen browsers.
 */

import {
  unlockUserRecord,
  rekeyUserRecord,
  checkPasswordStrength,
  unlockRecoveryRecord,
  normalizeRecoveryCode,
  encryptSecret,
  buildEscrowRecord,
  unlockEscrowRecord,
} from './auth/auth.js';

// ============================================================
// Config + constants
// ============================================================

const SS = {
  pat:      'wt:gh_pat_v2',     // PAT cached in sessionStorage (cleared on tab close)
  username: 'wt:username',
  // Note: NOT localStorage — sessionStorage clears when the browser tab
  // closes, which is the right blast radius for an auto-decrypted credential.
};

const GITHUB_API = 'https://api.github.com';
const AUTH_RAW   = 'https://raw.githubusercontent.com/kjain-Cloudforia/worktrace-auth/main/users';
// Contents API path for worktrace-auth — used as the AUTHORITATIVE source
// for auth records (sign-in, recovery, password change). Unlike raw.github
// usercontent.com, this endpoint is keyed by commit, never CDN-cached
// stale, and works without a PAT for public repos.
const AUTH_API   = 'https://api.github.com/repos/kjain-Cloudforia/worktrace-auth/contents';

let SHELL_STATE = {
  registry: null,        // module-registry.json (loaded once at boot)
  currentUser: null,     // { username, display_name, data_repo, is_admin, managed_repos? }
  pat: null,             // in-memory; mirrored to sessionStorage for tab persistence
  modules: [],           // [{ definition, shellApi }, ...] in load order
  headerTimer: null,
};

// ============================================================
// DOM helpers
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
// GitHub API — fetch JSON from the current user's data repo
// ============================================================

/**
 * Fetch a JSON file from the current user's data_repo using their decrypted PAT.
 * The path is repo-relative (e.g. 'modules/timesheet/data.json').
 */
async function ghFetchFromCurrentRepo(path) {
  if (!SHELL_STATE.currentUser?.data_repo) {
    throw new Error('No data repo configured for the current user.');
  }
  if (!SHELL_STATE.pat) throw new Error('Not signed in.');
  const url = `${GITHUB_API}/repos/${SHELL_STATE.currentUser.data_repo}/contents/${path}?ref=main`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${SHELL_STATE.pat}`,
      'Accept': 'application/vnd.github.raw',
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Your session expired or the token is no longer valid. Please sign in again.');
  }
  if (res.status === 404) {
    const err = new Error(`File not found at ${path}.`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Fetch a JSON file from an arbitrary repo (for admin cross-repo views).
 * Caller specifies the `owner/repo` string and the path.
 */
async function ghFetchFromRepo(ownerRepo, path) {
  if (!SHELL_STATE.pat) throw new Error('Not signed in.');
  const url = `${GITHUB_API}/repos/${ownerRepo}/contents/${path}?ref=main`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${SHELL_STATE.pat}`,
      'Accept': 'application/vnd.github.raw',
    },
  });
  if (!res.ok) {
    const err = new Error(`Fetch ${ownerRepo}/${path} → HTTP ${res.status}`);
    err.code = res.status === 404 ? 'NOT_FOUND' : 'API_ERROR';
    throw err;
  }
  return res.json();
}

// ============================================================
// Auth flow
// ============================================================

/**
 * Fetch the auth file for a given username from worktrace-auth.
 *
 * Important: GitHub's `raw.githubusercontent.com` is served via a CDN
 * that can return a stale copy for several minutes after a write. The
 * dashboard relies on always getting the *current* ciphertext, otherwise:
 *  - After a password change, sign-in with the new password would fail
 *    (CDN returns the pre-rekey blob; new password doesn't decrypt it).
 *  - After a password change, sign-in with the old password would still
 *    work (CDN's stale blob is the pre-rekey one).
 *
 * Two defenses, both applied:
 *  1. A per-request `?_=<random>` query string so the CDN treats every
 *     fetch as a fresh URL (most CDNs don't cache by querystring).
 *  2. `cache: 'no-store'` to bypass the browser's HTTP cache.
 *
 * Returns the encrypted user record JSON, or throws on 404 / parse error.
 */
async function fetchAuthRecord(username) {
  // Use the Contents API instead of raw.githubusercontent.com — the raw
  // CDN keys its cache by path (ignoring query strings), so a cache-buster
  // doesn't help when an edge is serving the pre-rekey blob. The API
  // returns the authoritative content for the current commit.
  //
  // Accept: vnd.github.v3.raw makes the response body the file itself
  // (rather than the wrapping {content: base64} envelope). The endpoint
  // is public-readable for our public repo — no PAT needed.
  const buster = `?_=${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const url = `${AUTH_API}/users/${encodeURIComponent(username)}.json${buster}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3.raw' },
    cache: 'no-store',
  });
  if (res.status === 404) {
    const err = new Error('No such user.');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }
  if (!res.ok) throw new Error(`Failed to fetch auth record: HTTP ${res.status}`);
  return res.json();
}

/**
 * Run the full sign-in dance:
 *   - fetch the user's auth file
 *   - decrypt under the password (AES-GCM throws on wrong password)
 *   - extract the PAT + public fields
 *   - sanity-check the PAT works against the user's data_repo
 *   - cache in sessionStorage and SHELL_STATE
 */
async function signInWithCredentials(username, password) {
  username = (username || '').trim().toLowerCase();
  if (!username) throw new Error('Enter your username.');
  if (!password) throw new Error('Enter your password.');

  const record = await fetchAuthRecord(username);
  let pat, publicFields;
  try {
    const unlocked = await unlockUserRecord(record, password);
    pat = unlocked.pat;
    publicFields = unlocked.record;
  } catch (_) {
    // Don't leak whether the user exists vs the password is wrong.
    const err = new Error('Incorrect username or password.');
    err.code = 'BAD_PASSWORD';
    throw err;
  }

  // Sanity-check: the PAT must be able to reach the user's data repo
  // (or, for an admin record with data_repo=null, the auth repo itself).
  const probeRepo = publicFields.data_repo || 'kjain-Cloudforia/worktrace-auth';
  const probe = await fetch(
    `${GITHUB_API}/repos/${probeRepo}`,
    { headers: { 'Authorization': `Bearer ${pat}` } },
  );
  if (probe.status === 401 || probe.status === 403) {
    throw new Error('Your stored credential has been revoked. Contact the admin to re-issue it.');
  }
  if (!probe.ok) {
    throw new Error(`Couldn't reach your data repository (HTTP ${probe.status}).`);
  }

  SHELL_STATE.currentUser = publicFields;
  SHELL_STATE.pat = pat;
  sessionStorage.setItem(SS.pat, pat);
  sessionStorage.setItem(SS.username, username);
}

function signOut() {
  sessionStorage.removeItem(SS.pat);
  sessionStorage.removeItem(SS.username);
  SHELL_STATE.pat = null;
  SHELL_STATE.currentUser = null;
  if (SHELL_STATE.headerTimer) clearInterval(SHELL_STATE.headerTimer);
  // Replace location so the previous URL hash (#/timesheet, etc.) doesn't
  // survive the reload — otherwise after sign-in the user lands directly
  // into the detail route of whatever module they were last in.
  location.replace(location.pathname);
}

/**
 * Try to resume a previous session from sessionStorage.
 * Returns true on success, false on failure (e.g. token expired/revoked).
 */
async function trySessionResume() {
  const pat = sessionStorage.getItem(SS.pat);
  const username = sessionStorage.getItem(SS.username);
  if (!pat || !username) return false;

  try {
    // Re-fetch the auth file's public fields (so display_name etc. stay
    // current if admin updated the record between tabs).
    const record = await fetchAuthRecord(username);
    const { kdf, iterations, salt, iv, ciphertext, ...publicFields } = record;
    SHELL_STATE.currentUser = publicFields;
    SHELL_STATE.pat = pat;
    return true;
  } catch (_) {
    sessionStorage.removeItem(SS.pat);
    sessionStorage.removeItem(SS.username);
    return false;
  }
}

// ============================================================
// Login form binding
// ============================================================

function bindLoginForm() {
  const userInput = $('#wt-username-input');
  const pwInput   = $('#wt-password-input');
  const submit    = $('#wt-login-submit');
  const errBox    = $('#wt-login-error');
  const workBox   = $('#wt-login-working');

  async function attempt() {
    const username = userInput.value;
    const password = pwInput.value;
    errBox.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    workBox.hidden = false;
    try {
      await signInWithCredentials(username, password);
      // Success — switch UI to the app
      hide('#wt-login');
      pwInput.value = ''; // don't leave password in the DOM
      await afterAuth();
    } catch (err) {
      errBox.textContent = err.message || 'Sign-in failed.';
      errBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
      workBox.hidden = true;
    }
  }

  submit.addEventListener('click', attempt);
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwInput.focus(); });

  // Forgot password — opens the admin recovery-code modal.
  // Currently the recovery flow is admin-only because only admin has a
  // recovery record (admin.recovery.json). Non-admins lose their password
  // → admin resets it via the Admin Console's reset-user flow.
  const forgotLink = $('#wt-forgot-link');
  if (forgotLink) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      openAdminRecoveryModal();
    });
  }
}

// ============================================================
// Admin password recovery (via recovery code)
// ============================================================

/**
 * Fetch the admin recovery record from worktrace-auth. Uses the Contents
 * API for the same reason as fetchAuthRecord — raw CDN caches by path
 * and can serve a stale recovery blob for minutes after the file is
 * regenerated, which would cause "Recovery code is incorrect" errors
 * for the freshly-minted code.
 */
async function fetchAdminRecoveryRecord() {
  const buster = `?_=${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const url = `${AUTH_API}/admin.recovery.json${buster}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3.raw' },
    cache: 'no-store',
  });
  if (res.status === 404) {
    throw new Error('Admin recovery is not set up. Run scripts/build_recovery_artifacts.py.');
  }
  if (!res.ok) throw new Error(`Failed to fetch recovery record (HTTP ${res.status})`);
  return res.json();
}

/**
 * Open the "Forgot password" modal for the admin account.
 *
 * Flow:
 *   1. Admin enters the recovery code (handed to them at setup time)
 *      and a new password.
 *   2. We fetch admin.recovery.json, decrypt it with the code → admin PAT.
 *   3. We pull the current admin.json (preserve immutable fields).
 *   4. We re-encrypt the PAT under the new password → new admin.json.
 *   5. We sign in as admin with the new password so they land in the
 *      dashboard with a working session.
 */
function openAdminRecoveryModal() {
  const codeInput    = el('input', { type: 'text', autocomplete: 'off',
                                     placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
  const newPwInput   = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirmInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const errBox  = el('p', { class: 'wt-modal__error', hidden: true });
  const workBox = el('p', { class: 'wt-modal__working', hidden: true });
  const submit  = el('button', { class: 'wt-modal__submit' }, 'Reset admin password');
  const cancel  = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

  async function attempt() {
    errBox.hidden = true;
    const code    = codeInput.value;
    const newPw   = newPwInput.value;
    const confirm = confirmInput.value;

    if (!code || !newPw || !confirm) {
      errBox.textContent = 'Fill in all three fields.';
      errBox.hidden = false;
      return;
    }
    try {
      normalizeRecoveryCode(code); // throws if shape is wrong
    } catch {
      errBox.textContent = 'Recovery code must be 24 Crockford characters (letters + digits, hyphens optional).';
      errBox.hidden = false;
      return;
    }
    if (newPw !== confirm) {
      errBox.textContent = 'New password and confirmation do not match.';
      errBox.hidden = false;
      return;
    }
    const policy = checkPasswordStrength(newPw);
    if (!policy.ok) {
      errBox.textContent = 'New password does not meet policy: ' + policy.reasons.join(' ');
      errBox.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Recovering…';
    workBox.hidden = false;
    workBox.textContent = 'Unlocking recovery record (≈2s PBKDF2)…';

    try {
      // 1. Fetch the recovery record + current admin record. Need both —
      //    recovery to decrypt the PAT, current for immutable metadata.
      const [recovery, currentAdmin] = await Promise.all([
        fetchAdminRecoveryRecord(),
        fetchAuthRecord('admin'),
      ]);

      // 2. Decrypt recovery → admin PAT plaintext.
      let adminPat;
      try {
        adminPat = await unlockRecoveryRecord(recovery, code);
      } catch {
        errBox.textContent = 'Recovery code is incorrect.';
        errBox.hidden = false;
        return;
      }

      // 3. Re-encrypt the PAT under the new password.
      workBox.textContent = 'Re-encrypting admin record (≈2s)…';
      const newBundle = await encryptSecret(adminPat, newPw);
      const newRecord = {
        ...currentAdmin,
        ...newBundle,
        updated_at: new Date().toISOString(),
      };

      // 4. We need a PAT in hand to commit. Use the admin PAT we just
      //    decrypted — it has Contents:Write on worktrace-auth by
      //    construction (it's the admin token). Stash it in SHELL_STATE
      //    so commitToAuthRepo picks it up.
      SHELL_STATE.pat = adminPat;
      workBox.textContent = 'Saving new admin record…';
      await commitToAuthRepo(
        'users/admin.json',
        JSON.stringify(newRecord, null, 2) + '\n',
        'Admin password recovered via recovery code',
      );

      // 5. Sign the admin in directly — they came here to recover, not
      //    re-type their fresh password. Mirrors the post-change UX of
      //    the existing Change Password flow.
      sessionStorage.setItem(SS.pat, adminPat);
      sessionStorage.setItem(SS.username, 'admin');
      SHELL_STATE.currentUser = (({ kdf, iterations, salt, iv, ciphertext, ...rest }) => rest)(newRecord);

      closeModal();
      hide('#wt-login');
      await afterAuth();
    } catch (err) {
      errBox.textContent = `Recovery failed: ${err.message || err}`;
      errBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Reset admin password';
      workBox.hidden = true;
    }
  }

  submit.addEventListener('click', attempt);
  cancel.addEventListener('click', closeModal);

  openModal([
    el('h2', {}, 'Admin password recovery'),
    el('p', { class: 'wt-modal__lead' },
      'Use the recovery code you stashed when admin was first set up. ' +
      'The code unlocks the admin PAT so you can set a new password.'),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Recovery code'),
      codeInput,
      el('p', { class: 'wt-modal__hint' },
        '24 characters. Hyphens, spaces, and lowercase are all OK — we normalise on submit.')
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'New admin password'),
      newPwInput,
      el('p', { class: 'wt-modal__hint' },
        'Min 12 chars, mixed case, one digit. Write it down somewhere this time.')
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Confirm new password'),
      confirmInput
    ),
    errBox,
    workBox,
    el('div', { class: 'wt-modal__actions' }, cancel, submit),
  ]);
}

// ============================================================
// Modal infrastructure (used by change-password, future flows)
// ============================================================

function openModal(contents) {
  const modal = $('#wt-modal');
  const panel = modal.querySelector('.wt-modal__panel');
  panel.innerHTML = '';
  contents.forEach(c => panel.appendChild(c));
  show('#wt-modal');
  // Esc closes
  document.addEventListener('keydown', _modalEscHandler);
  // Backdrop click closes (only when the actual backdrop is clicked,
  // not the panel inside it).
  modal.querySelector('.wt-modal__backdrop')
       .addEventListener('click', _modalBackdropHandler);
  // Focus the first input for snappy typing
  const firstInput = panel.querySelector('input');
  if (firstInput) firstInput.focus();
}

function closeModal() {
  hide('#wt-modal');
  document.removeEventListener('keydown', _modalEscHandler);
}

function _modalEscHandler(e) { if (e.key === 'Escape') closeModal(); }
function _modalBackdropHandler() { closeModal(); }

// ============================================================
// GitHub commit helper (for write operations like password change)
// ============================================================

const AUTH_REPO = 'kjain-Cloudforia/worktrace-auth';

/**
 * Convert a UTF-8 string to base64 (browser-safe; handles non-ASCII).
 * GitHub Contents API expects content in base64.
 */
function strToBase64(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * Commit a file to worktrace-auth via the GitHub Contents API.
 *
 * Caller MUST hold a PAT (in SHELL_STATE.pat) with Contents:Read+Write
 * on worktrace-auth. For a regular user this is true if their PAT
 * scope was extended; for admin it always is.
 *
 * Handles both create (no `sha`) and update (with current sha for
 * optimistic concurrency control).
 */
async function commitToAuthRepo(path, contentString, commitMessage) {
  const url = `${GITHUB_API}/repos/${AUTH_REPO}/contents/${path}`;
  // Probe for existing file to grab its SHA — required by the PUT
  // endpoint when updating, must be omitted when creating.
  let sha = null;
  const probe = await fetch(url, {
    headers: { 'Authorization': `Bearer ${SHELL_STATE.pat}` },
  });
  if (probe.status === 200) {
    sha = (await probe.json()).sha;
  } else if (probe.status !== 404) {
    throw new Error(`Failed to read existing file: HTTP ${probe.status}`);
  }
  const body = {
    message: commitMessage,
    content: strToBase64(contentString),
    branch: 'main',
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${SHELL_STATE.pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Commit failed: HTTP ${res.status} — ${txt.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * List + re-key every escrow/*.json file in worktrace-auth so they stay
 * unlockable by the admin's NEW password. Called from the Change Password
 * flow when admin changes their own password (escrows are encrypted under
 * admin's password, so they'd otherwise become unreadable + reset-user
 * would silently break).
 *
 * Each file is re-fetched, decrypted with the old admin password, the
 * embedded user-PAT extracted, re-encrypted under the new admin password,
 * and committed back. We do this serially (not parallel) to keep the
 * GitHub API happy on small teams and to give clear progress feedback.
 *
 * Returns the count of files rekeyed. Throws on any failure — the caller
 * is responsible for telling the admin "your password is changed but
 * escrow rekey failed, run scripts/build_recovery_artifacts.py".
 */
async function rebuildAllEscrowFiles(oldAdminPw, newAdminPw, progressCallback) {
  // 1. List every file under escrow/ via the Contents API.
  const listUrl = `${AUTH_API}/escrow`;
  const listRes = await fetch(listUrl, { cache: 'no-store' });
  if (listRes.status === 404) {
    // No escrow directory exists yet — nothing to rebuild.
    return 0;
  }
  if (!listRes.ok) {
    throw new Error(`Failed to list escrow files (HTTP ${listRes.status})`);
  }
  const files = (await listRes.json())
    .filter(f => f.type === 'file' && f.name.endsWith('.json'));

  // 2. For each escrow file: fetch, decrypt with old pw, re-encrypt under new pw, commit.
  let count = 0;
  for (const f of files) {
    if (typeof progressCallback === 'function') {
      progressCallback(`Re-keying escrow for ${f.name.replace(/\.json$/, '')} (${count + 1}/${files.length})…`);
    }
    const contentUrl = `${AUTH_API}/escrow/${encodeURIComponent(f.name)}`;
    const r = await fetch(contentUrl, {
      headers: { 'Accept': 'application/vnd.github.v3.raw' },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`Failed to fetch escrow/${f.name} (HTTP ${r.status})`);
    const escrow = await r.json();

    let userPat;
    try {
      userPat = await unlockEscrowRecord(escrow, oldAdminPw);
    } catch {
      throw new Error(`Old admin password doesn't unlock escrow/${f.name}. ` +
                      `It may have been built under a different password — run scripts/build_recovery_artifacts.py.`);
    }

    const username = escrow.username || f.name.replace(/\.json$/, '');
    const newEscrow = await buildEscrowRecord({
      username, pat: userPat, adminPassword: newAdminPw,
    });
    await commitToAuthRepo(
      `escrow/${f.name}`,
      JSON.stringify(newEscrow, null, 2) + '\n',
      `Rekey escrow for ${username} (admin password changed)`,
    );
    count++;
  }
  return count;
}

// ============================================================
// Change-password flow
// ============================================================

function openChangePasswordModal() {
  if (!SHELL_STATE.currentUser) return;

  const oldInput = el('input', { type: 'password', autocomplete: 'current-password' });
  const newInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirmInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const errBox  = el('p', { class: 'wt-modal__error', hidden: true });
  const workBox = el('p', { class: 'wt-modal__working', hidden: true });
  const submit  = el('button', { class: 'wt-modal__submit' }, 'Change password');
  const cancel  = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

  async function attempt() {
    errBox.hidden = true;
    const oldPw = oldInput.value;
    const newPw = newInput.value;
    const confirmPw = confirmInput.value;

    if (!oldPw || !newPw || !confirmPw) {
      errBox.textContent = 'Fill in all three fields.';
      errBox.hidden = false;
      return;
    }
    if (newPw !== confirmPw) {
      errBox.textContent = 'New password and confirmation do not match.';
      errBox.hidden = false;
      return;
    }
    if (newPw === oldPw) {
      errBox.textContent = 'New password must be different from your current one.';
      errBox.hidden = false;
      return;
    }
    const policy = checkPasswordStrength(newPw);
    if (!policy.ok) {
      errBox.textContent = 'New password does not meet policy: ' + policy.reasons.join(' ');
      errBox.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Changing…';
    workBox.hidden = false;
    workBox.textContent = 'Re-encrypting (≈3 seconds — two PBKDF2 derivations)…';

    try {
      // 1. Fetch the user's current auth file (always re-fetch fresh so
      //    we have the latest server state, not whatever was cached at
      //    sign-in time).
      const currentRecord = await fetchAuthRecord(SHELL_STATE.currentUser.username);

      // 2. Re-key. This validates the old password (throws if wrong)
      //    and re-encrypts the underlying PAT with the new password.
      let newRecord;
      try {
        newRecord = await rekeyUserRecord(currentRecord, oldPw, newPw);
      } catch (e) {
        // AES-GCM throws on wrong password; surface as friendly error.
        if (e.code === 'WEAK_PASSWORD') {
          errBox.textContent = e.message;
        } else {
          errBox.textContent = 'Current password is incorrect.';
        }
        errBox.hidden = false;
        return;
      }

      // 3. Commit the updated user file back to worktrace-auth.
      workBox.textContent = 'Saving to worktrace-auth…';
      const path = `users/${SHELL_STATE.currentUser.username}.json`;
      await commitToAuthRepo(
        path,
        JSON.stringify(newRecord, null, 2) + '\n',
        `Password change for ${SHELL_STATE.currentUser.username}`,
      );

      // 3b. If the current user is an admin, every escrow/<u>.json was
      //     encrypted under their OLD password — those files would be
      //     unrecoverable after this point. Re-key them all under the
      //     new password so the reset-user flow keeps working.
      //     Non-admins don't touch escrow files: their password only
      //     guards their own users/<u>.json.
      if (SHELL_STATE.currentUser.is_admin) {
        try {
          const n = await rebuildAllEscrowFiles(
            oldPw, newPw,
            (msg) => { workBox.textContent = msg; },
          );
          if (n > 0) {
            workBox.textContent = `Re-keyed ${n} escrow file${n === 1 ? '' : 's'} under new admin password.`;
          }
        } catch (escrowErr) {
          // Don't roll back the admin-password change — it already
          // landed. Surface a follow-up action instead.
          errBox.textContent =
            'Admin password changed, but escrow re-key failed: ' + escrowErr.message +
            ' — run scripts/build_recovery_artifacts.py to repair before resetting any user.';
          errBox.hidden = false;
        }
      }

      // 4. Show success + force re-login. We don't try to silently
      //    keep the session — the cleanest UX is "sign in again with
      //    your new password" and it avoids any state-drift bugs.
      workBox.hidden = true;
      const panel = $('#wt-modal').querySelector('.wt-modal__panel');
      panel.innerHTML = '';
      panel.append(
        el('h2', {}, 'Password changed ✓'),
        el('p', { class: 'wt-modal__success' },
          'Your password has been updated. Please sign in again with your new password.'),
        el('div', { class: 'wt-modal__actions' },
          el('button', { class: 'wt-modal__submit', onclick: signOut }, 'Sign in again')
        )
      );
    } catch (err) {
      errBox.textContent = err.message || 'Something went wrong.';
      errBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Change password';
      workBox.hidden = workBox.textContent.startsWith('Saving') ? false : true;
    }
  }

  submit.addEventListener('click', attempt);
  cancel.addEventListener('click', closeModal);
  confirmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

  openModal([
    el('h2', {}, 'Change password'),
    el('p', { class: 'wt-modal__lead' },
      `Signed in as ${SHELL_STATE.currentUser.display_name || SHELL_STATE.currentUser.username}.`
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Current password'),
      oldInput,
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'New password'),
      newInput,
      el('p', { class: 'wt-modal__hint' },
        'At least 12 characters, mixed case, includes a digit.')
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Confirm new password'),
      confirmInput,
    ),
    el('div', { class: 'wt-modal__actions' }, cancel, submit),
    errBox,
    workBox,
  ]);
}

// ============================================================
// Header
// ============================================================

function renderHeader() {
  const header = $('#wt-header');
  header.innerHTML = '';
  const dateEl  = el('div', { class: 'wt-header__date' });
  const titleEl = el('div', { class: 'wt-header__title', html:
    '<span class="wt-accent">WorkTrace</span> — AI-Powered Developer Productivity Platform' });
  const userInfo = SHELL_STATE.currentUser?.display_name || SHELL_STATE.currentUser?.username || '';
  const adminBadge = SHELL_STATE.currentUser?.is_admin
    ? el('span', { class: 'wt-header__admin-badge', title: 'Admin session' }, 'admin')
    : null;
  const userEl  = el('div', { class: 'wt-header__user' },
    adminBadge,
    el('span', { class: 'wt-header__user-name' }, userInfo),
    el('button', {
      class: 'wt-header__changepw',
      onclick: openChangePasswordModal,
      title: 'Change your password',
    }, 'Change password'),
    el('button', { class: 'wt-header__signout', onclick: signOut, title: 'Sign out' }, 'Sign out')
  );
  header.append(dateEl, titleEl, userEl);
  show('#wt-header');

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

  // Admin gating:
  //  - `requiresAdmin: true`  → only admins see the tile
  //  - `hideForAdmin: true`   → only non-admins see the tile
  //    (modules with no data_repo for admin, e.g. Timesheet — admins
  //     access user timesheets via the Admin module's drill-in instead)
  const isAdmin = !!SHELL_STATE.currentUser?.is_admin;
  if (def.requiresAdmin && !isAdmin) return null;
  if (def.hideForAdmin && isAdmin) return null;

  // Lazy-load the module's stylesheet (if declared)
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

  // Shell services exposed to modules
  const shellApi = {
    get currentUser() { return SHELL_STATE.currentUser; },
    /** Fetch the current user's data file for this module. */
    async fetchMyData() {
      const dataPath = def.dataPath || `modules/${def.id}/data.json`;
      return ghFetchFromCurrentRepo(dataPath);
    },
    /**
     * Fetch a specific user's data from an explicit `owner/repo`.
     * Admins use this to view across user repos in Phase 5d.
     */
    async fetchUserDataFromRepo(ownerRepo) {
      const dataPath = def.dataPath || `modules/${def.id}/data.json`;
      return ghFetchFromRepo(ownerRepo, dataPath);
    },
    /** Raw GitHub API helper for admin operations (Phase 5e). */
    async ghFetch(ownerRepo, path) { return ghFetchFromRepo(ownerRepo, path); },
    /**
     * Commit a file into worktrace-auth via the current PAT. Used by
     * the admin module to write reset-user records and by the
     * change-password modal. Centralising it here so module code
     * never reaches into shell internals.
     */
    async commitAuth(path, contentString, commitMessage) {
      return commitToAuthRepo(path, contentString, commitMessage);
    },
    /** Modal helpers — modules build their own DOM, shell handles overlay. */
    openModal(contents) { openModal(contents); },
    closeModal() { closeModal(); },
  };

  if (typeof def.init === 'function') {
    await def.init(shellApi);
  }
  return { definition: def, shellApi };
}

// ============================================================
// Routing — hash-based
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
    if (SHELL_STATE.modules.length === 0) {
      grid.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'No modules enabled for this account.'));
      return;
    }
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
      // Tile renders independently — one failure doesn't block others.
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
      app.appendChild(el('p', { class: 'wt-error' }, `Unknown module: ${route.moduleId}.`));
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
// Post-auth setup: load modules then render
// ============================================================

async function afterAuth() {
  // Load all enabled modules from the registry, gated by is_admin.
  const enabled = (SHELL_STATE.registry.modules || []).filter(m => m.enabled);
  SHELL_STATE.modules = [];
  for (const entry of enabled) {
    try {
      const loaded = await loadModule(entry);
      if (loaded) SHELL_STATE.modules.push(loaded);
    } catch (err) {
      console.error(`Failed to load module ${entry.id}:`, err);
    }
  }
  renderShell();
}

// ============================================================
// Boot sequence
// ============================================================

async function boot() {
  // 1. Load module-registry.json (always required)
  try {
    SHELL_STATE.registry = await (await fetch('./module-registry.json', { cache: 'no-store' })).json();
  } catch (err) {
    document.body.innerHTML =
      '<div style="padding:32px;font-family:sans-serif;color:#c0392b;">' +
      'Failed to load module-registry.json. The dashboard is misconfigured.' +
      '</div>';
    return;
  }

  // 2. Try to resume a previous session
  if (await trySessionResume()) {
    await afterAuth();
    return;
  }

  // 3. Show the login form
  bindLoginForm();
  show('#wt-login');
}

document.addEventListener('DOMContentLoaded', boot);
