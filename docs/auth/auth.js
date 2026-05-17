/**
 * auth.js — WorkTrace password-based encryption layer.
 *
 * Purpose
 * -------
 * Encrypt a user's GitHub PAT with their password so the encrypted blob
 * can live in a public repo (`worktrace-auth/users/<username>.json`)
 * without exposing the PAT. The password itself never leaves the browser;
 * we only ever store the output of:
 *
 *   ciphertext = AES-GCM-encrypt(PAT, key, iv)
 *   key        = PBKDF2(password, salt, 600_000 iters, SHA-256)
 *
 * At login the dashboard fetches the file, derives the same key from the
 * user-typed password, and decrypts. AES-GCM is authenticated encryption,
 * so a wrong password causes `decrypt()` to throw — no false positives.
 *
 * Recipe
 * ------
 * Both encryption and decryption use the Web Crypto API (`crypto.subtle`)
 * which is built into every modern browser. No external libraries.
 *
 *   PBKDF2-HMAC-SHA256, 600_000 iterations  (OWASP 2023 minimum)
 *   16-byte random salt per user             (defeats rainbow tables)
 *   AES-GCM, 256-bit key, 12-byte random iv  (authenticated encryption)
 *
 * Output shape (matches schema/auth-user/v1.json)
 * -----------------------------------------------
 *   {
 *     schema_version: 1,
 *     username:       "kashish",
 *     display_name:   "Kashish Jain",
 *     data_repo:      "kjain-Cloudforia/worktrace-data-kashish",
 *     is_admin:       false,
 *     kdf:            "PBKDF2-HMAC-SHA256",
 *     iterations:     600000,
 *     salt:           "<base64>",
 *     iv:             "<base64>",
 *     ciphertext:     "<base64>",
 *     created_at:     "2026-...",
 *     updated_at:     "2026-..."
 *   }
 *
 * Browser support
 * ---------------
 * - `crypto.subtle` requires HTTPS or localhost. GitHub Pages serves HTTPS.
 * - PBKDF2 600k iterations takes ~1-2s on a fast laptop, ~2-3s on a phone.
 *   Show a spinner during login/signup; this is one-time per session.
 */

// ---- Tuning knobs --------------------------------------------------------

export const KDF_NAME       = 'PBKDF2-HMAC-SHA256';
export const KDF_ITERATIONS = 600_000;
export const KDF_HASH       = 'SHA-256';
export const KDF_KEY_LEN    = 256;
export const KDF_SALT_LEN   = 16;     // bytes
export const AES_IV_LEN     = 12;     // bytes (AES-GCM standard)
export const SCHEMA_VERSION = 1;

// Password complexity policy. Tweak in one place.
export const MIN_PASSWORD_LEN     = 12;
export const REQUIRE_MIXED_CASE   = true;
export const REQUIRE_DIGIT        = true;
// We don't require a special character because the small character-set gain
// rarely outweighs the UX cost in our threat model (offline brute-force
// resisted by the 600k iteration count).

// ---- Encoding helpers ----------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Uint8Array → base64 (browser-safe; no Buffer dependency) */
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 → Uint8Array */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate N random bytes via the platform CSPRNG. */
function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// ---- Key derivation -----------------------------------------------------

/**
 * Run PBKDF2 over the password to produce an AES-GCM key.
 * Returns a CryptoKey usable with crypto.subtle.encrypt / .decrypt.
 *
 * Mode is passed in so the returned key can be limited to just what's
 * needed (encrypt OR decrypt), tightening the surface a tiny bit.
 */
async function deriveKey(password, salt, iterations, mode) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    /* extractable */ false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF_HASH },
    baseKey,
    { name: 'AES-GCM', length: KDF_KEY_LEN },
    /* extractable */ false,
    [mode],
  );
}

// ---- Password complexity ------------------------------------------------

/**
 * Validate a candidate password against the configured policy.
 * Returns { ok: boolean, reasons: string[] } — empty `reasons` when ok.
 * Call this client-side before any encrypt call so we don't accept
 * weak passwords that would be brute-forceable from the public auth file.
 */
