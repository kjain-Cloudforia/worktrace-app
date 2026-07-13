/**
 * popup.js — WorkTrace Tab Vault extension controller.
 *
 * Sign-in reuses the dashboard's auth.js (username + password → decrypt the
 * user's GitHub PAT). The PAT lives in chrome.storage.session, so it clears
 * when the browser closes — the same blast radius as the dashboard's
 * sessionStorage. The vault file (modules/tabgroups/data.json in the user's
 * data repo) is the single shared source of truth for extension + dashboard.
 *
 * MV3 blocks inline scripts/handlers, so every listener is bound here.
 */

import { unlockUserRecord } from './auth.js';
import { fetchAuthRecord, probeRepo, ghGetJson, ghPutJson, VAULT_DATA_PATH } from './github.js';
import {
  captureCurrentWindowTabs, reopenGroupAsTabGroup, emptyVaultModel, hexForColor, hostnameForUrl,
  UNGROUPED_GROUP_ID, consolidateUngroupedGroups,
} from './vault.js';

const $ = (id) => document.getElementById(id);

// In-memory mirror of the session (also persisted to chrome.storage.session).
let SESSION = null;                 // { username, pat, dataRepo, displayName }
let pendingCloseTabList = [];       // savedTabList [{tabId,title,host,groupName}] from the last save
let selectedTabIdSet = new Set();   // tab ids the user ticked to close
let currentVaultModel = null;       // the vault model currently rendered (for in-place edits)

// Inlined trash icon (MV3 blocks remote assets).
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

// ---- session persistence ----
async function loadSession() {
  const stored = await chrome.storage.session.get(['pat', 'username', 'dataRepo', 'displayName']);
  if (stored && stored.pat && stored.dataRepo) { SESSION = stored; return true; }
  return false;
}
async function saveSession(session) {
  SESSION = session;
  await chrome.storage.session.set(session);
}
async function clearSession() {
  SESSION = null;
  pendingCloseTabList = [];
  selectedTabIdSet = new Set();
  await chrome.storage.session.clear();
}

function showView(which) {
  $('view-signin').hidden = which !== 'signin';
  $('view-main').hidden = which !== 'main';
}

// ---- sign in ----
async function doSignIn() {
  const username = $('in-username').value.trim().toLowerCase();
  const password = $('in-password').value;
  const errEl = $('signin-error');
  errEl.hidden = true;
  if (!username || !password) {
    errEl.textContent = 'Enter your username and password.';
    errEl.hidden = false;
    return;
  }
  const signInButton = $('btn-signin');
  const workingEl = $('signin-working');
  signInButton.disabled = true;
  workingEl.hidden = false;
  try {
    const record = await fetchAuthRecord(username);
    let pat, publicFields;
    try {
      const unlocked = await unlockUserRecord(record, password);
      pat = unlocked.pat;
      publicFields = unlocked.record;
    } catch {
      throw new Error('Incorrect username or password.');
    }
    if (!publicFields.data_repo) {
      throw new Error('This account has no personal vault (admins manage others via the dashboard).');
    }
    const reachable = await probeRepo(publicFields.data_repo, pat);
    if (!reachable) throw new Error('Your stored credential was revoked. Contact the admin to re-issue it.');

    await saveSession({
      username,
      pat,
      dataRepo: publicFields.data_repo,
      displayName: publicFields.display_name || username,
    });
    await chrome.storage.local.set({ lastUsername: username });   // non-secret; prefill next time
    $('in-password').value = '';
    await enterMain();
  } catch (e) {
    errEl.textContent = e.message || 'Sign-in failed.';
    errEl.hidden = false;
  } finally {
    signInButton.disabled = false;
    workingEl.hidden = true;
  }
}

// ---- main view ----
async function enterMain() {
  $('who').textContent = SESSION.displayName || SESSION.username;
  $('close-prompt').hidden = true;
  $('save-status').hidden = true;
  showView('main');
  await renderGroups();
}

async function fetchVault() {
  try {
    return await ghGetJson(SESSION.dataRepo, VAULT_DATA_PATH, SESSION.pat);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return emptyVaultModel(SESSION.username, SESSION.displayName);
    throw e;
  }
}

