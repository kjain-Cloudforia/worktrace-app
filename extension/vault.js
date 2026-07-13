/**
 * vault.js — Tab Vault data model + Chrome tab bridge for the extension.
 *
 * Produces and consumes the EXACT same shape as the dashboard module
 * (see app/docs/schema/tabgroups/v1.json), so the extension and the
 * dashboard edit one shared file without migration:
 *
 *   { schema_version, user_id, display_name, updated_at, groups: [
 *       { id, name, color, source, collapsed, links: [
 *           { id, url, title, favicon, added_at } ] } ] }
 *
 * The Chrome-side bridge (capture / reopen) is the whole reason the
 * extension exists — a web page can't read live tabs or make tab groups.
 */

// Chrome's nine tab-group colours (chrome.tabGroups.color enum). Our schema's
// `color` field uses these exact keys, so import/reopen is lossless.
export const CHROME_TAB_GROUP_COLORS =
  ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const COLOR_HEX = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00',
  green: '#188038', pink: '#d01884', purple: '#9334e6', cyan: '#12a4af', orange: '#fa903e',
};
export function hexForColor(colorKey) {
  return COLOR_HEX[colorKey] || COLOR_HEX.grey;
}
// chrome.tabGroups.update rejects an unknown colour, so clamp to the enum.
export function colorForReopen(colorKey) {
  return CHROME_TAB_GROUP_COLORS.includes(colorKey) ? colorKey : 'grey';
}

// The one canonical "Ungrouped" collection. Loose (non-tab-group) tabs always
// fold into a single group with this stable id, so repeated saves append to it
// rather than spawning a new timestamped group every time.
export const UNGROUPED_GROUP_ID = 'grp_ungrouped';

// ---- id + URL helpers (mirror the dashboard module) ----