export function checkPasswordStrength(password) {
  const reasons = [];
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    reasons.push(`Must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  if (REQUIRE_MIXED_CASE) {
    if (!/[a-z]/.test(password)) reasons.push('Must include a lowercase letter.');
    if (!/[A-Z]/.test(password)) reasons.push('Must include an uppercase letter.');
  }
  if (REQUIRE_DIGIT && !/[0-9]/.test(password)) {
    reasons.push('Must include a digit.');
  }
  // Reject common "obviously weak" sentinels — cheap defense, not a panacea.
  const lower = (password || '').toLowerCase();
  if (['password', 'qwerty', 'admin1234', '123456789012'].some(b => lower.includes(b))) {
    reasons.push('Avoid common dictionary words and obvious patterns.');
  }
  return { ok: reasons.length === 0, reasons };
}

// ---- Encrypt / decrypt --------------------------------------------------

/**
 * Encrypt a plaintext string (typically a GitHub PAT) with a password.
 * Returns the raw crypto bundle — salt, iv, ciphertext (all base64) plus
 * the KDF parameters. Pair this with metadata (username, data_repo, etc.)
 * to form a complete user record.
 *
 * Throws if the password fails the strength policy. Catch and surface the
 * `reasons` array to the user if you want admin to override (not currently
 * supported — we always enforce).
 */
export async function encryptSecret(plaintext, password) {
  const check = checkPasswordStrength(password);
  if (!check.ok) {
    const err = new Error('Password does not meet policy: ' + check.reasons.join(' '));
    err.code = 'WEAK_PASSWORD';
    err.reasons = check.reasons;
    throw err;
  }

  const salt = randomBytes(KDF_SALT_LEN);
  const iv   = randomBytes(AES_IV_LEN);
  const key  = await deriveKey(password, salt, KDF_ITERATIONS, 'encrypt');

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext),
  );

  return {
    kdf:        KDF_NAME,
    iterations: KDF_ITERATIONS,
    salt:       bytesToBase64(salt),
    iv:         bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt a crypto bundle (the output of `encryptSecret`) with a password.
 * Returns the plaintext string on success.
 *
 * Throws on:
 *  - wrong password (AES-GCM MAC mismatch → throws synchronously from
 *    crypto.subtle.decrypt)
 *  - tampered ciphertext (same path — MAC mismatch)
 *  - unsupported KDF or iterations way out of policy (we refuse to run)
 *
 * Use a try/catch and treat any throw as "incorrect username or password"
 * — don't leak which case applied (avoid user enumeration via timing).
 */
export async function decryptSecret(bundle, password) {
  if (bundle.kdf !== KDF_NAME) {
    throw new Error(`Unsupported KDF: ${bundle.kdf}`);
  }
  // Refuse pathologically low iteration counts. Future migrations can
  // bump KDF_ITERATIONS — accept a window of "current and one older"
  // values if/when we rotate. For now, exact match.
  if (bundle.iterations < 100_000) {
    throw new Error(`Iteration count too low: ${bundle.iterations}`);
  }
  const salt = base64ToBytes(bundle.salt);
  const iv   = base64ToBytes(bundle.iv);
  const ct   = base64ToBytes(bundle.ciphertext);

  const key = await deriveKey(password, salt, bundle.iterations, 'decrypt');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(plain);
}

// ---- High-level helpers (build / read full user records) ---------------

/**
 * Build a complete user record (the shape that lives in
 * `worktrace-auth/users/<username>.json`).
 *
 * @param {object} args
 * @param {string} args.username       - lowercase slug, unique
 * @param {string} args.displayName    - free text
 * @param {string} args.dataRepo       - "owner/repo", e.g. "kjain-Cloudforia/worktrace-data-alice"
 * @param {string} args.pat            - the GitHub fine-grained PAT to encrypt
 * @param {string} args.password       - the user's password (validated against policy)
 * @param {boolean} [args.isAdmin=false]
 * @param {string[]} [args.managedRepos] - for admin: list of repos they govern
 * @param {object} [args.workShift]    - {start, end, timezone}; see validateWorkShift()
 * @returns {Promise<object>} user record ready to JSON-stringify + commit
 */
export async function buildUserRecord({
  username,
  displayName,
  dataRepo,
  pat,
  password,
  isAdmin = false,
  managedRepos,
  workShift,
}) {
  if (!/^[a-z][a-z0-9-]*$/.test(username || '')) {
    throw new Error('username must be a lowercase slug (letters, digits, hyphens; starts with a letter).');
  }
  const bundle = await encryptSecret(pat, password);
  const now = new Date().toISOString();
  const record = {
    schema_version: SCHEMA_VERSION,
    username,
    display_name: displayName || username,
    data_repo: dataRepo || null,
    is_admin: !!isAdmin,
    ...bundle,
    created_at: now,
    updated_at: now,
  };
  if (isAdmin && Array.isArray(managedRepos) && managedRepos.length) {
    record.managed_repos = managedRepos;
  }
  if (workShift) {
    record.work_shift = validateWorkShift(workShift);
  }
  return record;
}

// ---- Work-shift validation ---------------------------------------------

/**
 * Validate a work_shift object and return it normalised. Throws if the
 * shape is wrong so the caller (typically the Admin / Edit Shift UI)
 * surfaces the specific reason to the user.
 *
 * Rules:
 *  - start and end are 'HH:MM' (24-hour, zero-padded).
 *  - timezone is any IANA name the browser recognises (`Intl.supportedValuesOf`).
 *  - start === end is rejected (zero-length shift makes no sense).
 *  - start > end is allowed and means the shift crosses midnight (e.g. 14:00 → 05:00).
 */
export function validateWorkShift({ start, end, timezone }) {
  const re = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  if (!re.test(start || '')) throw new Error('Shift start must be HH:MM (24-hour).');
  if (!re.test(end   || '')) throw new Error('Shift end must be HH:MM (24-hour).');
  if (start === end) throw new Error('Shift start and end must be different.');
  if (!timezone || typeof timezone !== 'string') {
    throw new Error('Timezone is required.');
  }
  // The robust validity test: try to construct an Intl.DateTimeFormat
  // with the timezone. RangeError → invalid; success → valid.
  //
  // We don't use `Intl.supportedValuesOf('timeZone').includes(...)` here:
  // that returns only each browser's *canonical* name set, which on some
  // platforms (notably older macOS ICU) excludes popular aliases — e.g.
  // `Asia/Kolkata` is omitted when the browser treats `Asia/Calcutta` as
  // canonical. DateTimeFormat accepts both canonical names AND linked
  // aliases, which is the actual semantic guarantee we want.
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new Error(`Timezone "${timezone}" is not recognised by your browser.`);
  }
  return { start, end, timezone };
}

/**
 * Take an existing user record and a (possibly correct) password.
 * On success returns { pat: string, record } where record is the parsed
 * user record minus the secret-y crypto fields.
 *
 * Throws (without leaking why) if the password is wrong. Callers should
 * surface a generic "incorrect username or password" error.
 */
export async function unlockUserRecord(record, password) {
  const pat = await decryptSecret(record, password);
  // Strip crypto fields from the returned record so callers don't
  // accidentally re-leak them into state.
  const {
    kdf, iterations, salt, iv, ciphertext,
    ...publicFields
  } = record;
  return { pat, record: publicFields };
}

/**
 * Re-encrypt a record's secret under a new password (password change).
 * Generates fresh salt + iv. Updates `updated_at`. Existing public
 * metadata (username, display_name, data_repo, is_admin, ...) is preserved.
 */
export async function rekeyUserRecord(record, oldPassword, newPassword) {
  const { pat } = await unlockUserRecord(record, oldPassword);
  const newBundle = await encryptSecret(pat, newPassword);
  return {
    ...record,
    ...newBundle,
    updated_at: new Date().toISOString(),
  };
}

// ---- Escrow records (admin-resettable user password) ------------------

/**
 * Build an escrow record: the user's PAT, encrypted under the admin's
 * recovery code (NOT the admin password — see Phase 5h pivot). Lives at
 * `worktrace-auth/escrow/<username>.json` so admin can reset a user's
 * password without rotating the PAT or contacting the user. The escrow
 * survives every admin password change and recovery because it's keyed
 * to the long-lived recovery code, not the rotating password.
 *
 * Important: `key` is expected to be the NORMALISED Crockford-base32
 * recovery code (24 chars, uppercase, no hyphens). Caller must run
 * `normalizeRecoveryCode()` on user input first. We deliberately skip
 * the human-typed-password policy check (uppercase-only / digit-only)
 * because the recovery code is high-entropy by construction and would
 * fail policy for entirely the wrong reason. Mirrors the same bypass
 * in `buildRecoveryRecord`.
 *
 * The legacy `adminPassword` parameter name is kept for backward
 * compatibility with existing call sites; semantically it's now the
 * recovery code.
 */
export async function buildEscrowRecord({ username, pat, adminPassword }) {
  if (!/^[a-z][a-z0-9-]*$/.test(username || '')) {
    throw new Error('username must be a lowercase slug.');
  }
  // Inline the crypto primitives instead of calling encryptSecret, so
  // we skip the password-policy gate (which is sensible for typed-
  // password records but spurious for a Crockford-base32 code).
  const salt = randomBytes(KDF_SALT_LEN);
  const iv   = randomBytes(AES_IV_LEN);
  const key  = await deriveKey(adminPassword, salt, KDF_ITERATIONS, 'encrypt');
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(pat));

  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    kind: 'escrow',
    username,
    encrypted_by: 'recovery_code',
    kdf:        KDF_NAME,
    iterations: KDF_ITERATIONS,
    salt:       bytesToBase64(salt),
    iv:         bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
    created_at: now,
    updated_at: now,
  };
}

/**
 * Decrypt an escrow record with the recovery code (callers must
 * normalize first — see `normalizeRecoveryCode()`).
 *
 * Bypasses `decryptSecret`'s implicit constraints for the same reason
 * `buildEscrowRecord` bypasses `encryptSecret`: the key is a Crockford
 * code, not a password.
 */
export async function unlockEscrowRecord(record, adminPassword) {
  if (record?.kind !== 'escrow') {
    throw new Error('Not an escrow record.');
  }
  if (record.kdf !== KDF_NAME) throw new Error(`Unsupported KDF: ${record.kdf}`);
  if (record.iterations < 100_000) throw new Error(`Iteration count too low: ${record.iterations}`);
  const salt = base64ToBytes(record.salt);
  const iv   = base64ToBytes(record.iv);
  const ct   = base64ToBytes(record.ciphertext);
  const key  = await deriveKey(adminPassword, salt, record.iterations, 'decrypt');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(plain);
}

// ---- Recovery records (admin-self-recovery via code) ------------------

/**
 * 32-symbol Crockford base32 alphabet — chosen to be unambiguous when
 * read aloud or transcribed by hand. Drops I, L, O, U (visually confusable
 * with 1, 1, 0, V). 24 symbols × log2(32) = 120 bits of entropy, which
 * is plenty against PBKDF2-600k offline guessing.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Map common look-alikes on input so users can paste/type loosely. */
const CROCKFORD_FIXUP = { I: '1', L: '1', O: '0', U: 'V' };

/**
 * Generate a fresh recovery code formatted as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`.
 * Hyphens are decorative — `normalizeRecoveryCode()` strips them on input.
 */
export function generateRecoveryCode() {
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += CROCKFORD[bytes[i] & 31];
  }
  return out;
}

/**
 * Canonicalise a user-typed recovery code so minor visual mistakes
 * (lowercase, hyphens, I-vs-1) don't cause spurious "wrong code" errors.
 * Returns the 24-char alphabet-only string, or throws if it's clearly
 * not a recovery code.
 */
export function normalizeRecoveryCode(input) {
  if (typeof input !== 'string') throw new Error('Recovery code must be a string.');
  const raw = input.toUpperCase().replace(/[\s-]/g, '');
  let fixed = '';
  for (const ch of raw) {
    fixed += CROCKFORD_FIXUP[ch] ?? ch;
  }
  if (fixed.length !== 24 || !/^[0-9A-HJKMNP-TV-Z]{24}$/.test(fixed)) {
    throw new Error('Recovery code must be 24 Crockford-base32 characters.');
  }
  return fixed;
}

/**
 * Build a recovery record: a user's PAT encrypted under a one-time
 * recovery code. Currently used for admin; the same primitive could
 * back any user's "I lost everything" path later.
 *
 * The recovery code itself is NOT stored — only the caller (the human
 * who will write it down) sees it. We use the code directly as the
 * PBKDF2 password, so the same 600k-iteration cost applies.
 */
export async function buildRecoveryRecord({ username, pat, recoveryCode }) {
  if (!/^[a-z][a-z0-9-]*$/.test(username || '')) {
    throw new Error('username must be a lowercase slug.');
  }
  const code = normalizeRecoveryCode(recoveryCode);
  // checkPasswordStrength is tuned for human-typed passwords; the recovery
  // code is high-entropy by construction, so skip the policy check and
  // call the lower-level helper directly.
  const salt = randomBytes(KDF_SALT_LEN);
  const iv   = randomBytes(AES_IV_LEN);
  const key  = await deriveKey(code, salt, KDF_ITERATIONS, 'encrypt');
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(pat));

  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    kind: 'recovery',
    username,
    kdf:        KDF_NAME,
    iterations: KDF_ITERATIONS,
    salt:       bytesToBase64(salt),
    iv:         bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
    created_at: now,
    updated_at: now,
  };
}