async function renderGroups(preloadedModel) {
  const box = $('groups');
  // When we already hold the model in memory (right after a save), render from
  // it directly — this avoids GitHub read-after-write lag hiding just-saved
  // groups (which is what made a fresh "Ungrouped" bucket seem to vanish).
  let model = preloadedModel;
  if (!model) {
    box.textContent = 'Loading…';
    try {
      model = await fetchVault();
    } catch (e) {
      box.textContent = '';
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = e.message;
      box.appendChild(p);
      return;
    }
    // Self-heal on load: fold any legacy dated "Ungrouped · <time>" groups into
    // the single canonical collection and persist that once.
    if (consolidateUngroupedGroups(model)) {
      try {
        model.updated_at = new Date().toISOString();
        await ghPutJson(SESSION.dataRepo, VAULT_DATA_PATH, model, SESSION.pat,
          'Consolidate Ungrouped groups into one');
      } catch (e) {
        console.error('consolidate write failed:', e);
      }
    }
  }
  box.textContent = '';
  currentVaultModel = model;                 // retained so delete handlers can edit it
  const groupList = model.groups || [];
  if (groupList.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No groups yet. Save some tabs, or add them in the dashboard.';
    box.appendChild(p);
    return;
  }
  for (const group of groupList) box.appendChild(renderGroupRow(group));
}

function renderGroupRow(group) {
  const linkList = group.links || [];
  const linkCount = linkList.length;

  const chevron = document.createElement('span');
  chevron.className = 'grp-chevron grp-chevron--collapsed';   // starts collapsed
  chevron.textContent = '▾';

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = hexForColor(group.color);

  const name = document.createElement('span');
  name.className = 'grp-name';
  name.textContent = group.name || 'Untitled';
  name.title = group.name || 'Untitled';

  const count = document.createElement('span');
  count.className = 'grp-count';
  count.textContent = String(linkCount);

  const openButton = document.createElement('button');
  openButton.className = 'btn btn-ghost btn-sm';
  openButton.textContent = 'Open';
  openButton.disabled = linkCount === 0;
  openButton.addEventListener('click', async (e) => {
    e.stopPropagation();                       // don't toggle expand
    openButton.disabled = true;
    openButton.textContent = 'Opening…';
    try {
      const { opened } = await reopenGroupAsTabGroup(group);
      openButton.textContent = opened ? 'Opened ✓' : 'Nothing';
    } catch (err) {
      console.error('reopen failed:', err);
      openButton.textContent = 'Failed';
    }
    setTimeout(() => { openButton.textContent = 'Open'; openButton.disabled = linkCount === 0; }, 1500);
  });

  // Delete group — two-click confirm (a window.confirm() dialog can dismiss the
  // popup on focus loss, so we arm-then-confirm inline instead).
  const deleteButton = document.createElement('button');
  deleteButton.className = 'grp-del';
  deleteButton.title = 'Delete group';
  deleteButton.setAttribute('aria-label', 'Delete group');
  deleteButton.innerHTML = TRASH_SVG;
  let deleteArmed = false;
  let deleteTimer = null;
  deleteButton.addEventListener('click', async (e) => {
    e.stopPropagation();                     // don't toggle expand
    if (!deleteArmed) {
      deleteArmed = true;
      deleteButton.classList.add('grp-del--armed');
      deleteButton.textContent = 'Delete?';
      deleteTimer = setTimeout(() => {
        deleteArmed = false;
        deleteButton.classList.remove('grp-del--armed');
        deleteButton.innerHTML = TRASH_SVG;
      }, 3000);
      return;
    }
    clearTimeout(deleteTimer);
    await deleteGroup(group);
  });

  const header = document.createElement('div');
  header.className = 'grp-header';
  header.append(chevron, dot, name, count, openButton, deleteButton);

  // Collapsible list of the group's actual tabs — so you can SEE what's inside,
  // which is the whole point for the opaque "Ungrouped · <time>" bucket.
  const tabsBox = document.createElement('div');
  tabsBox.className = 'grp-tabs';
  tabsBox.hidden = true;
  if (linkCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'grp-tab muted-tab';
    empty.textContent = 'No tabs in this group.';
    tabsBox.appendChild(empty);
  } else {
    for (const link of linkList) {
      const host = hostnameForUrl(link.url);
      const titleSpan = document.createElement('span');
      titleSpan.className = 'grp-tab__title';
      titleSpan.textContent = link.title || host;
      const hostSpan = document.createElement('span');
      hostSpan.className = 'grp-tab__host';
      hostSpan.textContent = host;

      const tabDeleteButton = document.createElement('button');
      tabDeleteButton.className = 'grp-tab__del';
      tabDeleteButton.textContent = '×';
      tabDeleteButton.title = 'Remove this tab from the vault';
      tabDeleteButton.setAttribute('aria-label', 'Remove tab');
      tabDeleteButton.addEventListener('click', async (e) => {
        e.stopPropagation();                 // don't open the tab
        await deleteTab(group, link);
      });

      const tabRow = document.createElement('div');
      tabRow.className = 'grp-tab';
      tabRow.title = `${link.url}\n(click to open just this tab)`;
      tabRow.append(titleSpan, hostSpan, tabDeleteButton);
      tabRow.addEventListener('click', () => { chrome.tabs.create({ url: link.url, active: false }); });
      tabsBox.appendChild(tabRow);
    }
  }

  // Clicking the header (anywhere but the Open button) expands/collapses.
  header.addEventListener('click', () => {
    const willHide = !tabsBox.hidden;
    tabsBox.hidden = willHide;
    chevron.classList.toggle('grp-chevron--collapsed', willHide);
  });

  const wrap = document.createElement('div');
  wrap.className = 'grp';
  wrap.append(header, tabsBox);
  return wrap;
}

