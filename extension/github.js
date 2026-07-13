/**
 * github.js — GitHub Contents API helpers for the Tab Vault extension.
 *
 * Mirrors the read/write logic in the dashboard's shell.js so the extension
 * touches the SAME files the same way:
 *   - auth record:  worktrace-auth/users/<username>.json   (public, no PAT)
 *   - vault data:   <data_repo>/modules/tabgroups/data.json (PAT read+write)
 *
 * We always use api.github.com (the Contents API), never raw.githubusercontent
 * .com — the raw CDN caches by path and can serve stale blobs for minutes
 * after a write, which the dashboard hit repeatedly. The Contents API is keyed
 * by commit and is always current.
 */

const GITHUB_API = 'https://api.github.com';
const AUTH_API = 'https://api.github.com/repos/kjain-Cloudforia/worktrace-auth/contents';

// UTF-8-safe string → base64 (GitHub wants base64 content). Mirrors
// shell.js strToBase64; `unescape` is deprecated but is the standard
// browser idiom here and works in the extension context.
function strToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

/**
 * Fetch a user's (encrypted) auth record from the public worktrace-auth repo.
 * No PAT needed — the repo is public and the ciphertext is safe to read.
 */
export async function fetchAuthRecord(username) {
  const url = `${AUTH_API}/users/${encodeURIComponent(username)}.json`;
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

/** Quick reachability probe used to sanity-check a freshly-decrypted PAT. */
export async function probeRepo(repo, pat) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}`, {
    headers: { 'Authorization': `Bearer ${pat}` },
    cache: 'no-store',
  });
  return res.ok;
}

/**
 * GET a JSON file from a repo via the Contents API. Throws with code
 * 'NOT_FOUND' when the file doesn't exist yet (first-ever save), so callers
 * can start from an empty model.
 */
export async function ghGetJson(repo, path, pat) {
  // Cache-buster + no-store: GitHub returns `Cache-Control: private, max-age=60`
  // on authenticated reads, so the browser would otherwise serve a stale copy
  // for up to a minute after a write — which made a just-saved group show once
  // (from the in-memory render) and then vanish on the next popup open.
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}?ref=main&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.raw' },
    cache: 'no-store',
  });
  if (res.status === 404) {
    const err = new Error(`File not found at ${path}.`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Your session expired or the token is no longer valid. Sign in again.');
  }
  if (!res.ok) throw new Error(`GitHub GET ${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * PUT a JSON object to a repo path (create or update). Probes for the current
 * blob SHA first (required on update, omitted on create) — the same
 * optimistic-concurrency pattern as the dashboard. Serialised with a 2-space
 * indent + trailing newline so it stays diff-clean against dpsync's format.
 */
export async function ghPutJson(repo, path, dataObject, pat, commitMessage) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`;

  let sha = null;
  // no-store so we probe the CURRENT sha, not a cached one (a stale sha would
  // make the PUT 409, and a cached read could otherwise drop concurrent edits).
  const probe = await fetch(url, { headers: { 'Authorization': `Bearer ${pat}` }, cache: 'no-store' });
  if (probe.status === 200) {
    sha = (await probe.json()).sha;
  } else if (probe.status !== 404) {
    throw new Error(`Failed to read existing file: HTTP ${probe.status}`);
  }

  const body = {
    message: commitMessage,
    content: strToBase64(JSON.stringify(dataObject, null, 2) + '\n'),
    branch: 'main',
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Your token can't write to your data repo. Ask the admin to add Contents:Write to your PAT scope.");
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub PUT ${path} → HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

export const VAULT_DATA_PATH = 'modules/tabgroups/data.json';
