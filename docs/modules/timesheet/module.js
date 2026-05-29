/**
 * modules/timesheet/module.js
 *
 * Timesheet module for the WorkTrace dashboard.
 *
 * Tile view: shows the user's most recent work-day at a glance — headline +
 * project + count summary. One tile, one user, one day.
 *
 * Detail view: full timeline of every entry grouped by work-day, newest
 * first. Lightweight markdown (bold + inline code) is rendered inside
 * each bullet via bulletToHTML().
 *
 * In the per-user-repo model (Phase 5a+), each user only sees their own
 * data here — there's no teammate picker on this module. Admins view
 * other users' timesheets via the Admin module's drill-in, which imports
 * this module's renderDetail with a shimmed ctx (the auth fetch points
 * at the target user's data repo).
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

/**
 * Light markdown → HTML pass for bullet text. We only handle `**bold**`,
 * inline `` `code` ``, and preserve newlines. Doesn't attempt full
 * markdown — the bullet text from timesheet.md is already mostly plain.
 */
function bulletToHTML(text) {
  // HTML-escape first to prevent XSS via clever entries.
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // newlines → <br>
  s = s.replace(/\n/g, '<br>');
  return s;
}

function projectLabel(p) {
  if (!p) return '';
  return p.friendly_name ? `${p.company_name} (${p.friendly_name})` : p.company_name;
}

function totalCounts(entries) {
  const sum = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.counts || {})) {
      sum[k] = (sum[k] || 0) + (typeof v === 'number' ? v : 0);
    }
  }
  return sum;
}

// ---- week helpers ----
// Week starts Monday. All date math uses browser-local time — fine for our
// single-user-per-dashboard model where the viewer's tz typically matches
// the timesheet's IST work-day labels.

function startOfWeekMonday(anyDate) {
  const dateCopy = new Date(anyDate);
  const dayOfWeek = dateCopy.getDay();   // 0=Sun, 1=Mon, …, 6=Sat
  const dayShiftToMonday = (dayOfWeek === 0) ? -6 : (1 - dayOfWeek);
  dateCopy.setDate(dateCopy.getDate() + dayShiftToMonday);
  dateCopy.setHours(0, 0, 0, 0);
  return dateCopy;
}

function isWorkDateInWeek(workDateString, weekMondayDate) {
  if (!workDateString) return false;
  // Parse YYYY-MM-DD as a local-midnight date so it lines up with the
  // weekMondayDate (also local-midnight).
  const entryDate = new Date(workDateString + 'T00:00:00');
  const weekEndExclusive = new Date(weekMondayDate);
  weekEndExclusive.setDate(weekEndExclusive.getDate() + 7);
  return entryDate >= weekMondayDate && entryDate < weekEndExclusive;
}

function formatWeekRangeLabel(weekMondayDate) {
  const weekSundayDate = new Date(weekMondayDate);
  weekSundayDate.setDate(weekSundayDate.getDate() + 6);
  const monthDayFormat = { month: 'short', day: 'numeric' };
  const mondayLabel = weekMondayDate.toLocaleDateString('en-US', monthDayFormat);
  const sundayLabel = weekSundayDate.toLocaleDateString('en-US', monthDayFormat);
  return `${mondayLabel} – ${sundayLabel}, ${weekMondayDate.getFullYear()}`;
}

// ---- Module export ----