// ---- edit the vault (delete group / tab) ----
async function persistVault(commitMessage) {
  if (!currentVaultModel) return;
  currentVaultModel.updated_at = new Date().toISOString();
  try {
    await ghPutJson(SESSION.dataRepo, VAULT_DATA_PATH, currentVaultModel, SESSION.pat, commitMessage);
  } catch (e) {
    console.error('vault write failed:', e);
    const statusEl = $('save-status');
    statusEl.className = 'status error';
    statusEl.textContent = e.message || 'Delete failed to save.';
    statusEl.hidden = false;
  }
}

async function deleteGroup(group) {
  currentVaultModel.groups = (currentVaultModel.groups || []).filter(existing => existing.id !== group.id);
  await persistVault(`Delete group "${group.name}"`);
  await renderGroups(currentVaultModel);
}

async function deleteTab(group, link) {
  group.links = (group.links || []).filter(existing => existing.id !== link.id);
  await persistVault('Remove a tab from the vault');
  await renderGroups(currentVaultModel);
}

// ---- save all open tabs ----
async function doSaveAllTabs() {
  const saveButton = $('btn-save');
  const statusEl = $('save-status');
  const originalLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  statusEl.hidden = true;
  $('close-prompt').hidden = true;

  try {
    const { newGroupList, savedTabList, savableCount, skippedCount } = await captureCurrentWindowTabs();
    if (savableCount === 0) {
      statusEl.className = 'status muted';
      statusEl.textContent = 'No saveable (http/https) tabs in this window.';
      statusEl.hidden = false;
      return;
    }
    const model = await fetchVault();
    consolidateUngroupedGroups(model);   // fold any legacy dated ungrouped first
    model.groups = model.groups || [];
    // Merge: Chrome groups append as new; loose tabs always fold into the one
    // canonical "Ungrouped" collection (dedup by URL) instead of a fresh group.
    for (const newGroup of newGroupList) {
      if (newGroup.id === UNGROUPED_GROUP_ID) {
        const existingUngroupedGroup = model.groups.find(group => group.id === UNGROUPED_GROUP_ID);
        if (existingUngroupedGroup) {
          const existingUrlSet = new Set((existingUngroupedGroup.links || []).map(link => link.url));
          const freshLinkList = (newGroup.links || []).filter(link => !existingUrlSet.has(link.url));
          existingUngroupedGroup.links = (existingUngroupedGroup.links || []).concat(freshLinkList);
          continue;
        }
      }
      model.groups.push(newGroup);
    }
    model.updated_at = new Date().toISOString();
    await ghPutJson(SESSION.dataRepo, VAULT_DATA_PATH, model, SESSION.pat,
      `Save ${savableCount} tab(s) from the Tab Vault extension`);

    statusEl.className = 'status';
    statusEl.textContent =
      `Saved ${savableCount} tab(s) in ${newGroupList.length} group(s)` +
      (skippedCount ? ` · skipped ${skippedCount} non-web` : '') + '.';
    statusEl.hidden = false;

    // Offer a per-tab close picker (nothing pre-selected — you choose which).
    renderClosePicker(savedTabList);
    // Render from the model we just wrote (not a re-fetch) so the new groups —
    // including a fresh "Ungrouped" bucket — are guaranteed to appear now.
    await renderGroups(model);
  } catch (e) {
    statusEl.className = 'status error';
    statusEl.textContent = e.message || 'Save failed.';
    statusEl.hidden = false;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalLabel;
  }
}