export function makeId(prefix) {
  const randomChunk = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${randomChunk}`;
}

export function hostnameForUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function emptyVaultModel(userId, displayName) {
  return {
    schema_version: 1,
    user_id: userId || 'unknown',
    display_name: displayName || '',
    updated_at: new Date().toISOString(),
    groups: [],
  };
}

// Auto-generated legacy name from before the single-collection change, e.g.
// "Ungrouped · 13 Jul, 16:50". We only ever sweep these — never a group the
// user named themselves.
const LEGACY_UNGROUPED_DATED_RE = /^Ungrouped\s·\s/;

/**
 * Fold any legacy dated "Ungrouped · <time>" groups into the single canonical
 * Ungrouped collection (id UNGROUPED_GROUP_ID). Mutates model.groups in place;
 * returns true if anything changed. Links are deduped by URL. If a canonical
 * group already exists its name is preserved (respects a user rename);
 * otherwise a fresh one named plainly "Ungrouped" is created in the first
 * legacy group's slot.
 */
export function consolidateUngroupedGroups(model) {
  const groupList = model.groups || [];
  let canonicalGroup = null;
  let canonicalIndex = -1;
  const legacyIndexList = [];
  for (let index = 0; index < groupList.length; index++) {
    const group = groupList[index];
    if (group.id === UNGROUPED_GROUP_ID) { canonicalGroup = group; canonicalIndex = index; continue; }
    if (LEGACY_UNGROUPED_DATED_RE.test(group.name || '')) legacyIndexList.push(index);
  }
  if (legacyIndexList.length === 0) return false;   // nothing dated to sweep

  const targetGroup = canonicalGroup || {
    id: UNGROUPED_GROUP_ID, name: 'Ungrouped', color: 'grey', source: 'manual',
    collapsed: false, links: [],
  };
  if (!Array.isArray(targetGroup.links)) targetGroup.links = [];
  const seenUrlSet = new Set(targetGroup.links.map(link => link.url));
  for (const legacyIndex of legacyIndexList) {
    for (const link of (groupList[legacyIndex].links || [])) {
      if (seenUrlSet.has(link.url)) continue;
      seenUrlSet.add(link.url);
      targetGroup.links.push(link);
    }
  }

  const legacyIndexSet = new Set(legacyIndexList);
  const insertNewCanonicalAt = canonicalIndex >= 0 ? -1 : legacyIndexList[0];
  const rebuiltGroupList = [];
  for (let index = 0; index < groupList.length; index++) {
    if (index === insertNewCanonicalAt) rebuiltGroupList.push(targetGroup);
    if (legacyIndexSet.has(index)) continue;         // drop the legacy dated group
    rebuiltGroupList.push(groupList[index]);         // keeps an existing canonical in place
  }
  model.groups = rebuiltGroupList;
  return true;
}

// ---- Chrome bridge: capture current-window tabs into vault groups ----

/**
 * Read the current window's tabs (and their native tab groups) and shape them
 * into new vault groups. Tabs that share a Chrome tab group become one vault
 * group carrying that group's title + colour (source: 'chrome'); loose tabs
 * collect into a single dated "Ungrouped" group (source: 'manual'). Only
 * http/https tabs are saved — chrome://, extension pages, etc. are skipped.
 *
 * Returns { newGroupList, savedTabList, savableCount, skippedCount }, where
 * savedTabList is [{ tabId, title, host, groupName }] for the close-picker.
 */
export async function captureCurrentWindowTabs() {
  const tabList = await chrome.tabs.query({ currentWindow: true });
  const savableTabList = tabList.filter(tab => tab.url && /^https?:\/\//i.test(tab.url));
  const skippedCount = tabList.length - savableTabList.length;

  // Resolve each referenced Chrome tab group's title + colour once.
  const groupIdVsInfoMap = new Map();
  const referencedGroupIdSet = new Set(
    savableTabList.map(tab => tab.groupId).filter(id => id != null && id !== -1));
  for (const groupId of referencedGroupIdSet) {
    try {
      const chromeGroup = await chrome.tabGroups.get(groupId);
      groupIdVsInfoMap.set(groupId, {
        title: chromeGroup.title || 'Group',
        color: chromeGroup.color || 'grey',
      });
    } catch {
      /* group closed between query and get — treat its tabs as ungrouped */
    }
  }

  // Bucket tabs by group key, preserving first-seen order. Keep each tab's
  // chrome tab id next to its vault link so the popup can offer a per-tab
  // "close" picker afterward (the link itself never stores the ephemeral id).
  const orderedGroupKeyList = [];
  const groupKeyVsItemListMap = new Map();   // groupKey -> [{ tabId, link }]
  for (const tab of savableTabList) {
    const hasGroup = tab.groupId != null && tab.groupId !== -1 && groupIdVsInfoMap.has(tab.groupId);
    const groupKey = hasGroup ? `g:${tab.groupId}` : 'ungrouped';
    if (!groupKeyVsItemListMap.has(groupKey)) {
      groupKeyVsItemListMap.set(groupKey, []);
      orderedGroupKeyList.push(groupKey);
    }
    groupKeyVsItemListMap.get(groupKey).push({
      tabId: tab.id,
      link: {
        id: makeId('lnk'),
        url: tab.url,
        title: tab.title || hostnameForUrl(tab.url),
        favicon: tab.favIconUrl || null,
        added_at: new Date().toISOString(),
      },
    });
  }

  // Resolve each bucket's display meta once so the vault group and the
  // close-picker rows agree on the group name. Loose tabs use the fixed
  // "Ungrouped" name + stable id so the merge on save keeps them in one place.
  function metaForKey(groupKey) {
    if (groupKey === 'ungrouped') return { name: 'Ungrouped', color: 'grey', source: 'manual' };
    const info = groupIdVsInfoMap.get(Number(groupKey.slice(2)));
    return { name: info?.title || 'Group', color: info?.color || 'grey', source: 'chrome' };
  }

  const newGroupList = [];
  const savedTabList = [];
  for (const groupKey of orderedGroupKeyList) {
    const isUngrouped = groupKey === 'ungrouped';
    const meta = metaForKey(groupKey);
    const itemList = groupKeyVsItemListMap.get(groupKey);
    newGroupList.push({
      id: isUngrouped ? UNGROUPED_GROUP_ID : makeId('grp'),
      name: meta.name,
      color: meta.color,
      source: meta.source,
      collapsed: false,
      links: itemList.map(item => item.link),
    });
    for (const item of itemList) {
      if (item.tabId == null) continue;
      savedTabList.push({
        tabId: item.tabId,
        title: item.link.title,
        host: hostnameForUrl(item.link.url),
        groupName: meta.name,
      });
    }
  }

  return {
    newGroupList,
    savedTabList,
    savableCount: savableTabList.length,
    skippedCount,
  };
}

// ---- Chrome bridge: reopen a vault group AS a real Chrome tab group ----

/**
 * Recreate a vault group's tabs and bundle them into a Chrome tab group with
 * the saved name + colour restored. Returns { opened } (tabs actually created).
 */
export async function reopenGroupAsTabGroup(group) {
  const linkList = group.links || [];
  if (linkList.length === 0) return { opened: 0 };

  const createdTabIdList = [];
  for (const link of linkList) {
    try {
      const createdTab = await chrome.tabs.create({ url: link.url, active: false });
      if (createdTab?.id != null) createdTabIdList.push(createdTab.id);
    } catch {
      /* a bad URL slips through — skip that one tab, keep going */
    }
  }
  if (createdTabIdList.length === 0) return { opened: 0 };

  const newTabGroupId = await chrome.tabs.group({ tabIds: createdTabIdList });
  await chrome.tabGroups.update(newTabGroupId, {
    title: group.name || 'Group',
    color: colorForReopen(group.color),
  });
  return { opened: createdTabIdList.length };
}
