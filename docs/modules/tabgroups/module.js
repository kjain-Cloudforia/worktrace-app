/**
 * modules/tabgroups/module.js
 *
 * Tab Vault module for the WorkTrace dashboard.
 *
 * A place to park browser tabs — grouped into named, colour-coded folders —
 * so you can close them in Chrome (freeing RAM) and reopen a whole group
 * later. Phase 1 is dashboard-only and manual: you add/paste URLs and
 * organise them here by hand. A future companion Chrome extension (Phase 2)
 * will add one-click "save all my open tabs", import of Chrome's native tab
 * groups (name + colour), reopen-a-group-as-a-real-Chrome-group, and a
 * one-time "close the tabs you just saved?" prompt.
 *
 * This is the platform's first BROWSER-EDITABLE module: unlike Timesheet
 * (generated on the laptop, read-only here), the Tab Vault writes its state
 * straight back to the user's private data repo via ctx.saveMyData(). The
 * data lives at modules/tabgroups/data.json — private, per-user, and it
 * syncs to any device the user signs in from.
 *
 * Forward-compat hooks for Phase 2 already live in the data model: each
 * group carries `color` (a Chrome tab-group colour key) and `source`
 * ("manual" now; "chrome" when the extension imports a native group), so
 * the extension bolts on with zero migration.
 *
 * Module contract: see ../../shell.js for the lifecycle hook signatures.
 */

// ---- tiny helpers (duplicated from shell to keep modules self-contained) ----

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

// Chrome's nine tab-group colours, in Chrome's own order. `key` matches the
// value chrome.tabGroups reports (Phase 2 imports read straight into it);
// `hex` is what we paint the colour dot with. A group with color === null
// (a custom folder that never came from a Chrome group) falls back to grey.
const CHROME_GROUP_COLOR_LIST = [
  { key: 'grey',   label: 'Grey',   hex: '#5f6368' },
  { key: 'blue',   label: 'Blue',   hex: '#1a73e8' },
  { key: 'red',    label: 'Red',    hex: '#d93025' },
  { key: 'yellow', label: 'Yellow', hex: '#f9ab00' },
  { key: 'green',  label: 'Green',  hex: '#188038' },
  { key: 'pink',   label: 'Pink',   hex: '#d01884' },
  { key: 'purple', label: 'Purple', hex: '#9334e6' },
  { key: 'cyan',   label: 'Cyan',   hex: '#12a4af' },
  { key: 'orange', label: 'Orange', hex: '#fa903e' },
];
const colorKeyVsHexMap = new Map(CHROME_GROUP_COLOR_LIST.map(c => [c.key, c.hex]));

function hexForColorKey(colorKey) {
  return colorKeyVsHexMap.get(colorKey) || colorKeyVsHexMap.get('grey');
}

// Inlined SVGs (same zero-network-fetch ethos as shell.js's eye toggle).
const ICON_GLOBE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_MORE = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`;
const ICON_GRIP = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;

// ---- id + URL helpers ----

// Stable, collision-safe enough ids for a personal vault. crypto.randomUUID
// is available in every browser we target; the Math.random fallback only
// matters for ancient engines.
function makeId(prefix) {
  const randomChunk = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${randomChunk}`;
}