// ---- per-tab close picker ----
function updateCloseButton() {
  const closeButton = $('btn-close-tabs');
  const count = selectedTabIdSet.size;
  closeButton.textContent = `Close selected (${count})`;
  closeButton.disabled = count === 0;
}

function setAllChecked(checked) {
  selectedTabIdSet = new Set();
  for (const checkbox of $('close-list').querySelectorAll('input[type=checkbox]')) {
    checkbox.checked = checked;
    if (checked) selectedTabIdSet.add(Number(checkbox.dataset.tabId));
  }
  updateCloseButton();
}

function renderClosePicker(savedTabList) {
  pendingCloseTabList = savedTabList;
  selectedTabIdSet = new Set();               // default: nothing selected — you pick
  const listBox = $('close-list');
  listBox.textContent = '';

  let currentGroupName = null;
  for (const savedTab of savedTabList) {
    if (savedTab.groupName !== currentGroupName) {
      currentGroupName = savedTab.groupName;
      const header = document.createElement('div');
      header.className = 'close-group';
      header.textContent = currentGroupName;
      listBox.appendChild(header);
    }
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.tabId = String(savedTab.tabId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedTabIdSet.add(savedTab.tabId);
      else selectedTabIdSet.delete(savedTab.tabId);
      updateCloseButton();
    });
    const text = document.createElement('span');
    text.className = 'close-item__text';
    text.textContent = savedTab.title || savedTab.host;
    text.title = savedTab.host;

    const rowLabel = document.createElement('label');
    rowLabel.className = 'close-item';
    rowLabel.append(checkbox, text);
    listBox.appendChild(rowLabel);
  }

  $('close-prompt-text').textContent = 'Close saved tabs? Tick the ones to close.';
  updateCloseButton();
  $('close-prompt').hidden = false;
}

async function doCloseSelectedTabs() {
  const tabIdList = [...selectedTabIdSet];
  $('close-prompt').hidden = true;
  if (tabIdList.length === 0) return;
  try {
    await chrome.tabs.remove(tabIdList);
  } catch (e) {
    console.error('close tabs failed:', e);
  }
  selectedTabIdSet = new Set();
  pendingCloseTabList = [];
}

function dismissClosePrompt() {
  $('close-prompt').hidden = true;
  selectedTabIdSet = new Set();
  pendingCloseTabList = [];
}

// ---- wire up + boot ----
function bindEvents() {
  $('btn-signin').addEventListener('click', doSignIn);
  $('in-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('in-password').focus(); });
  $('in-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
  $('btn-signout').addEventListener('click', async () => { await clearSession(); showView('signin'); });
  $('btn-save').addEventListener('click', doSaveAllTabs);
  $('btn-sel-all').addEventListener('click', () => setAllChecked(true));
  $('btn-sel-none').addEventListener('click', () => setAllChecked(false));
  $('btn-close-tabs').addEventListener('click', doCloseSelectedTabs);
  $('btn-keep-tabs').addEventListener('click', dismissClosePrompt);
}

async function boot() {
  bindEvents();
  const { lastUsername } = await chrome.storage.local.get(['lastUsername']);
  if (lastUsername) $('in-username').value = lastUsername;
  if (await loadSession()) await enterMain();
  else showView('signin');
}

// Module scripts are deferred and run after the DOM is parsed, so the elements
// exist here — no need to wait for DOMContentLoaded (which may already have fired).
boot();