/** Decrypt a recovery record with the typed code → original PAT. */
export async function unlockRecoveryRecord(record, recoveryCode) {
  if (record?.kind !== 'recovery') {
    throw new Error('Not a recovery record.');
  }
  const code = normalizeRecoveryCode(recoveryCode);
  // Bypass the strength check (same reasoning as buildRecoveryRecord).
  if (record.kdf !== KDF_NAME) throw new Error(`Unsupported KDF: ${record.kdf}`);
  if (record.iterations < 100_000) throw new Error(`Iteration count too low: ${record.iterations}`);
  const salt = base64ToBytes(record.salt);
  const iv   = base64ToBytes(record.iv);
  const ct   = base64ToBytes(record.ciphertext);
  const key  = await deriveKey(code, salt, record.iterations, 'decrypt');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(plain);
}

// ---- Self-test (run from browser DevTools console) ---------------------

/**
 * Round-trip sanity check. Run from console:
 *   import('./auth/auth.js').then(m => m.__selfTest()).then(console.log)
 */
export async function __selfTest() {
  const password = 'Correct-Horse-Battery-9!';
  const pat = 'github_pat_test_TOKEN_VALUE';

  // build → unlock with correct password
  const rec = await buildUserRecord({
    username: 'demo', displayName: 'Demo', dataRepo: 'x/y',
    pat, password, isAdmin: false,
  });
  const { pat: roundTripped } = await unlockUserRecord(rec, password);
  if (roundTripped !== pat) throw new Error('round-trip failed');

  // unlock with wrong password must throw
  let threwOnWrong = false;
  try {
    await unlockUserRecord(rec, password + 'x');
  } catch (e) {
    threwOnWrong = true;
  }
  if (!threwOnWrong) throw new Error('wrong password did not throw');

  // weak password must be rejected at build time
  let threwOnWeak = false;
  try {
    await encryptSecret('x', 'short');
  } catch (e) {
    threwOnWeak = e.code === 'WEAK_PASSWORD';
  }
  if (!threwOnWeak) throw new Error('weak password not rejected');

  // re-key round-trips with new password
  const rekeyed = await rekeyUserRecord(rec, password, 'New-Stronger-Pass-123!');
  const { pat: afterRekey } = await unlockUserRecord(rekeyed, 'New-Stronger-Pass-123!');
  if (afterRekey !== pat) throw new Error('rekey round-trip failed');

  // escrow record round-trips under admin password
  const adminPw = 'Admin-Strong-Pass-9!';
  const escrow = await buildEscrowRecord({ username: 'demo', pat, adminPassword: adminPw });
  const escrowed = await unlockEscrowRecord(escrow, adminPw);
  if (escrowed !== pat) throw new Error('escrow round-trip failed');

  // recovery code round-trips, normalises loose input
  const code = generateRecoveryCode();
  if (!/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/.test(code)) {
    throw new Error('recovery code shape unexpected: ' + code);
  }
  const recRec = await buildRecoveryRecord({ username: 'demo', pat, recoveryCode: code });
  const recovered = await unlockRecoveryRecord(recRec, code.toLowerCase()); // case-insensitive
  if (recovered !== pat) throw new Error('recovery round-trip failed');

  // bad recovery code throws
  let threwOnBadCode = false;
  try {
    await unlockRecoveryRecord(recRec, generateRecoveryCode());
  } catch (e) { threwOnBadCode = true; }
  if (!threwOnBadCode) throw new Error('wrong recovery code did not throw');

  return { ok: true, message: 'all auth.js self-tests passed (incl. escrow + recovery)' };
}