// Normalise a user-typed URL: add https:// if the scheme is missing, reject
// anything that isn't http/https (no javascript:, data:, etc.). Returns the
// canonical href, or null if it can't be made into a valid web URL.
function normalizeUrl(rawUrl) {
  let candidate = (rawUrl || '').trim();
  if (!candidate) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = 'https://' + candidate;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function hostnameForUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Parse a textarea of pasted lines into link objects. Each line is either a
// bare URL or "Name | URL" (split on the first pipe — a raw '|' can't appear
// in an unencoded URL, so this is unambiguous). Un-named lines fall back to
// the hostname. Shared by the "Add links" modal and the "New group" modal's
// optional seed-tabs field. Returns { addedLinkList, skippedCount }.
function parseLinkLines(rawText) {
  const addedLinkList = [];
  let skippedCount = 0;
  for (const rawLine of (rawText || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let typedName = '';
    let urlPart = line;
    const pipeIndex = line.indexOf('|');
    if (pipeIndex !== -1) {
      typedName = line.slice(0, pipeIndex).trim();
      urlPart = line.slice(pipeIndex + 1).trim();
    }
    const normalizedUrl = normalizeUrl(urlPart);
    if (!normalizedUrl) { skippedCount++; continue; }
    addedLinkList.push({
      id: makeId('lnk'),
      url: normalizedUrl,
      title: typedName || hostnameForUrl(normalizedUrl),
      added_at: new Date().toISOString(),
    });
  }
  return { addedLinkList, skippedCount };
}

// ---- model helpers ----

function emptyModel(currentUser) {
  return {
    schema_version: 1,
    user_id: currentUser?.username || 'unknown',
    display_name: currentUser?.display_name || '',
    updated_at: new Date().toISOString(),
    groups: [],
  };
}

function totalLinkCount(dataModel) {
  return (dataModel.groups || []).reduce(
    (runningTotal, group) => runningTotal + (group.links?.length || 0), 0);
}

// ---- Module export ----

export default {
  id: 'tabgroups',
  displayName: 'Tab Vault',
  description: 'Park tab groups · free RAM',
  schemaVersion: 1,
  stylesheet: 'module.css',
  // Admin auth records carry data_repo === null (admins have no personal
  // data repo — they manage others via the Admin module). A personal Tab
  // Vault has nowhere to save for them, so hide the tile, same as Timesheet.
  hideForAdmin: true,

  async init(_shell) {
    // Nothing to preload — data is fetched lazily per view.
  },

  /**
   * Tile view: group count, total link count, and a preview of the most
   * recently touched groups as colour-dot chips.
   */
  async renderTile(container, ctx) {
    container.innerHTML = '';

    let dataModel;
    try {
      dataModel = await ctx.fetchMyData();
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        container.appendChild(el('p', { class: 'wt-tile__placeholder' },
          'No tabs parked yet — click to make your first group →'));
        return;
      }
      container.appendChild(el('p', { class: 'wt-tile__placeholder' },
        `Error: ${err.message}`));
      return;
    }

    const groupList = dataModel.groups || [];
    if (groupList.length === 0) {
      container.appendChild(el('p', { class: 'wt-tile__placeholder' },
        'No tabs parked yet — click to make your first group →'));
      return;
    }

    const previewChipList = groupList.slice(0, 6).map(group =>
      el('span', { class: 'wt-tv-chip' },
        el('span', { class: 'wt-tv-dot', style: `background:${hexForColorKey(group.color)}` }),
        group.name || 'Untitled',
        el('span', { class: 'wt-tv-chip__count' }, String(group.links?.length || 0)),
      ));

    container.append(
      el('div', { class: 'wt-tv-tile' },
        el('div', { class: 'wt-tv-tile__stats' },
          el('div', { class: 'wt-tv-tile__stat' },
            el('span', { class: 'wt-tv-tile__stat-num' }, String(groupList.length)),
            el('span', { class: 'wt-tv-tile__stat-label' }, groupList.length === 1 ? 'group' : 'groups')),
          el('div', { class: 'wt-tv-tile__stat' },
            el('span', { class: 'wt-tv-tile__stat-num' }, String(totalLinkCount(dataModel))),
            el('span', { class: 'wt-tv-tile__stat-label' }, 'saved tabs')),
        ),
        el('div', { class: 'wt-tv-tile__chips' }, ...previewChipList),
        el('div', { class: 'wt-tv-tile__hint' }, 'Click to expand →'),
      ));
  },

  /**
   * Detail view: full create/rename/recolour/delete for groups, add / bulk-
   * paste / edit / move / delete for links, and per-group "Open all".
   *
   * State lives in a single `dataModel` object held in this closure. Every
   * mutation updates it in memory, re-renders, and calls persist() — which
   * serialises writes back to the data repo (each PUT re-probes the blob SHA,
   * so serialising avoids optimistic-concurrency races between quick edits).
   */
  async renderDetail(container, ctx) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'Loading…'));

    let dataModel;
    try {
      dataModel = await ctx.fetchMyData();
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        // First ever visit — no file in the repo yet. Start empty; the first
        // save creates modules/tabgroups/data.json.
        dataModel = emptyModel(ctx.currentUser);
      } else {
        container.innerHTML = '';
        container.appendChild(el('p', { class: 'wt-error' }, `Error loading data: ${err.message}`));
        return;
      }
    }
    if (!Array.isArray(dataModel.groups)) dataModel.groups = [];

    container.innerHTML = '';

    // ---- save plumbing (serialised; one commit per mutation) ----
    const saveStatusEl = el('span', { class: 'wt-tv-savestatus' }, '');
    function setSaveStatus(state, detail) {
      saveStatusEl.className = `wt-tv-savestatus wt-tv-savestatus--${state}`;
      if (state === 'saving') saveStatusEl.textContent = 'Saving…';
      else if (state === 'saved') saveStatusEl.textContent = 'Saved ✓';
      else if (state === 'error') saveStatusEl.textContent = `Save failed — ${detail?.message || 'retry'}`;
      else saveStatusEl.textContent = '';
    }
    let savePromiseChain = Promise.resolve();
    function persist(commitMessage) {
      setSaveStatus('saving');
      savePromiseChain = savePromiseChain
        .then(async () => {
          dataModel.updated_at = new Date().toISOString();
          await ctx.saveMyData(dataModel, commitMessage);
          setSaveStatus('saved');
        })
        .catch((err) => {
          console.error('Tab Vault save failed:', err);
          setSaveStatus('error', err);
        });
      return savePromiseChain;
    }

    // ---- popup-blocker hint (shown once "Open all" is blocked) ----
    const popupHintEl = el('p', { class: 'wt-tv-hint', hidden: true });
    function showPopupHint(blockedCount, totalCount) {
      popupHintEl.hidden = false;
      popupHintEl.textContent =
        `Chrome blocked ${blockedCount} of ${totalCount} tabs. Click the ` +
        `blocked-pop-ups icon in the address bar and choose "Always allow" ` +
        `for this site, then try "Open all" again. (The Phase 2 extension ` +
        `will open whole groups without this step.)`;
    }

    // ---- skeleton ----
    const toolbar = el('div', { class: 'wt-tv-toolbar' },
      el('button', {
        class: 'wt-tv-btn wt-tv-btn--primary',
        onclick: () => openGroupModal(null),
      }, '+ New group'),
      saveStatusEl,
    );
    const groupsContainer = el('div', { class: 'wt-tv-groups' });
    container.append(toolbar, popupHintEl, groupsContainer);

    // ---- lookups ----
    function findGroup(groupId) {
      return dataModel.groups.find(group => group.id === groupId) || null;
    }

    // ---- "Open all" — best-effort in Phase 1 (pop-up blocker limits it) ----
    function openAllInGroup(group) {
      const linkList = group.links || [];
      if (linkList.length === 0) return;
      popupHintEl.hidden = true;
      let blockedCount = 0;
      for (const link of linkList) {
        // NB: don't pass 'noopener' in the features string — that makes
        // window.open return null by spec, which would defeat the
        // blocked-vs-opened detection below. Sever the opener afterward
        // instead, which gives the same reverse-tabnabbing protection.
        const openedWindow = window.open(link.url, '_blank');
        if (openedWindow) {
          try { openedWindow.opener = null; } catch { /* cross-origin: ignore */ }
        } else {
          blockedCount++;
        }
      }
      if (blockedCount > 0) showPopupHint(blockedCount, linkList.length);
    }

    // ---- group create / edit modal (name + colour) ----
    function openGroupModal(existingGroup) {
      const isEditing = !!existingGroup;
      const nameInput = el('input', {
        type: 'text', autocomplete: 'off',
        placeholder: 'e.g. MountainWest, CPQ research, Reading list',
        value: existingGroup?.name || '',
      });

      let selectedColorKey = existingGroup?.color || 'grey';
      const swatchList = CHROME_GROUP_COLOR_LIST.map(color => {
        const swatch = el('button', {
          type: 'button',
          class: 'wt-tv-swatch' + (color.key === selectedColorKey ? ' wt-tv-swatch--on' : ''),
          style: `background:${color.hex}`,
          title: color.label,
          'aria-label': color.label,
          onclick: () => {
            selectedColorKey = color.key;
            for (const otherSwatch of swatchList) otherSwatch.classList.remove('wt-tv-swatch--on');
            swatch.classList.add('wt-tv-swatch--on');
          },
        });
        return swatch;
      });

      // Create mode only: let the user seed the group's first tabs right here,
      // so a new group can be named AND populated in one step. Edit mode keeps
      // to name + colour (tabs are managed inside the group).
      const seedTabsTextarea = isEditing ? null : el('textarea', {
        class: 'wt-tv-textarea',
        rows: '5',
        placeholder:
          'Optional — paste tabs to start with, one per line:\n' +
          'Design doc | https://docs.google.com/…\n' +
          'https://github.com/…',
      });

      const errBox = el('p', { class: 'wt-modal__error', hidden: true });
      const submit = el('button', { class: 'wt-modal__submit' }, isEditing ? 'Save' : 'Create group');
      const cancel = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

      function attempt() {
        const name = nameInput.value.trim();
        if (!name) {
          errBox.textContent = 'Give the group a name.';
          errBox.hidden = false;
          return;
        }
        if (isEditing) {
          existingGroup.name = name;
          existingGroup.color = selectedColorKey;
          persist(`Edit tab group "${name}"`);
        } else {
          const { addedLinkList } = parseLinkLines(seedTabsTextarea.value);
          dataModel.groups.push({
            id: makeId('grp'),
            name,
            color: selectedColorKey,
            source: 'manual',
            collapsed: false,
            links: addedLinkList,
          });
          persist(addedLinkList.length
            ? `Add tab group "${name}" with ${addedLinkList.length} tab(s)`
            : `Add tab group "${name}"`);
        }
        ctx.closeModal();
        renderGroups();
      }

      submit.addEventListener('click', attempt);
      cancel.addEventListener('click', () => ctx.closeModal());
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

      const modalFieldList = [
        el('h2', {}, isEditing ? 'Edit group' : 'New group'),
        el('div', { class: 'wt-modal__field' },
          el('label', {}, 'Group name'),
          nameInput),
        el('div', { class: 'wt-modal__field' },
          el('label', {}, 'Colour'),
          el('div', { class: 'wt-tv-swatches' }, ...swatchList)),
      ];
      if (!isEditing) {
        modalFieldList.push(
          el('div', { class: 'wt-modal__field' },
            el('label', {}, 'Tabs (optional)'),
            seedTabsTextarea,
            el('p', { class: 'wt-modal__hint' },
              'One URL per line. Name a tab with "Name | URL". You can add more later.')));
      }
      modalFieldList.push(
        errBox,
        el('div', { class: 'wt-modal__actions' }, cancel, submit));
      ctx.openModal(modalFieldList);
    }

    // ---- add-links modal (one URL per line → bulk add) ----
    function openAddLinksModal(group) {
      const textarea = el('textarea', {
        class: 'wt-tv-textarea',
        rows: '8',
        placeholder:
          'One URL per line. Optionally name a tab with "Name | URL":\n\n' +
          'CPQ ticket #452 | https://…\n' +
          'Design doc | https://docs.google.com/…\n' +
          'cnn.com',
      });
      const errBox = el('p', { class: 'wt-modal__error', hidden: true });
      const submit = el('button', { class: 'wt-modal__submit' }, 'Add to group');
      const cancel = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

      function attempt() {
        const { addedLinkList, skippedCount } = parseLinkLines(textarea.value);
        if (addedLinkList.length === 0) {
          errBox.textContent = skippedCount
            ? `Couldn't read any valid URLs (${skippedCount} skipped).`
            : 'Paste at least one URL.';
          errBox.hidden = false;
          return;
        }
        group.links = (group.links || []).concat(addedLinkList);
        persist(`Add ${addedLinkList.length} link(s) to "${group.name}"`);
        ctx.closeModal();
        renderGroups();
      }

      submit.addEventListener('click', attempt);
      cancel.addEventListener('click', () => ctx.closeModal());

      ctx.openModal([
        el('h2', {}, `Add links to "${group.name}"`),
        el('p', { class: 'wt-modal__lead' },
          'One URL per line. To name a tab, put a label before a pipe — ' +
          '"My label | https://…". Un-named tabs default to the site name, ' +
          'and you can rename any tab later. A missing https:// is added automatically.'),
        el('div', { class: 'wt-modal__field' }, textarea),
        errBox,
        el('div', { class: 'wt-modal__actions' }, cancel, submit),
      ]);
    }

    // ---- edit-link modal (title + url + move-to-group) ----
    function openEditLinkModal(sourceGroup, link) {
      const titleInput = el('input', {
        type: 'text', autocomplete: 'off',
        placeholder: 'Optional title', value: link.title || '',
      });
      const urlInput = el('input', {
        type: 'text', autocomplete: 'off', value: link.url || '',
      });
      const groupSelect = el('select', { class: 'wt-tv-select' },
        ...dataModel.groups.map(group =>
          el('option', { value: group.id, selected: group.id === sourceGroup.id }, group.name)));
      const errBox = el('p', { class: 'wt-modal__error', hidden: true });
      const submit = el('button', { class: 'wt-modal__submit' }, 'Save');
      const cancel = el('button', { class: 'wt-modal__cancel' }, 'Cancel');

      function attempt() {
        const normalizedUrl = normalizeUrl(urlInput.value);
        if (!normalizedUrl) {
          errBox.textContent = 'That doesn\'t look like a valid web URL.';
          errBox.hidden = false;
          return;
        }
        link.url = normalizedUrl;
        link.title = titleInput.value.trim() || hostnameForUrl(normalizedUrl);

        const targetGroupId = groupSelect.value;
        if (targetGroupId !== sourceGroup.id) {
          const targetGroup = findGroup(targetGroupId);
          if (targetGroup) {
            sourceGroup.links = sourceGroup.links.filter(existing => existing.id !== link.id);
            targetGroup.links = (targetGroup.links || []).concat(link);
          }
        }
        persist('Edit link');
        ctx.closeModal();
        renderGroups();
      }

      submit.addEventListener('click', attempt);
      cancel.addEventListener('click', () => ctx.closeModal());

      ctx.openModal([
        el('h2', {}, 'Edit link'),
        el('div', { class: 'wt-modal__field' },
          el('label', {}, 'Title'),
          titleInput),
        el('div', { class: 'wt-modal__field' },
          el('label', {}, 'URL'),
          urlInput),
        el('div', { class: 'wt-modal__field' },
          el('label', {}, 'Group'),
          groupSelect,
          el('p', { class: 'wt-modal__hint' }, 'Pick a different group to move this link.')),
        errBox,
        el('div', { class: 'wt-modal__actions' }, cancel, submit),
      ]);
    }

    // ---- delete helpers (with confirm) ----
    function deleteGroup(group) {
      const linkCount = group.links?.length || 0;
      const warning = linkCount
        ? `Delete "${group.name}" and its ${linkCount} saved tab(s)? This can't be undone.`
        : `Delete "${group.name}"?`;
      if (!window.confirm(warning)) return;
      dataModel.groups = dataModel.groups.filter(existing => existing.id !== group.id);
      persist(`Delete tab group "${group.name}"`);
      renderGroups();
    }
    function deleteLink(group, link) {
      group.links = group.links.filter(existing => existing.id !== link.id);
      persist('Delete link');
      renderGroups();
    }

    // ---- row + card builders ----

    // Which link (if any) is being renamed inline right now, plus the in-flight
    // drag (source group id + row index). Both held across re-renders.
    let renamingLinkId = null;
    let dragState = null;

    function renderLinkRow(group, link, index) {
      const host = hostnameForUrl(link.url);

      // --- inline rename mode: swap the row for a name input ---
      // No anchor in this branch, so typing/clicking can't navigate. Enter or
      // blur commits, Esc cancels; the `done` guard stops the blur that fires
      // when renderGroups() tears the input down from double-committing.
      if (renamingLinkId === link.id) {
        const nameInput = el('input', {
          class: 'wt-tv-rename-input', type: 'text',
          value: link.title || host, 'aria-label': 'Tab name',
        });
        let done = false;
        function commitRename() {
          if (done) return;
          done = true;
          link.title = nameInput.value.trim() || host;
          renamingLinkId = null;
          persist('Rename tab');
          renderGroups();
        }
        function cancelRename() {
          if (done) return;
          done = true;
          renamingLinkId = null;
          renderGroups();
        }
        nameInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commitRename();
          else if (e.key === 'Escape') cancelRename();
        });
        nameInput.addEventListener('blur', commitRename);
        // Focus + select once the input has landed in the DOM.
        setTimeout(() => { nameInput.focus(); nameInput.select(); }, 0);
        return el('div', { class: 'wt-tv-link wt-tv-link--editing' },
          el('span', { class: 'wt-tv-link__icon', html: ICON_GLOBE }),
          nameInput,
          el('span', { class: 'wt-tv-rename-hint' }, 'Enter ↵ · Esc'),
        );
      }

      // --- normal mode: grip reorders, name/host opens, actions on hover ---
      const grip = el('span', {
        class: 'wt-tv-grip', draggable: 'true',
        title: 'Drag to reorder', 'aria-label': 'Drag to reorder',
        html: ICON_GRIP,
      });
      const openLink = el('a', {
        class: 'wt-tv-link__main',
        href: link.url, target: '_blank', rel: 'noopener noreferrer',
        draggable: 'false',              // grip is the ONLY drag affordance
        title: link.url,
      },
        el('span', { class: 'wt-tv-link__icon', html: ICON_GLOBE }),
        el('span', { class: 'wt-tv-link__text' },
          el('span', { class: 'wt-tv-link__title' }, link.title || host),
          el('span', { class: 'wt-tv-link__host' }, host)),
      );
      const actions = el('div', { class: 'wt-tv-link__actions' },
        el('button', {
          class: 'wt-tv-iconbtn', title: 'Rename', 'aria-label': 'Rename tab',
          html: ICON_EDIT,
          onclick: (e) => { e.preventDefault(); renamingLinkId = link.id; renderGroups(); },
        }),
        el('button', {
          class: 'wt-tv-iconbtn', title: 'Edit URL / move to group', 'aria-label': 'Edit URL or move',
          html: ICON_MORE,
          onclick: (e) => { e.preventDefault(); openEditLinkModal(group, link); },
        }),
        el('button', {
          class: 'wt-tv-iconbtn wt-tv-iconbtn--danger', title: 'Delete', 'aria-label': 'Delete link',
          html: ICON_TRASH,
          onclick: (e) => { e.preventDefault(); deleteLink(group, link); },
        }),
      );
      const rowEl = el('div', { class: 'wt-tv-link' }, grip, openLink, actions);

      // Drag-to-reorder WITHIN this group. Grip = drag source, row = drop
      // target. A before/after slot is picked from the pointer's vertical
      // position so a tab can also be dropped at the very end of the list.
      function clearDragMarkers() {
        for (const marked of groupsContainer.querySelectorAll(
          '.wt-tv-link--dragging, .wt-tv-link--dropbefore, .wt-tv-link--dropafter')) {
          marked.classList.remove('wt-tv-link--dragging', 'wt-tv-link--dropbefore', 'wt-tv-link--dropafter');
        }
      }
      function dropSlotIsAfter(e) {
        const rect = rowEl.getBoundingClientRect();
        return (e.clientY - rect.top) > rect.height / 2;
      }
      grip.addEventListener('dragstart', (e) => {
        dragState = { groupId: group.id, fromIndex: index };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', link.id);   // Firefox won't drag without data
        rowEl.classList.add('wt-tv-link--dragging');
      });
      grip.addEventListener('dragend', () => { dragState = null; clearDragMarkers(); });
      rowEl.addEventListener('dragover', (e) => {
        if (!dragState || dragState.groupId !== group.id) return;   // same-group reorder only
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = dropSlotIsAfter(e);
        rowEl.classList.toggle('wt-tv-link--dropafter', after);
        rowEl.classList.toggle('wt-tv-link--dropbefore', !after);
      });
      rowEl.addEventListener('dragleave', () => {
        rowEl.classList.remove('wt-tv-link--dropbefore', 'wt-tv-link--dropafter');
      });
      rowEl.addEventListener('drop', (e) => {
        if (!dragState || dragState.groupId !== group.id) return;
        e.preventDefault();
        const fromIndex = dragState.fromIndex;
        const linkArray = group.links;
        dragState = null;
        if (fromIndex < 0 || fromIndex >= linkArray.length) { renderGroups(); return; }
        let toIndex = index + (dropSlotIsAfter(e) ? 1 : 0);
        if (fromIndex < toIndex) toIndex -= 1;             // removed item shifts later slots left
        toIndex = Math.max(0, Math.min(toIndex, linkArray.length - 1));
        if (toIndex === fromIndex) { renderGroups(); return; }   // dropped back in place — no write
        const [movedLink] = linkArray.splice(fromIndex, 1);
        linkArray.splice(toIndex, 0, movedLink);
        persist(`Reorder tabs in "${group.name}"`);
        renderGroups();
      });

      return rowEl;
    }

    function renderGroupCard(group) {
      const linkList = group.links || [];
      const isCollapsed = !!group.collapsed;

      const chevron = el('button', {
        class: 'wt-tv-group__chevron' + (isCollapsed ? ' wt-tv-group__chevron--collapsed' : ''),
        title: isCollapsed ? 'Expand' : 'Collapse',
        'aria-label': isCollapsed ? 'Expand group' : 'Collapse group',
        onclick: () => { group.collapsed = !group.collapsed; renderGroups(); },
      }, '▾');

      const header = el('div', { class: 'wt-tv-group__header' },
        chevron,
        el('span', { class: 'wt-tv-dot', style: `background:${hexForColorKey(group.color)}` }),
        el('span', { class: 'wt-tv-group__title' }, group.name || 'Untitled'),
        el('span', { class: 'wt-tv-group__meta' },
          `${linkList.length} ${linkList.length === 1 ? 'tab' : 'tabs'}`),
        el('div', { class: 'wt-tv-group__actions' },
          el('button', {
            class: 'wt-tv-btn wt-tv-btn--ghost',
            disabled: linkList.length === 0,
            title: linkList.length ? 'Open every tab in this group' : 'No tabs to open',
            onclick: () => openAllInGroup(group),
          }, 'Open all'),
          el('button', {
            class: 'wt-tv-btn wt-tv-btn--ghost',
            onclick: () => openAddLinksModal(group),
          }, '+ Add links'),
          el('button', {
            class: 'wt-tv-iconbtn', title: 'Edit group', 'aria-label': 'Edit group',
            html: ICON_EDIT, onclick: () => openGroupModal(group),
          }),
          el('button', {
            class: 'wt-tv-iconbtn wt-tv-iconbtn--danger', title: 'Delete group', 'aria-label': 'Delete group',
            html: ICON_TRASH, onclick: () => deleteGroup(group),
          }),
        ),
      );

      const body = el('div', { class: 'wt-tv-group__body' });
      if (!isCollapsed) {
        if (linkList.length === 0) {
          body.appendChild(el('p', { class: 'wt-tv-empty' },
            'No tabs here yet. Use "+ Add links" to paste some in.'));
        } else {
          for (let linkIndex = 0; linkIndex < linkList.length; linkIndex++) {
            body.appendChild(renderLinkRow(group, linkList[linkIndex], linkIndex));
          }
        }
      }

      return el('div', {
        class: 'wt-tv-group',
        style: `--wt-tv-group-color:${hexForColorKey(group.color)}`,
      }, header, body);
    }

    // ---- top-level (re)render of the groups list ----
    function renderGroups() {
      groupsContainer.innerHTML = '';
      if (dataModel.groups.length === 0) {
        groupsContainer.appendChild(el('div', { class: 'wt-tv-empty wt-tv-empty--big' },
          el('p', {}, 'Your Tab Vault is empty.'),
          el('p', {}, 'Make a group, then paste in the URLs of the tabs you want to park. ' +
            'Close them in Chrome afterward to free the RAM — they\'ll be one click away here.')));
        return;
      }
      for (const group of dataModel.groups) {
        groupsContainer.appendChild(renderGroupCard(group));
      }
    }

    renderGroups();
  },
};
