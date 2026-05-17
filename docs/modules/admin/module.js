/**
 * modules/admin/module.js
 *
 * Admin console for the WorkTrace dashboard. Only loads for users whose
 * worktrace-auth record has `is_admin: true` — shell.js gates this via
 * the `requiresAdmin` flag on the module export.
 *
 * Tile view: team-wide aggregates — member count, admin count, data-repo count.
 *
 * Detail view has two states (toggled by local UI state, not URL routing):
 *
 *   State A — user roster
 *     Card per user showing display name, GitHub login, data_repo,
 *     work shift, active status, last sync, entry count. Per-row actions:
 *       • "View timesheet"   — switches into State B for that user
 *       • "Reset password"   — recovery-code-driven password reset (Phase 5h)
 *       • "Revoke"           — deletes the user's auth + escrow files (Phase 5e)
 *     Plus a "+ Add team member" button at the top (Phase 5e create flow).
 *
 *   State B — viewing a specific user's timesheet
 *     Re-uses the Timesheet module's renderDetail with a shimmed ctx so
 *     the same UI code renders. Back button returns to State A.
 *
 * Data flow:
 *   - Listing users: GET worktrace-auth/users/ via the Contents API
 *     (public — no PAT needed for the listing). Then fetch each
 *     users/*.json individually for public fields. The ciphertext is
 *     present in the response but ignored — we never have decrypted
 *     PATs for other users.
 *   - Fetching a user's timesheet data: GET <their_data_repo>/modules/
 *     timesheet/data.json using THE ADMIN'S PAT (decrypted at sign-in).
 *     Admin's PAT has Read access to every worktrace-data-* repo because
 *     the org owns them.
 */

import timesheetModule from '../timesheet/module.js';
import {
  unlockEscrowRecord,
  unlockRecoveryRecord,
  encryptSecret,
  checkPasswordStrength,
  normalizeRecoveryCode,
  buildUserRecord,
  buildEscrowRecord,
  validateWorkShift,
  resolveActiveShift,
} from '../../auth/auth.js';

// ---- local helpers (kept private to this module) -----------------------

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
    node.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c)) : c);
  }
  return node;
}

// Mirror of shell.js passwordField — kept here so the admin module
// stays self-contained (same pattern as the local el() duplicate).
// CSS lives in shell.css under .wt-pw-field / .wt-pw-toggle.
const PW_EYE_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`;
const PW_EYE_OFF_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>`;

/**
 * Build a `<datalist>` of every IANA timezone the browser knows about.
 * Pair with a text input via `list="<id>"` to get autocomplete: user can
 * type "Asia" and see all Asian timezones, type "Los_" → America/Los_Angeles.
 * The datalist node is shared by id so multiple inputs in the same modal
 * reuse one list (browsers don't mind multiple inputs pointing at it).
 *
 * Supplements the browser's canonical list with popular aliases — see
 * the TZ_SUPPLEMENTS comment in shell.js for the rationale. Asia/Kolkata
 * is the headline example: macOS Safari omits it from supportedValuesOf
 * (uses Asia/Calcutta as canonical), but DateTimeFormat accepts both.
 */
const TZ_SUPPLEMENTS = [
  'Asia/Kolkata', 'Asia/Calcutta',
  'Asia/Ho_Chi_Minh', 'Asia/Saigon',
  'America/Buenos_Aires',
  'UTC', 'Etc/UTC', 'GMT',
];

function timezoneDatalist(id = 'wt-tz-datalist') {
  let dl = document.getElementById(id);
  if (dl) return dl;
  dl = el('datalist', { id });
  const browserZones = typeof Intl?.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [];
  const set = new Set(browserZones);
  for (const tz of TZ_SUPPLEMENTS) {
    if (set.has(tz)) continue;
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      set.add(tz);
    } catch { /* skip */ }
  }
  const final = [...set].sort();
  for (const tz of final) dl.appendChild(el('option', { value: tz }));
  document.body.appendChild(dl);
  return dl;
}

function passwordField(attrs = {}) {
  const input = el('input', { type: 'password', ...attrs });
  const toggle = el('button', {
    type: 'button',
    class: 'wt-pw-toggle',
    'aria-label': 'Show password',
    title: 'Show password',
    tabindex: '-1',
  });
  toggle.innerHTML = PW_EYE_SVG;
  toggle.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggle.innerHTML = showing ? PW_EYE_SVG : PW_EYE_OFF_SVG;
    const label = showing ? 'Show password' : 'Hide password';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    input.focus();
  });
  const wrapper = el('div', { class: 'wt-pw-field' }, input, toggle);
  wrapper.input = input;
  return wrapper;
}

// Use the Contents API for *all* worktrace-auth reads. raw.githubusercontent.com
// caches by path and can serve stale records for minutes after a write, which
// would cause spurious "wrong password" errors after a reset or rekey.
const AUTH_API_BASE  = 'https://api.github.com/repos/kjain-Cloudforia/worktrace-auth/contents';
const AUTH_USERS_API = `${AUTH_API_BASE}/users`;   // both listing + per-file fetches
const ESCROW_API     = `${AUTH_API_BASE}/escrow`;

/**
 * List every users/<u>.json file in worktrace-auth.
 * The repo is public so this requires no auth.
 */
