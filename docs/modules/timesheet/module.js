/**
 * modules/timesheet/module.js
 *
 * Timesheet module for the WorkTrace dashboard.
 *
 * Tile view: shows the user's most recent work-day at a glance — headline +
 * project + count summary. One tile, one user, one day.
 *
 * Detail view: full week-by-week timeline of every entry, with project
 * filtering, day-by-day bullet rendering, and a switcher to view teammates'
 * data (since the private repo is the trust boundary, this is allowed —
 * see worktrace-data/README.md "Privacy model").
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

function dateOnly(iso) { return (iso || '').slice(0, 10); }

// ---- Module export ----

export default {
  id: 'timesheet',
  displayName: 'Timesheet',
  description: 'Daily work log by project',
  schemaVersion: 1,
  stylesheet: 'module.css',

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
   * Detail view: week-by-week timeline of every entry, with a teammate
   * picker so you can view anyone's data.
   */
  async renderDetail(container, ctx) {
    // State for the detail view
    let viewingUserId = ctx.currentUser.user_id;

    async function render() {
      container.innerHTML = '';
      container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'Loading…'));

      let data;
      try {
        data = await ctx.fetchUserData(viewingUserId);
      } catch (err) {
        container.innerHTML = '';
        container.appendChild(el('p', { class: 'wt-error' }, `Error loading data: ${err.message}`));
        return;
      }

      container.innerHTML = '';

      // User picker (only show if there's more than one user)
      if (ctx.allUsers.length > 1) {
        const picker = el('div', { class: 'wt-ts-picker' },
          el('label', { class: 'wt-ts-picker__label' }, 'Viewing as: '),
          el('select', {
              class: 'wt-ts-picker__select',
              onchange: (e) => { viewingUserId = e.target.value; render(); }
            },
            ...ctx.allUsers.map(u =>
              el('option', { value: u.user_id, selected: u.user_id === viewingUserId },
                `${u.display_name}${u.user_id === ctx.currentUser.user_id ? ' (you)' : ''}`)
            )
          )
        );
        container.appendChild(picker);
      }

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
      const entries = [...(data.entries || [])].sort((a, b) =>
        (b.work_date || '').localeCompare(a.work_date || ''));
      if (entries.length === 0) {
        container.appendChild(el('p', { class: 'wt-tile__placeholder' },
          'No entries yet.'));
        return;
      }

      const byDate = new Map();
      for (const e of entries) {
        if (!byDate.has(e.work_date)) byDate.set(e.work_date, []);
        byDate.get(e.work_date).push(e);
      }

      const timeline = el('div', { class: 'wt-ts-timeline' });
      for (const [date, dayEntries] of byDate) {
        const dayBlock = el('div', { class: 'wt-ts-day' },
          el('h3', { class: 'wt-ts-day__date' }, date),
          ...dayEntries.map(e =>
            el('div', { class: 'wt-ts-entry' },
              el('div', { class: 'wt-ts-entry__project' }, projectLabel(e.project)),
              el('div', { class: 'wt-ts-entry__headline' }, e.headline || ''),
              (e.tags || []).length
                ? el('div', { class: 'wt-ts-entry__tags' },
                    ...e.tags.map(t => el('span', { class: 'wt-ts-tag' }, t))
                  )
                : null,
              (e.bullets || []).length
                ? el('details', { class: 'wt-ts-entry__bullets' },
                    el('summary', {}, `Show ${e.bullets.length} bullet${e.bullets.length === 1 ? '' : 's'}`),
                    el('ul', { class: 'wt-ts-bullets' },
                      ...e.bullets.map(b => el('li', { html: bulletToHTML(b) }))
                    )
                  )
                : null
            )
          )
        );
        timeline.appendChild(dayBlock);
      }
      container.appendChild(timeline);
    }

    await render();
  },
};