export default {
  id: 'timesheet',
  displayName: 'Timesheet',
  description: 'Daily work log by project',
  schemaVersion: 1,
  stylesheet: 'module.css',
  // Admins don't have their own personal timesheet (data_repo is null
  // on admin auth records). Admins view team members' timesheets via
  // the Admin module's drill-in instead, which imports this module
  // directly and supplies a custom ctx.
  hideForAdmin: true,

  async init(_shell) {
    // Nothing to preload at init — data is fetched lazily per view.
  },

  /**
   * Tile view: most recent entry's headline + counts roll-up for the
   * latest available week.
   */
  async renderTile(container, ctx) {
    let data;
    try {
      data = await ctx.fetchMyData();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(el('p', { class: 'wt-tile__placeholder' },
        err.message.includes('not found')
          ? 'No timesheet pushed yet. Run `dpsync` on your laptop.'
          : `Error: ${err.message}`));
      return;
    }

    container.innerHTML = '';
    const entries = data.entries || [];
    if (entries.length === 0) {
      container.appendChild(el('p', { class: 'wt-tile__placeholder' },
        'No entries yet — run `dpsync` after logging your first day.'));
      return;
    }

    // Sort newest first, take the latest day's entries (a single day may
    // have multiple entries across projects).
    const sorted = [...entries].sort((a, b) =>
      (b.work_date || '').localeCompare(a.work_date || ''));
    const latestDate = sorted[0].work_date;
    const latestDayEntries = sorted.filter(e => e.work_date === latestDate);

    const allCounts = totalCounts(entries);
    const last7 = sorted.filter(e =>
      new Date(e.work_date) >= new Date(new Date(latestDate).getTime() - 7 * 86400000));

    container.append(
      el('div', { class: 'wt-ts-tile' },
        el('div', { class: 'wt-ts-tile__latest' },
          el('div', { class: 'wt-ts-tile__date' }, latestDate),
          ...latestDayEntries.map(e =>
            el('div', { class: 'wt-ts-tile__entry' },
              el('div', { class: 'wt-ts-tile__project' }, projectLabel(e.project)),
              el('div', { class: 'wt-ts-tile__headline' }, e.headline || '(no headline)')
            )
          )
        ),
        el('div', { class: 'wt-ts-tile__stats' },
          el('div', { class: 'wt-ts-tile__stat' },
            el('span', { class: 'wt-ts-tile__stat-num' }, String(allCounts.bullets || 0)),
            el('span', { class: 'wt-ts-tile__stat-label' }, 'total bullets')
          ),
          el('div', { class: 'wt-ts-tile__stat' },
            el('span', { class: 'wt-ts-tile__stat-num' }, String(allCounts.deploys || 0)),
            el('span', { class: 'wt-ts-tile__stat-label' }, 'deploys')
          ),
          el('div', { class: 'wt-ts-tile__stat' },
            el('span', { class: 'wt-ts-tile__stat-num' }, String(last7.length)),
            el('span', { class: 'wt-ts-tile__stat-label' }, 'entries · last 7d')
          )
        ),
        el('div', { class: 'wt-ts-tile__hint' }, 'Click to expand →')
      )
    );
  },

  /**
   * Detail view: week-by-week timeline of every entry.
   *
   * In the per-user-repo model (Phase 5a+), each user only sees their own
   * data here — there's no teammate picker. Admins view other users via
   * the dedicated admin module (Phase 5d).
   */
  async renderDetail(container, ctx) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'Loading…'));

    let data;
    try {
      data = await ctx.fetchMyData();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(el('p', { class: 'wt-error' }, `Error loading data: ${err.message}`));
      return;
    }

    container.innerHTML = '';

    // Summary banner
    const counts = totalCounts(data.entries || []);
    const summary = el('div', { class: 'wt-ts-summary' },
      el('div', { class: 'wt-ts-summary__user' },
        el('div', { class: 'wt-ts-summary__name' }, data.display_name || data.user_id),
        el('div', { class: 'wt-ts-summary__meta' },
          `${(data.entries || []).length} entries · ` +
          `last synced ${data.last_synced_at?.slice(0, 16).replace('T', ' ') || '—'} UTC`)
      ),
      el('div', { class: 'wt-ts-summary__counts' },
        ...['bullets', 'deploys', 'creates', 'modifications', 'investigations', 'fixes', 'users_provisioned']
          .filter(k => counts[k] > 0)
          .map(k => el('span', { class: 'wt-ts-summary__chip' },
            el('strong', {}, String(counts[k])),
            ' ',
            k.replace(/_/g, ' '))
          )
      )
    );
    container.appendChild(summary);

    // Entries — newest first, grouped by date
    const sortedEntryList = [...(data.entries || [])].sort((a, b) =>
      (b.work_date || '').localeCompare(a.work_date || ''));
    if (sortedEntryList.length === 0) {
      container.appendChild(el('p', { class: 'wt-tile__placeholder' },
        'No entries yet.'));
      return;
    }

    // Week navigation state — default to the current week (Monday today).
    // Re-rendered in place by renderForSelectedWeek() on prev/next/today click.
    const currentWeekMonday = startOfWeekMonday(new Date());
    let selectedWeekMonday = new Date(currentWeekMonday);

    const weekNavHeader = el('div', { class: 'wt-ts-week-nav' });
    const timelineContainer = el('div', { class: 'wt-ts-timeline-container' });
    container.appendChild(weekNavHeader);
    container.appendChild(timelineContainer);

    function renderEntryNode(entry) {
      // No-work weekday: a clean muted row, no empty project label / bullets.
      if (entry.no_work) {
        return el('div', { class: 'wt-ts-entry wt-ts-entry--no-work' },
          el('div', { class: 'wt-ts-entry__no-work' }, 'No work done.')
        );
      }
      return el('div', { class: 'wt-ts-entry' },
        el('div', { class: 'wt-ts-entry__project' }, projectLabel(entry.project)),
        entry.headline
          ? el('ul', { class: 'wt-ts-entry__headline-list' },
              ...entry.headline
                .split(/\s*·\s*/)
                .map(headlineSegment => headlineSegment.trim())
                .filter(headlineSegment => headlineSegment.length > 0)
                .map(headlineSegment => el('li', {}, headlineSegment))
            )
          : null,
        (entry.tags || []).length
          ? el('div', { class: 'wt-ts-entry__tags' },
              ...entry.tags.map(tagText => el('span', { class: 'wt-ts-tag' }, tagText))
            )
          : null,
        (entry.bullets || []).length
          ? el('details', { class: 'wt-ts-entry__bullets' },
              el('summary', {}, `Show ${entry.bullets.length} bullet${entry.bullets.length === 1 ? '' : 's'}`),
              el('ul', { class: 'wt-ts-bullets' },
                ...entry.bullets.map(bulletText => el('li', { html: bulletToHTML(bulletText) }))
              )
            )
          : null
      );
    }

    function renderForSelectedWeek() {
      const isViewingCurrentWeek = selectedWeekMonday.getTime() === currentWeekMonday.getTime();

      // ---- Week-nav header ----
      weekNavHeader.innerHTML = '';
      const prevWeekButton = el('button', {
        class: 'wt-ts-week-nav__btn',
        title: 'Previous week',
        onclick: () => {
          selectedWeekMonday = new Date(selectedWeekMonday);
          selectedWeekMonday.setDate(selectedWeekMonday.getDate() - 7);
          renderForSelectedWeek();
        }
      }, '‹');
      const weekRangeLabel = el('span', { class: 'wt-ts-week-nav__label' },
        formatWeekRangeLabel(selectedWeekMonday));
      const nextWeekButton = el('button', {
        class: 'wt-ts-week-nav__btn',
        title: 'Next week',
        disabled: isViewingCurrentWeek,
        onclick: () => {
          if (isViewingCurrentWeek) return;  // safety — button is also disabled
          selectedWeekMonday = new Date(selectedWeekMonday);
          selectedWeekMonday.setDate(selectedWeekMonday.getDate() + 7);
          renderForSelectedWeek();
        }
      }, '›');
      weekNavHeader.append(prevWeekButton, weekRangeLabel, nextWeekButton);
      // "Today" link only shows when not on the current week. Native
      // Element.append() stringifies null to the text "null", so we have
      // to gate the append rather than passing a possibly-null arg.
      if (!isViewingCurrentWeek) {
        const todayLink = el('button', {
          class: 'wt-ts-week-nav__today',
          onclick: () => {
            selectedWeekMonday = new Date(currentWeekMonday);
            renderForSelectedWeek();
          }
        }, 'Today');
        weekNavHeader.append(todayLink);
      }

      // ---- Timeline body for the selected week ----
      timelineContainer.innerHTML = '';
      const entriesInSelectedWeek = sortedEntryList.filter(entry =>
        isWorkDateInWeek(entry.work_date, selectedWeekMonday));

      if (entriesInSelectedWeek.length === 0) {
        timelineContainer.appendChild(el('p', { class: 'wt-tile__placeholder' },
          'No entries this week.'));
        return;
      }

      const entriesByWorkDate = new Map();
      for (const entry of entriesInSelectedWeek) {
        if (!entriesByWorkDate.has(entry.work_date)) entriesByWorkDate.set(entry.work_date, []);
        entriesByWorkDate.get(entry.work_date).push(entry);
      }

      const timelineRoot = el('div', { class: 'wt-ts-timeline' });
      for (const [workDate, dayEntryList] of entriesByWorkDate) {
        const dayBlock = el('div', { class: 'wt-ts-day' },
          el('h3', { class: 'wt-ts-day__date' }, workDate),
          ...dayEntryList.map(renderEntryNode)
        );
        timelineRoot.appendChild(dayBlock);
      }
      timelineContainer.appendChild(timelineRoot);
    }

    renderForSelectedWeek();
  },
};