async function listAllAuthFiles() {
  const res = await fetch(AUTH_USERS_API, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to list users (HTTP ${res.status})`);
  const items = await res.json();
  return items.filter(f => f.type === 'file' && f.name.endsWith('.json'));
}

/** Fetch one user's auth file (public fields only — we never use the ciphertext). */
async function fetchAuthFile(filename) {
  const buster = `?_=${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const res = await fetch(`${AUTH_USERS_API}/${filename}${buster}`, {
    headers: { 'Accept': 'application/vnd.github.v3.raw' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to fetch ${filename} (HTTP ${res.status})`);
  const full = await res.json();
  const { kdf, iterations, salt, iv, ciphertext, ...publicFields } = full;
  return publicFields;
}

/**
 * Fetch a user's full auth record INCLUDING ciphertext fields. Used only
 * by the reset-password flow, which needs to preserve immutable metadata
 * (created_at, github_login, managed_repos, …) when writing the new file.
 */
async function fetchAuthFileFull(username) {
  const buster = `?_=${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const res = await fetch(
    `${AUTH_USERS_API}/${encodeURIComponent(username)}.json${buster}`,
    { headers: { 'Accept': 'application/vnd.github.v3.raw' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch ${username}.json (HTTP ${res.status})`);
  return res.json();
}

/**
 * Fetch the escrow file for a given user. Returns null on 404 (escrow
 * missing — admin needs to run scripts/build_recovery_artifacts.py).
 */
async function fetchEscrowFile(username) {
  const buster = `?_=${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const res = await fetch(
    `${ESCROW_API}/${encodeURIComponent(username)}.json${buster}`,
    { headers: { 'Accept': 'application/vnd.github.v3.raw' }, cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch escrow/${username}.json (HTTP ${res.status})`);
  return res.json();
}

// Path within each user's data_repo where the Timesheet module's data
// lives. Hard-coded here because admin renders Timesheet data on behalf
// of users — it needs the *Timesheet* module's data path, not its own
// (admin doesn't have a data file of its own).
const TIMESHEET_DATA_PATH = 'modules/timesheet/data.json';

/**
 * Fetch a user's timesheet data through admin's PAT. Returns null on
 * 404 (user hasn't synced yet), and re-throws on auth errors so the
 * caller can show a clear message.
 */
async function fetchUserTimesheet(ctx, user) {
  if (!user.data_repo) return null;
  try {
    return await ctx.ghFetch(user.data_repo, TIMESHEET_DATA_PATH);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

function userInitials(user) {
  const name = user.display_name || user.username || '?';
  return name.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function fmtTs(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

// ---- Create-user flow (admin-triggered) --------------------------------

/**
 * Validate that the named auth file does NOT already exist. Returns
 * true if free (404), false if a record is present, throws on other
 * errors. We use the Contents API for consistency with the rest of
 * the module — raw CDN can't distinguish 404 from cache miss reliably.
 */
async function isUsernameFree(username) {
  const url = `${AUTH_USERS_API}/${encodeURIComponent(username)}.json`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3.raw' },
    cache: 'no-store',
  });
  if (res.status === 404) return true;
  if (res.status === 200) return false;
  throw new Error(`Couldn't check username availability (HTTP ${res.status})`);
}

/**
 * Open the "Add team member" modal.
 *
 * Pre-flight (admin's responsibility, NOT this flow):
 *   1. Create the data repo on GitHub (org/worktrace-data-<username>).
 *   2. Generate a fine-grained PAT for the new user with Contents:RW on
 *      that repo. Hand it to this flow.
 *
 * What this flow does:
 *   - Probes the data repo with the supplied PAT to confirm it works.
 *   - Confirms the recovery code unlocks admin.recovery.json (so we
 *     don't write an escrow file under a typo'd code that wouldn't
 *     match any future reset attempt).
 *   - Encrypts the user's PAT under the initial password → users/<u>.json
 *   - Encrypts the user's PAT under the recovery code → escrow/<u>.json
 *   - Commits both files.
 *   - Shows the initial password to admin with copy-to-clipboard so they
 *     can hand it off out-of-band.
 *
 * Success means BOTH files committed. If the second commit fails after
 * the first succeeds, we leave the partial state for manual cleanup —
 * a half-created user is recoverable (admin can re-run Add user; the
 * isUsernameFree check will tell them, and they can manually delete the
 * orphan via GitHub UI).
 */
function openCreateUserModal(ctx, refreshRoster) {
  const usernameInput = el('input', { type: 'text', autocomplete: 'off',
                                       placeholder: 'kashish-2' });
  const displayInput  = el('input', { type: 'text', autocomplete: 'off',
                                       placeholder: 'Kashish Jain' });
  const repoInput     = el('input', { type: 'text', autocomplete: 'off',
                                       placeholder: 'kjain-Cloudforia/worktrace-data-<username>' });
  const patField      = passwordField({ autocomplete: 'off' });
  const pwField       = passwordField({ autocomplete: 'new-password' });
  const codeInput     = el('input', { type: 'text', autocomplete: 'off',
                                       placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });

  // Work shift — three required fields, no defaults (admin always fills).
  timezoneDatalist();  // ensure the datalist exists in the DOM
  const shiftStartInput = el('input', { type: 'time', autocomplete: 'off' });
  const shiftEndInput   = el('input', { type: 'time', autocomplete: 'off' });
  const tzInput         = el('input', {
    type: 'text', autocomplete: 'off',
    list: 'wt-tz-datalist',
    placeholder: 'start typing — e.g. America/Los_Angeles',
  });

  const errBox  = el('p', { class: 'wt-modal__error', hidden: true });
  const workBox = el('p', { class: 'wt-modal__working', hidden: true });
  const submit  = el('button', { class: 'wt-modal__submit' }, 'Create user');
  const cancel  = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

  // Auto-fill the data_repo placeholder from the username as admin types,
  // so the common case (org/worktrace-data-<u>) doesn't require typing.
  // We only auto-fill if the field is still empty or matches our last
  // suggestion — never overwrite a manual edit.
  let lastSuggestion = '';
  usernameInput.addEventListener('input', () => {
    const u = usernameInput.value.trim().toLowerCase();
    const suggestion = u ? `kjain-Cloudforia/worktrace-data-${u}` : '';
    if (!repoInput.value || repoInput.value === lastSuggestion) {
      repoInput.value = suggestion;
      lastSuggestion = suggestion;
    }
  });

  async function attempt() {
    errBox.hidden = true;
    const username   = (usernameInput.value || '').trim().toLowerCase();
    const display    = (displayInput.value  || '').trim();
    const dataRepo   = (repoInput.value     || '').trim();
    const userPat    = patField.input.value;
    const initPw     = pwField.input.value;
    const code       = codeInput.value;
    const shiftStart = (shiftStartInput.value || '').trim();
    const shiftEnd   = (shiftEndInput.value   || '').trim();
    const tz         = (tzInput.value         || '').trim();

    // ---- Input-shape validation ----------------------------------
    if (!username || !display || !dataRepo || !userPat || !initPw || !code
        || !shiftStart || !shiftEnd || !tz) {
      errBox.textContent = 'Every field is required.';
      errBox.hidden = false;
      return;
    }
    let workShift;
    try {
      workShift = validateWorkShift({ start: shiftStart, end: shiftEnd, timezone: tz });
    } catch (e) {
      errBox.textContent = e.message;
      errBox.hidden = false;
      return;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(username)) {
      errBox.textContent = 'Username must be a lowercase slug (letters, digits, hyphens; starts with a letter).';
      errBox.hidden = false;
      return;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(dataRepo)) {
      errBox.textContent = 'Data repo must be in owner/repo form (e.g. kjain-Cloudforia/worktrace-data-bob).';
      errBox.hidden = false;
      return;
    }
    let normalizedCode;
    try {
      normalizedCode = normalizeRecoveryCode(code);
    } catch {
      errBox.textContent = 'Recovery code must be 24 Crockford characters (hyphens / spaces / lowercase are OK).';
      errBox.hidden = false;
      return;
    }
    const policy = checkPasswordStrength(initPw);
    if (!policy.ok) {
      errBox.textContent = 'Initial password does not meet policy: ' + policy.reasons.join(' ');
      errBox.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Creating…';
    workBox.hidden = false;
    workBox.textContent = 'Checking username…';

    try {
      // ---- Server-side validation -------------------------------
      // 1) Username uniqueness — no orphan overwrite.
      if (!await isUsernameFree(username)) {
        errBox.textContent = `A user @${username} already exists.`;
        errBox.hidden = false;
        return;
      }

      // 2) Probe the data_repo with the supplied PAT. Confirms the
      //    repo exists AND the PAT has access. Catches typos / wrong
      //    scope before we commit anything.
      workBox.textContent = "Probing data repo with the user's PAT…";
      const probe = await fetch(`https://api.github.com/repos/${dataRepo}`, {
        headers: { 'Authorization': `Bearer ${userPat}` },
      });
      if (probe.status === 404) {
        errBox.textContent = `Data repo ${dataRepo} not found. Create it on GitHub first.`;
        errBox.hidden = false;
        return;
      }
      if (probe.status === 401 || probe.status === 403) {
        errBox.textContent = `The PAT does not have access to ${dataRepo}. Re-issue it with Contents:Read+Write on that repo.`;
        errBox.hidden = false;
        return;
      }
      if (!probe.ok) {
        errBox.textContent = `Repo probe failed: HTTP ${probe.status}`;
        errBox.hidden = false;
        return;
      }

      // 3) Confirm the recovery code actually unlocks admin.recovery.json
      //    — otherwise we'd write an escrow under a typo'd code that no
      //    later reset attempt could decrypt. Cheap upfront guard.
      workBox.textContent = 'Verifying recovery code…';
      const recProbe = await fetch(
        'https://api.github.com/repos/kjain-Cloudforia/worktrace-auth/contents/admin.recovery.json',
        { headers: { 'Accept': 'application/vnd.github.v3.raw' }, cache: 'no-store' });
      if (!recProbe.ok) {
        errBox.textContent = 'Could not fetch admin.recovery.json to verify code.';
        errBox.hidden = false;
        return;
      }
      try {
        // unlockRecoveryRecord normalises the code internally — pass raw.
        await unlockRecoveryRecord(await recProbe.json(), code);
      } catch {
        errBox.textContent = 'Recovery code is incorrect — refusing to write an escrow nobody can unlock.';
        errBox.hidden = false;
        return;
      }

      // ---- Build records --------------------------------------------
      workBox.textContent = 'Encrypting PAT under initial password (≈2s)…';
      const userRecord = await buildUserRecord({
        username, displayName: display, dataRepo,
        pat: userPat, password: initPw, isAdmin: false,
        workShift,
      });

      workBox.textContent = 'Encrypting PAT under recovery code (≈2s)…';
      // buildEscrowRecord internally bypasses the human-password policy
      // (recovery code is high-entropy uppercase Crockford and would
      // fail the lowercase-letter check). It also tags the record with
      // encrypted_by: 'recovery_code' for the audit trail.
      const escrowRecord = await buildEscrowRecord({
        username, pat: userPat, adminPassword: normalizedCode,
      });

      // ---- Commit -------------------------------------------------
      workBox.textContent = `Committing users/${username}.json…`;
      await ctx.commitAuth(
        `users/${username}.json`,
        JSON.stringify(userRecord, null, 2) + '\n',
        `Provision new user ${username}`,
      );
      workBox.textContent = `Committing escrow/${username}.json…`;
      await ctx.commitAuth(
        `escrow/${username}.json`,
        JSON.stringify(escrowRecord, null, 2) + '\n',
        `Provision escrow for ${username}`,
      );

      // ---- Success state ------------------------------------------
      renderCreateSuccess({ username, display, initialPassword: initPw }, ctx, refreshRoster);
    } catch (err) {
      errBox.textContent = `Create failed: ${err.message || err}`;
      errBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Create user';
      workBox.hidden = true;
    }
  }

  submit.addEventListener('click', attempt);
  cancel.addEventListener('click', () => ctx.closeModal());

  ctx.openModal([
    el('h2', {}, 'Add team member'),
    el('p', { class: 'wt-modal__lead' },
      'Create the data repo + fine-grained PAT on GitHub first, then ' +
      'fill in below. The user receives the initial password out-of-band.'),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Username (slug)'),
      usernameInput,
      el('p', { class: 'wt-modal__hint' },
        'Lowercase letters, digits, hyphens. Used as the sign-in name and in file paths.')),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Display name'),
      displayInput),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Data repo'),
      repoInput,
      el('p', { class: 'wt-modal__hint' },
        'owner/repo form. Must already exist on GitHub.')),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, "User's GitHub PAT (fine-grained)"),
      patField,
      el('p', { class: 'wt-modal__hint' },
        'Contents:Read+Write on the data repo. Never sent anywhere — we encrypt it locally.')),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Initial password (user will rotate it)'),
      pwField,
      el('p', { class: 'wt-modal__hint' },
        'Min 12 chars, mixed case, one digit. Pick something memorable to dictate.')),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Recovery code'),
      codeInput,
      el('p', { class: 'wt-modal__hint' },
        'The 24-char admin recovery code. Used to build the escrow file.')),

    // --- Work shift -------------------------------------------------
    // Three required fields. Side-by-side for start/end (they're short
    // HH:MM values), full-width for timezone (long IANA name).
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Work shift — start'),
      shiftStartInput,
      el('p', { class: 'wt-modal__hint' },
        "Local time in the teammate's timezone (below). 24-hour format.")),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Work shift — end'),
      shiftEndInput,
      el('p', { class: 'wt-modal__hint' },
        'If end is earlier than start, the shift crosses midnight ' +
        '(e.g. 14:00 → 05:00 is a 15-hour shift ending the next morning).')),

    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Timezone (IANA name)'),
      tzInput,
      el('p', { class: 'wt-modal__hint' },
        'Start typing for autocomplete. Examples: Asia/Kolkata, America/Los_Angeles, Europe/London, UTC.')),

    errBox,
    workBox,
    el('div', { class: 'wt-modal__actions' }, cancel, submit),
  ]);
}

/**
 * Success state for the create-user flow. Shows the initial password
 * with a copy button so admin can hand it off out-of-band.
 */
function renderCreateSuccess({ username, display, initialPassword }, ctx, refreshRoster) {
  const panel = document.querySelector('#wt-modal .wt-modal__panel');
  panel.innerHTML = '';

  const pwField = el('input', {
    type: 'text', readonly: true, value: initialPassword,
    class: 'wt-login__input',
    style: 'font-family: var(--wt-font-mono); user-select: all;',
  });
  const copyBtn = el('button', { class: 'wt-modal__cancel' }, 'Copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(initialPassword);
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch {
      pwField.select();
      document.execCommand('copy');
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    }
  });

  const doneBtn = el('button', { class: 'wt-modal__submit' }, 'Done');
  doneBtn.addEventListener('click', () => {
    // Use the shell's closeModal so the Esc handler gets unregistered too —
    // direct hidden=true would leak the listener.
    ctx.closeModal();
    if (typeof refreshRoster === 'function') refreshRoster();
  });

  panel.append(
    el('h2', {}, 'User created ✓'),
    el('p', { class: 'wt-modal__success' },
      `${display} (@${username}) provisioned. Their auth + escrow files are in worktrace-auth.`),
    el('p', { class: 'wt-modal__lead' },
      'Send the initial password out-of-band (Slack DM, in person). ' +
      'Tell them to sign in and rotate it via Change password.'),
    el('div', { style: 'display: flex; gap: 8px; align-items: stretch;' },
      pwField, copyBtn),
    el('p', { class: 'wt-modal__hint' },
      'This is the only time the password is shown. Closing this loses it.'),
    el('div', { class: 'wt-modal__actions' }, doneBtn),
  );
}

// ---- Revoke-user flow (admin-triggered) --------------------------------

/**
 * Open the "Revoke @<user>" confirmation modal.
 *
 * Deletes users/<u>.json + escrow/<u>.json from worktrace-auth, which
 * prevents the user from signing in. Does NOT touch the user's data
 * repo content or the PAT itself — admin can:
 *   - delete the data repo on GitHub if they want it gone
 *   - revoke the PAT on GitHub Developer Settings if they want it dead
 * (Same model as the offboarding plan in PROJECT_NOTES.md.)
 */
function openRevokeUserModal(targetUser, ctx, refreshRoster) {
  const confirmInput = el('input', {
    type: 'text', autocomplete: 'off',
    placeholder: `type "${targetUser.username}" to confirm`,
  });
  const errBox  = el('p', { class: 'wt-modal__error', hidden: true });
  const workBox = el('p', { class: 'wt-modal__working', hidden: true });
  const submit  = el('button', { class: 'wt-modal__submit',
                                  style: 'background: var(--wt-danger);' },
                     'Revoke access');
  const cancel  = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

  async function attempt() {
    errBox.hidden = true;
    if (confirmInput.value.trim() !== targetUser.username) {
      errBox.textContent = `Type "${targetUser.username}" exactly to confirm.`;
      errBox.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Revoking…';
    workBox.hidden = false;
    workBox.textContent = `Deleting users/${targetUser.username}.json…`;

    try {
      await ctx.deleteAuth(
        `users/${targetUser.username}.json`,
        `Revoke access for ${targetUser.username}`,
      );
      workBox.textContent = `Deleting escrow/${targetUser.username}.json…`;
      await ctx.deleteAuth(
        `escrow/${targetUser.username}.json`,
        `Remove escrow for ${targetUser.username}`,
      );

      // Success — replace modal with a brief done-state.
      const panel = document.querySelector('#wt-modal .wt-modal__panel');
      panel.innerHTML = '';
      const doneBtn = el('button', { class: 'wt-modal__submit' }, 'Done');
      doneBtn.addEventListener('click', () => {
        document.querySelector('#wt-modal').setAttribute('hidden', '');
        if (typeof refreshRoster === 'function') refreshRoster();
      });
      panel.append(
        el('h2', {}, 'Access revoked'),
        el('p', { class: 'wt-modal__success' },
          `@${targetUser.username} can no longer sign in.`),
        el('p', { class: 'wt-modal__lead' },
          'Data repo and PAT are unchanged. To fully decommission: ' +
          'delete the data repo on GitHub, revoke the PAT in Developer Settings.'),
        el('div', { class: 'wt-modal__actions' }, doneBtn),
      );
    } catch (err) {
      errBox.textContent = `Revoke failed: ${err.message || err}`;
      errBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Revoke access';
      workBox.hidden = true;
    }
  }

  submit.addEventListener('click', attempt);
  cancel.addEventListener('click', () => ctx.closeModal());

  ctx.openModal([
    el('h2', { style: 'color: var(--wt-danger);' },
       `Revoke access — @${targetUser.username}`),
    el('p', { class: 'wt-modal__lead' },
      `This deletes ${targetUser.display_name}'s auth + escrow files from worktrace-auth. ` +
      'They will no longer be able to sign in. Their data repo and PAT are NOT touched.'),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, `Type the username to confirm`),
      confirmInput),
    errBox,
    workBox,
    el('div', { class: 'wt-modal__actions' }, cancel, submit),
  ]);
}

// ---- Reset-password flow (admin-triggered) ------------------------------

/**
 * Open the "Reset password for <user>" modal. Shows:
 *   - admin's own password input (used to decrypt escrow/<user>.json)
 *   - new temporary password + confirm (used to re-encrypt user's PAT
 *     into a new users/<user>.json record)
 *
 * On success, displays the new temp password in plaintext with a
 * copy-to-clipboard button — admin must communicate it to the user
 * out-of-band (Slack DM, in person, etc.). We don't email it because
 * there's no backend to send mail from (that was the deliberate
 * design choice in Phase 5h — see plan).
 *
 * The user is encouraged to change the temp password immediately on
 * their next sign-in via the existing Change Password modal.
 */
function openResetPasswordModal(targetUser, ctx, refreshRoster) {
  const codeInput    = el('input', { type: 'text', autocomplete: 'off',
                                     placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
  const newPwField     = passwordField({ autocomplete: 'new-password' });
  const confirmPwField = passwordField({ autocomplete: 'new-password' });
  const errBox  = el('p', { class: 'wt-modal__error', hidden: true });
  const workBox = el('p', { class: 'wt-modal__working', hidden: true });
  const submit  = el('button', { class: 'wt-modal__submit' }, 'Reset password');
  const cancel  = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

  async function attempt() {
    errBox.hidden = true;
    const code    = codeInput.value;
    const newPw   = newPwField.input.value;
    const confirm = confirmPwField.input.value;

    if (!code || !newPw || !confirm) {
      errBox.textContent = 'Fill in all three fields.';
      errBox.hidden = false;
      return;
    }
    try {
      normalizeRecoveryCode(code); // throws on bad shape
    } catch {
      errBox.textContent =
        'Recovery code must be 24 Crockford characters (hyphens / spaces / lowercase are OK).';
      errBox.hidden = false;
      return;
    }
    if (newPw !== confirm) {
      errBox.textContent = 'Temporary password and confirmation do not match.';
      errBox.hidden = false;
      return;
    }
    const policy = checkPasswordStrength(newPw);
    if (!policy.ok) {
      errBox.textContent = 'Temporary password does not meet policy: ' + policy.reasons.join(' ');
      errBox.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Resetting…';
    workBox.hidden = false;
    workBox.textContent = 'Unlocking escrow (≈2s PBKDF2)…';

    try {
      // 1. Pull the escrow record + the user's current auth file. We need
      //    the auth file to preserve immutable metadata (created_at,
      //    github_login, data_repo, …) when writing the rekeyed record.
      const [escrow, currentRecord] = await Promise.all([
        fetchEscrowFile(targetUser.username),
        fetchAuthFileFull(targetUser.username),
      ]);
      if (!escrow) {
        errBox.textContent =
          `No escrow file for @${targetUser.username}. Run scripts/build_recovery_artifacts.py to create one.`;
        errBox.hidden = false;
        return;
      }

      // 2. Decrypt escrow with the recovery code → user's PAT plaintext.
      //    Escrow is intentionally encrypted under the recovery code (not
      //    the admin password) so escrow files survive admin password
      //    changes and recoveries without needing a re-key pass.
      //
      //    IMPORTANT: the recovery code's PBKDF2 key is derived from the
      //    NORMALIZED form (no hyphens/spaces, uppercase). Both the Python
      //    build script and the JS recovery-record helpers normalize
      //    internally — unlockEscrowRecord is generic, so we have to do
      //    it explicitly here, otherwise hyphenated input fails to decrypt.
      const normalizedCode = normalizeRecoveryCode(code);
      let userPat;
      try {
        userPat = await unlockEscrowRecord(escrow, normalizedCode);
      } catch (e) {
        errBox.textContent = 'Recovery code is incorrect (or escrow was built under a different code).';
        errBox.hidden = false;
        return;
      }

      // 3. Re-encrypt the PAT under the new temp password.
      workBox.textContent = 'Re-encrypting under new password (≈2s)…';
      const newBundle = await encryptSecret(userPat, newPw);

      // 4. Stitch the new bundle into the existing user record, preserving
      //    every public field. updated_at gets bumped.
      const newRecord = {
        ...currentRecord,
        ...newBundle,
        updated_at: new Date().toISOString(),
      };

      // 5. Commit users/<username>.json back to worktrace-auth.
      workBox.textContent = 'Saving to worktrace-auth…';
      await ctx.commitAuth(
        `users/${targetUser.username}.json`,
        JSON.stringify(newRecord, null, 2) + '\n',
        `Admin reset password for ${targetUser.username}`,
      );

      // Success — replace the modal contents with a "communicate this" panel
      // showing the new temp password and a copy-to-clipboard button.
      renderResetSuccess(targetUser, newPw, ctx, refreshRoster);
    } catch (err) {
      errBox.textContent = `Reset failed: ${err.message || err}`;
      errBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Reset password';
      workBox.hidden = true;
    }
  }

  submit.addEventListener('click', attempt);
  cancel.addEventListener('click', () => ctx.closeModal());

  ctx.openModal([
    el('h2', {}, `Reset password — @${targetUser.username}`),
    el('p', { class: 'wt-modal__lead' },
      `Set a temporary password for ${targetUser.display_name}. ` +
      `${targetUser.display_name} will sign in with it and should rotate it immediately via Change password.`),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Recovery code'),
      codeInput,
      el('p', { class: 'wt-modal__hint' },
        'The 24-char admin recovery code (stored in 1Password / paper). ' +
        'Used to unlock the escrow — never sent anywhere.')
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, `New temporary password for @${targetUser.username}`),
      newPwField,
      el('p', { class: 'wt-modal__hint' },
        'Min 12 chars, mixed case, one digit. ' +
        'You will see it once on the next screen so you can copy + share it.')
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Confirm temporary password'),
      confirmPwField
    ),
    errBox,
    workBox,
    el('div', { class: 'wt-modal__actions' }, cancel, submit),
  ]);
}

/**
 * Success state for the reset-password flow. Shows the freshly-set
 * temporary password with a copy button. Once admin closes this, the
 * password is gone — by design, since admin shouldn't be sitting on
 * other users' passwords in memory.
 */
function renderResetSuccess(targetUser, tempPassword, ctx, refreshRoster) {
  const panel = document.querySelector('#wt-modal .wt-modal__panel');
  panel.innerHTML = '';

  const pwField = el('input', {
    type: 'text', readonly: true, value: tempPassword,
    class: 'wt-login__input',
    style: 'font-family: var(--wt-font-mono); user-select: all;',
  });

  const copyBtn = el('button', { class: 'wt-modal__cancel' }, 'Copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tempPassword);
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch {
      // clipboard may be unavailable on some browsers/contexts
      pwField.select();
      document.execCommand('copy');
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    }
  });

  const doneBtn = el('button', { class: 'wt-modal__submit' }, 'Done');
  doneBtn.addEventListener('click', () => {
    // Close, then refresh the roster so any sync-state indicators update.
    document.querySelector('#wt-modal').setAttribute('hidden', '');
    if (typeof refreshRoster === 'function') refreshRoster();
  });

  panel.append(
    el('h2', {}, 'Password reset ✓'),
    el('p', { class: 'wt-modal__success' },
      `Temporary password set for ${targetUser.display_name} (@${targetUser.username}).`),
    el('p', { class: 'wt-modal__lead' },
      'Send this to them out-of-band (Slack DM, in person). ' +
      'Tell them to sign in and rotate it immediately via Change password.'),
    el('div', { style: 'display: flex; gap: 8px; align-items: stretch;' },
      pwField, copyBtn
    ),
    el('p', { class: 'wt-modal__hint' },
      'This is the only time it is shown. Once you close, the password is gone from this session.'),
    el('div', { class: 'wt-modal__actions' }, doneBtn),
  );
}

// ---- module export -----------------------------------------------------

export default {
  id: 'admin',
  displayName: 'Admin Console',
  description: 'Team roster · cross-user view',
  schemaVersion: 1,
  stylesheet: 'module.css',
  requiresAdmin: true,

  async init(_shell) {
    // The Admin module re-uses the Timesheet module's renderDetail UI
    // for the "view as <user>" drill-in. The Timesheet module is hidden
    // from admins (hideForAdmin: true), so the shell never injects its
    // stylesheet during loadModule. We inject it ourselves here, using
    // the same `wt-module-css--<id>` id pattern the shell uses, so the
    // dedupe-by-id check stays consistent across both code paths.
    const cssId = 'wt-module-css--timesheet';
    if (!document.getElementById(cssId)) {
      const link = document.createElement('link');
      link.id = cssId;
      link.rel = 'stylesheet';
      link.href = './modules/timesheet/module.css';
      document.head.appendChild(link);
    }
  },

  /**
   * Tile: team aggregates. Shown alongside the Timesheet tile for admins.
   */
  async renderTile(container, ctx) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'Loading roster…'));

    try {
      const files = await listAllAuthFiles();
      // Don't try to fetch every user's timesheet on the tile — that's
      // N+1 calls and slow. Just count users + admins; richer aggregates
      // happen in the detail view.
      const publicFields = await Promise.all(
        files.map(f => fetchAuthFile(f.name).catch(() => null))
      );
      const users = publicFields.filter(Boolean);
      const total = users.length;
      const adminCount = users.filter(u => u.is_admin).length;
      const userCount = total - adminCount;
      const reposCount = new Set(users.filter(u => u.data_repo).map(u => u.data_repo)).size;

      container.innerHTML = '';
      container.appendChild(
        el('div', { class: 'wt-admin-tile' },
          el('div', { class: 'wt-admin-tile__primary' },
            el('div', { class: 'wt-admin-tile__num' }, String(userCount)),
            el('div', { class: 'wt-admin-tile__label' },
              userCount === 1 ? 'team member' : 'team members')
          ),
          el('div', { class: 'wt-admin-tile__stats' },
            el('div', { class: 'wt-admin-tile__stat' },
              el('span', { class: 'wt-admin-tile__stat-num' }, String(adminCount)),
              el('span', { class: 'wt-admin-tile__stat-label' }, 'admins')
            ),
            el('div', { class: 'wt-admin-tile__stat' },
              el('span', { class: 'wt-admin-tile__stat-num' }, String(reposCount)),
              el('span', { class: 'wt-admin-tile__stat-label' }, 'data repos')
            )
          ),
          el('div', { class: 'wt-admin-tile__hint' }, 'Click to manage →')
        )
      );
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(el('p', { class: 'wt-tile__placeholder', style: 'color: var(--wt-danger);' },
        `Error loading roster: ${err.message}`));
    }
  },

  /**
   * Detail: roster + drill-into-user-timesheet.
   */
  async renderDetail(container, ctx) {
    // UI state lives in this closure so we don't churn URL routing for
    // sub-views. Back button returns to the roster.
    let viewingUser = null;

    const render = async () => {
      container.innerHTML = '';
      container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'Loading…'));

      if (viewingUser) {
        await renderUserTimesheet(viewingUser);
        return;
      }
      await renderRoster();
    };

    const renderRoster = async () => {
      container.innerHTML = '';

      // Fetch user list (public fields only). The Timesheet drill-in
      // fetches each user's data on demand when admin clicks "View".
      let users;
      try {
        const files = await listAllAuthFiles();
        users = (await Promise.all(files.map(f => fetchAuthFile(f.name).catch(() => null))))
          .filter(Boolean);
      } catch (err) {
        container.innerHTML = '';
        container.appendChild(el('p', { class: 'wt-error' },
          `Couldn't load user roster: ${err.message}`));
        return;
      }

      // Sort: admins first, then alphabetical
      users.sort((a, b) => {
        if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1;
        return (a.display_name || a.username).localeCompare(b.display_name || b.username);
      });

      // Per-user sync probe — N small fetches. For non-admin users we
      // fetch their data.json to surface "last sync" + entry count.
      // Doing this in parallel keeps the wait small (<2s for ~10 users).
      const probes = await Promise.all(users.map(async u => {
        if (!u.data_repo) return { user: u, data: null, error: null };
        try {
          const data = await fetchUserTimesheet(ctx, u);
          return { user: u, data, error: null };
        } catch (err) {
          return { user: u, data: null, error: err };
        }
      }));

      container.innerHTML = '';

      // Header row: count + Add User button. Keeping it inline rather
      // than in a separate panel so the roster stays a single scrolling
      // section without extra chrome.
      container.appendChild(el('div', { class: 'wt-admin-detail__header' },
        el('p', { class: 'wt-admin-detail__lead' },
          `${users.length} team member${users.length === 1 ? '' : 's'}, ` +
          `${users.filter(u => u.is_admin).length} admin${users.filter(u => u.is_admin).length === 1 ? '' : 's'}.`
        ),
        el('button', {
          class: 'wt-admin-card__btn',
          onclick: () => openCreateUserModal(ctx, render),
        }, '+ Add team member'),
      ));

      const grid = el('div', { class: 'wt-admin-grid' });
      for (const { user, data, error } of probes) {
        grid.appendChild(buildUserCard(user, data, error));
      }
      container.appendChild(grid);
    };

    const renderUserTimesheet = async (user) => {
      container.innerHTML = '';

      const header = el('div', { class: 'wt-admin-detail__userhead' },
        el('button', {
          class: 'wt-detail__back',
          onclick: () => { viewingUser = null; render(); }
        }, '← Back to roster'),
        el('div', { class: 'wt-admin-detail__userhead-id' },
          el('div', { class: 'wt-admin-detail__userhead-name' }, user.display_name),
          el('div', { class: 'wt-admin-detail__userhead-meta' },
            `@${user.username} · ${user.data_repo || 'no data repo'}`)
        )
      );
      container.appendChild(header);

      if (!user.data_repo) {
        container.appendChild(el('p', { class: 'wt-tile__placeholder' },
          'This user has no data repo (admin records have no personal data).'));
        return;
      }

      // Shim the timesheet module's ctx so fetchMyData points at THIS
      // user's repo + the Timesheet module's data path (not admin's),
      // using admin's PAT (which has cross-user read).
      const shimmedCtx = {
        ...ctx,
        currentUser: {
          ...user,
          // Make sure renderDetail's summary shows the user being viewed,
          // not the admin doing the viewing.
        },
        fetchMyData: () => ctx.ghFetch(user.data_repo, TIMESHEET_DATA_PATH),
      };

      const body = el('div');
      container.appendChild(body);
      try {
        await timesheetModule.renderDetail(body, shimmedCtx);
      } catch (err) {
        body.appendChild(el('p', { class: 'wt-error' },
          `Couldn't render timesheet for ${user.username}: ${err.message}`));
      }
    };

    const buildUserCard = (user, data, error) => {
      const initials = userInitials(user);
      const entries = data?.entries?.length ?? 0;
      const lastSync = data?.last_synced_at;
      const canView = !user.is_admin && !!user.data_repo;

      let statusEl;
      if (user.is_admin) {
        statusEl = el('span', { class: 'wt-admin-card__status wt-admin-card__status--admin' }, 'ADMIN');
      } else if (error) {
        statusEl = el('span', { class: 'wt-admin-card__status wt-admin-card__status--error' },
          `error · ${error.message.slice(0, 40)}`);
      } else if (data) {
        statusEl = el('span', { class: 'wt-admin-card__status' },
          `${entries} entr${entries === 1 ? 'y' : 'ies'} · last sync ${fmtTs(lastSync)}`);
      } else {
        statusEl = el('span', { class: 'wt-admin-card__status wt-admin-card__status--muted' },
          'no sync yet');
      }

      // Per-user actions. Admins are exempt from Reset/Revoke because:
      //   - Reset: admin uses the recovery code flow instead (only one
      //     admin record per system; resetting it via the same modal
      //     would be confusing).
      //   - Revoke: deleting admin would lock everyone out of
      //     worktrace-auth (no PAT with write scope left). Future
      //     multi-admin support could relax this.
      const canReset  = !user.is_admin;
      const canRevoke = !user.is_admin;

      // Resolve the effective shift (handles pending → current promotion
      // if the scheduled effective_from has already passed). Then check
      // for a still-future pending change to annotate the card with.
      const ws = resolveActiveShift(user);
      let shiftText;
      let pendingNote = null;
      if (ws) {
        shiftText = `${ws.start}–${ws.end} ${ws.timezone}`;
        // If a pending change is set AND it's still in the future, show
        // it as a queued annotation. The Edit shift flow defers in-shift
        // edits, so any teammate mid-shift will fall into this branch.
        const pending = user.work_shift_pending;
        if (pending?.effective_from) {
          const eff = new Date(pending.effective_from);
          if (!isNaN(eff.getTime()) && eff > new Date()) {
            // Render the date in the *pending* shift's timezone so the
            // user sees a sensible local time. Compact format.
            try {
              const fmt = new Intl.DateTimeFormat(undefined, {
                timeZone: pending.timezone,
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
              });
              pendingNote = `→ pending: ${pending.start}–${pending.end} ${pending.timezone} from ${fmt.format(eff)}`;
            } catch {
              pendingNote = `→ pending: ${pending.start}–${pending.end} ${pending.timezone}`;
            }
          }
        }
      } else {
        // Pre-Phase-5j records — backfilled long ago, but defensive.
        shiftText = '(shift not set — pre-5j record)';
      }

      return el('div', { class: 'wt-admin-card' },
        el('div', { class: 'wt-admin-card__avatar' }, initials),
        el('div', { class: 'wt-admin-card__body' },
          el('div', { class: 'wt-admin-card__head' },
            el('span', { class: 'wt-admin-card__name' }, user.display_name),
            el('span', { class: 'wt-admin-card__handle' },
              `@${user.username} · GH:${user.github_login || '—'}`)
          ),
          el('div', { class: 'wt-admin-card__meta' },
            user.data_repo
              ? el('code', {}, user.data_repo)
              : el('span', { class: 'wt-admin-card__meta-empty' }, '(no data repo)')
          ),
          el('div', { class: 'wt-admin-card__meta' },
            el('span', {
              class: ws ? 'wt-admin-card__shift' : 'wt-admin-card__shift wt-admin-card__shift--missing',
              title: ws ? 'Work shift + timezone' : 'No work_shift on record — backfill via Edit shift',
            }, `⏱ ${shiftText}`),
            pendingNote
              ? el('span', {
                  class: 'wt-admin-card__shift wt-admin-card__shift--pending',
                  title: 'Scheduled shift change',
                }, ` ${pendingNote}`)
              : null
          ),
          el('div', { class: 'wt-admin-card__row' }, statusEl)
        ),
        el('div', { class: 'wt-admin-card__actions' },
          canView
            ? el('button', {
                class: 'wt-admin-card__btn',
                onclick: () => { viewingUser = user; render(); }
              }, 'View timesheet →')
            : null,
          canReset
            ? el('button', {
                class: 'wt-admin-card__btn wt-admin-card__btn--ghost',
                onclick: () => openResetPasswordModal(user, ctx, render),
              }, 'Reset password')
            : null,
          canRevoke
            ? el('button', {
                class: 'wt-admin-card__btn wt-admin-card__btn--danger',
                onclick: () => openRevokeUserModal(user, ctx, render),
              }, 'Revoke')
            : null,
        )
      );
    };

    await render();
  },
};
