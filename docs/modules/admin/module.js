/**
 * modules/admin/module.js
 *
 * Admin console for the WorkTrace dashboard. Only loads for users whose
 * worktrace-auth record has `is_admin: true` — shell.js gates this via
 * the `requiresAdmin` flag on the module export.
 *
 * Tile view: team-wide aggregates — user count, total bullets, deploys,
 * onboarding count. Click to drill.
 *
 * Detail view has two states (toggled by local UI state, not URL routing):
 *
 *   State A — user roster
 *     Card per user showing display name, GitHub login, data_repo,
 *     active status, last sync, entry count. Two actions per card:
 *       • "View timesheet" — switches into State B for that user
 *       • (Phase 5e) "Edit" / "Revoke" / "Reset password"
 *
 *   State B — viewing a specific user's timesheet
 *     Re-uses the Timesheet module's renderDetail with a shimmed ctx so
 *     the same UI code renders. Back button returns to State A.
 *
 * Data flow:
 *   - Listing users: GET worktrace-auth/users/ (public, no auth needed)
 *     then fetch each users/*.json file individually for the public
 *     fields. The ciphertext is included in the response but ignored —
 *     we never have decrypted PATs for other users.
 *   - Fetching a user's timesheet data: GET <their_data_repo>/modules/
 *     timesheet/data.json using THE ADMIN'S PAT (the one decrypted
 *     during admin sign-in). Admin's PAT must have Read access to all
 *     data repos that admin can govern — managed_repos in admin.json
 *     is the source of truth for which repos that is.
 */

import timesheetModule from '../timesheet/module.js';
import {
  unlockEscrowRecord,
  encryptSecret,
  checkPasswordStrength,
  normalizeRecoveryCode,
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

// Use the Contents API for *all* worktrace-auth reads. raw.githubusercontent.com
// caches by path and can serve stale records for minutes after a write, which
// would cause spurious "wrong password" errors after a reset or rekey.
const AUTH_API_BASE  = 'https://api.github.com/repos/kjain-Cloudforia/worktrace-auth/contents';
const AUTH_API       = `${AUTH_API_BASE}/users`;        // listing endpoint
const AUTH_USERS_API = `${AUTH_API_BASE}/users`;        // per-file fetches
const ESCROW_API     = `${AUTH_API_BASE}/escrow`;

/**
 * List every users/<u>.json file in worktrace-auth.
 * The repo is public so this requires no auth.
 */
async function listAllAuthFiles() {
  const res = await fetch(AUTH_API, { cache: 'no-store' });
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
  const newPwInput   = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirmInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const errBox  = el('p', { class: 'wt-modal__error', hidden: true });
  const workBox = el('p', { class: 'wt-modal__working', hidden: true });
  const submit  = el('button', { class: 'wt-modal__submit' }, 'Reset password');
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
      renderResetSuccess(targetUser, newPw, refreshRoster);
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
      newPwInput,
      el('p', { class: 'wt-modal__hint' },
        'Min 12 chars, mixed case, one digit. ' +
        'You will see it once on the next screen so you can copy + share it.')
    ),
    el('div', { class: 'wt-modal__field' },
      el('label', {}, 'Confirm temporary password'),
      confirmInput
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
function renderResetSuccess(targetUser, tempPassword, refreshRoster) {
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

      container.appendChild(el('p', { class: 'wt-admin-detail__lead' },
        `${users.length} team member${users.length === 1 ? '' : 's'}, ` +
        `${users.filter(u => u.is_admin).length} admin${users.filter(u => u.is_admin).length === 1 ? '' : 's'}.`
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

      // The "Reset password" button is offered for every non-admin
      // user. Admins go through the recovery-code flow on the login
      // screen instead — admin can't reset their own password from
      // inside an authenticated session because doing so would imply
      // they remember it (and could use the Change Password flow).
      const canReset = !user.is_admin;

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
            : null
        )
      );
    };

    await render();
  },
};
