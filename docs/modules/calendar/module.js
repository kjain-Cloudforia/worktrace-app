/**
 * modules/calendar/module.js
 *
 * Calendar module for the WorkTrace dashboard — the meetings the timesheet
 * logged, on a calendar.
 *
 * Data: modules/calendar/data.json, written by the laptop-side
 * worktrace-cli `modules/calendar/sync.py` (Google Calendar cross-checked
 * against timesheet.md). Every entry has a `status`:
 *   logged   — in the timesheet (solid block, coloured by project)
 *   pending  — its shift isn't logged yet (dashed outline, suggested project)
 *   excluded — declined / on the user's skip list (greyed out)
 *   missing  — its day is logged but this meeting isn't (greyed out)
 *
 * Tile view: this week's logged meeting time, split by project, plus the
 * latest / next meeting.
 *
 * Detail view: week grid (columns = work days Mon–Sun, rows = the shift's
 * hours) with a Month toggle. Columns are WORK DAYS, not calendar days, so a
 * 23:00–00:00 meeting in a 14:00→05:00 shift stays in one column, lined up
 * with the Timesheet module's day labels.
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
    else if (k === 'style' && typeof v === 'object') {
      // setProperty so CSS custom properties (--wt-cal-color) work too.
      for (const [styleName, styleValue] of Object.entries(v)) {
        if (styleName.startsWith('--')) node.style.setProperty(styleName, styleValue);
        else node.style[styleName] = styleValue;
      }
    }
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

const STATUS_LABEL_MAP = {
  logged: 'Logged',
  pending: 'Not logged yet',
  excluded: 'Left out',
  missing: 'Not in timesheet',
};

// Project colours: fixed, readable on the warm off-white shell background.
// Assigned in order of first appearance (sorted by name) so a project keeps
// its colour across views; "Internal" is always slate.
const PROJECT_COLOR_LIST = ['#c97b3d', '#3d7cc9', '#3a9a6b', '#9b59b6', '#c0487a', '#b8952e', '#2e9fa8'];
const INTERNAL_COLOR = '#6b7a8c';
const NO_PROJECT_COLOR = '#9a968f';

function buildProjectColorMap(entryList) {
  const projectNameList = [...new Set(entryList.map(entry => entry.project).filter(Boolean))]
    .filter(projectName => projectName !== 'Internal')
    .sort();
  const projectNameVsColorMap = { Internal: INTERNAL_COLOR };
  projectNameList.forEach((projectName, projectIndex) => {
    projectNameVsColorMap[projectName] = PROJECT_COLOR_LIST[projectIndex % PROJECT_COLOR_LIST.length];
  });
  return projectNameVsColorMap;
}

// ---- date helpers (work dates are 'YYYY-MM-DD' strings; math in UTC) ----

function addDays(isoDate, dayCount) {
  const dateObj = new Date(isoDate + 'T00:00:00Z');
  dateObj.setUTCDate(dateObj.getUTCDate() + dayCount);
  return dateObj.toISOString().slice(0, 10);
}

function dayDifference(fromIsoDate, toIsoDate) {
  return Math.round((Date.parse(toIsoDate + 'T00:00:00Z') - Date.parse(fromIsoDate + 'T00:00:00Z')) / 86400000);
}

function mondayOf(isoDate) {
  const dayOfWeek = new Date(isoDate + 'T00:00:00Z').getUTCDay();   // 0=Sun
  return addDays(isoDate, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
}

function firstOfMonth(isoDate) { return isoDate.slice(0, 8) + '01'; }

function addMonths(isoDate, monthCount) {
  const dateObj = new Date(firstOfMonth(isoDate) + 'T00:00:00Z');
  dateObj.setUTCMonth(dateObj.getUTCMonth() + monthCount);
  return dateObj.toISOString().slice(0, 10);
}

function formatShortDate(isoDate, optionMap = { month: 'short', day: 'numeric' }) {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-US', { ...optionMap, timeZone: 'UTC' });
}

function parseHourMinute(hourMinuteText) {
  const [hourValue, minuteValue] = String(hourMinuteText || '00:00').split(':').map(Number);
  return hourValue * 60 + minuteValue;
}

function formatMinutes(totalMinutes) {
  const hourCount = Math.floor(totalMinutes / 60);
  const minuteRemainder = totalMinutes % 60;
  if (!hourCount) return `${minuteRemainder}m`;
  return minuteRemainder ? `${hourCount}h ${minuteRemainder}m` : `${hourCount}h`;
}

/**
 * Timezone-aware view of the data: local clock parts for any instant, the
 * work date "now" falls in, and a meeting's minute offset from its shift start.
 */
function buildTimeContext(calendarData) {
  const timezoneName = calendarData.timezone || 'UTC';
  const partsFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezoneName, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const shiftStartMinutes = parseHourMinute(calendarData.work_shift?.start || '00:00');
  const shiftEndMinutes = parseHourMinute(calendarData.work_shift?.end || '23:59');
  const crossesMidnight = shiftEndMinutes < shiftStartMinutes;
  const shiftLengthMinutes = crossesMidnight
    ? 1440 - shiftStartMinutes + shiftEndMinutes
    : shiftEndMinutes - shiftStartMinutes;

  function localPartsOf(instant) {
    const partNameVsValueMap = {};
    for (const part of partsFormatter.formatToParts(instant)) partNameVsValueMap[part.type] = part.value;
    return {
      isoDate: `${partNameVsValueMap.year}-${partNameVsValueMap.month}-${partNameVsValueMap.day}`,
      minuteOfDay: Number(partNameVsValueMap.hour) * 60 + Number(partNameVsValueMap.minute),
    };
  }

  function currentWorkDate() {
    const nowParts = localPartsOf(new Date());
    return (crossesMidnight && nowParts.minuteOfDay < shiftEndMinutes)
      ? addDays(nowParts.isoDate, -1) : nowParts.isoDate;
  }

  /** Minutes between the work day's shift start and this instant (can be <0 or >shift length). */
  function shiftOffsetMinutes(workDate, instantIso) {
    const instantParts = localPartsOf(new Date(instantIso));
    return dayDifference(workDate, instantParts.isoDate) * 1440 + instantParts.minuteOfDay - shiftStartMinutes;
  }

  function formatClock(instantIso) {
    const minuteOfDay = localPartsOf(new Date(instantIso)).minuteOfDay;
    return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
  }

  function clockLabelForOffset(offsetMinutes) {
    const minuteOfDay = ((shiftStartMinutes + offsetMinutes) % 1440 + 1440) % 1440;
    return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
  }

  const timezoneShortLabel = new Intl.DateTimeFormat('en-US', { timeZone: timezoneName, timeZoneName: 'short' })
    .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value || timezoneName;

  return { timezoneName, timezoneShortLabel, shiftLengthMinutes, currentWorkDate, shiftOffsetMinutes, formatClock, clockLabelForOffset };
}

function meetingTooltip(calendarEntry, timeContext) {
  const lineList = [
    calendarEntry.title,
    `${formatShortDate(calendarEntry.work_date, { weekday: 'short', month: 'short', day: 'numeric' })} · ` +
      `${timeContext.formatClock(calendarEntry.start)}–${timeContext.formatClock(calendarEntry.end)} ` +
      `(${formatMinutes(calendarEntry.minutes)})`,
    `Project: ${calendarEntry.project || 'Unassigned'}`,
    `Status: ${STATUS_LABEL_MAP[calendarEntry.status] || calendarEntry.status}` +
      (calendarEntry.reason ? ` — ${calendarEntry.reason}` : ''),
    `${calendarEntry.attendee_count} other attendee(s)` +
      (calendarEntry.attendee_domains?.length ? `: ${calendarEntry.attendee_domains.join(', ')}` : ''),
  ];
  if (calendarEntry.response && calendarEntry.response !== 'accepted') lineList.push(`RSVP: ${calendarEntry.response}`);
  return lineList.join('\n');
}

function statusClassOf(calendarEntry) {
  return `wt-cal-status--${calendarEntry.status}`;
}

function colorOf(calendarEntry, projectNameVsColorMap) {
  return projectNameVsColorMap[calendarEntry.project] || NO_PROJECT_COLOR;
}

/** Logged minutes per project for a set of entries, largest first. */
function loggedMinutesByProject(entryList) {
  const projectNameVsMinutesMap = {};
  for (const calendarEntry of entryList) {
    if (calendarEntry.status !== 'logged') continue;
    const projectName = calendarEntry.project || 'Unassigned';
    projectNameVsMinutesMap[projectName] = (projectNameVsMinutesMap[projectName] || 0) + calendarEntry.minutes;
  }
  return Object.entries(projectNameVsMinutesMap).sort((first, second) => second[1] - first[1]);
}

function renderLoadError(container, errorObject, isTile) {
  container.innerHTML = '';
  container.appendChild(el('p', { class: isTile ? 'wt-tile__placeholder' : 'wt-error' },
    String(errorObject.message).includes('not found')
      ? 'No calendar data pushed yet. Connect your calendar (NEW-TEAMMATE.md → "Log calendar meetings") and run `dpsync`.'
      : `Error loading calendar: ${errorObject.message}`));
}

// ---- Module export ----

export default {
  id: 'calendar',
  displayName: 'Calendar',
  description: 'Meetings logged in your timesheet',
  schemaVersion: 1,
  stylesheet: 'module.css',
  // Same as Timesheet: admins have no personal data repo.
  hideForAdmin: true,

  async init(_shell) {},

  async renderTile(container, ctx) {
    let calendarData;
    try {
      calendarData = await ctx.fetchMyData();
    } catch (err) {
      renderLoadError(container, err, true);
      return;
    }
    container.innerHTML = '';
    const entryList = calendarData.entries || [];
    const timeContext = buildTimeContext(calendarData);
    const projectNameVsColorMap = buildProjectColorMap(entryList);

    const weekMonday = mondayOf(timeContext.currentWorkDate());
    const weekEntryList = entryList.filter(calendarEntry =>
      calendarEntry.work_date >= weekMonday && calendarEntry.work_date <= addDays(weekMonday, 6));
    const projectMinutesList = loggedMinutesByProject(weekEntryList);
    const totalLoggedMinutes = projectMinutesList.reduce((sum, [, minuteCount]) => sum + minuteCount, 0);
    const pendingCount = weekEntryList.filter(calendarEntry => calendarEntry.status === 'pending').length;

    const nowIso = new Date().toISOString();
    const inScopeEntryList = entryList.filter(calendarEntry =>
      calendarEntry.status === 'logged' || calendarEntry.status === 'pending');
    const nextMeeting = inScopeEntryList.find(calendarEntry => calendarEntry.start > nowIso);
    const latestMeeting = [...inScopeEntryList].reverse().find(calendarEntry => calendarEntry.start <= nowIso);
    const highlightMeeting = nextMeeting || latestMeeting;

    container.append(
      el('div', { class: 'wt-cal-tile' },
        el('div', { class: 'wt-cal-tile__total' },
          el('span', { class: 'wt-cal-tile__total-num' }, formatMinutes(totalLoggedMinutes)),
          el('span', { class: 'wt-cal-tile__total-label' }, 'in logged meetings this week')),
        projectMinutesList.length
          ? el('div', { class: 'wt-cal-tile__bar', role: 'img',
              'aria-label': projectMinutesList.map(([projectName, minuteCount]) =>
                `${projectName} ${formatMinutes(minuteCount)}`).join(', ') },
              ...projectMinutesList.map(([projectName, minuteCount]) =>
                el('span', { style: { flexGrow: String(minuteCount), background: projectNameVsColorMap[projectName] || NO_PROJECT_COLOR } })))
          : null,
        projectMinutesList.length
          ? el('ul', { class: 'wt-cal-tile__projects' },
              ...projectMinutesList.map(([projectName, minuteCount]) =>
                el('li', {},
                  el('span', { class: 'wt-cal-swatch', style: { background: projectNameVsColorMap[projectName] || NO_PROJECT_COLOR } }),
                  el('span', { class: 'wt-cal-tile__project-name' }, projectName),
                  el('span', { class: 'wt-cal-tile__project-time' }, formatMinutes(minuteCount)))))
          : el('p', { class: 'wt-tile__placeholder' }, 'No logged meetings yet this week.'),
        highlightMeeting
          ? el('div', { class: 'wt-cal-tile__next' },
              el('span', { class: 'wt-cal-tile__next-label' }, nextMeeting ? 'Next' : 'Latest'),
              ` ${formatShortDate(highlightMeeting.work_date, { weekday: 'short' })} ` +
                `${timeContext.formatClock(highlightMeeting.start)} · ${highlightMeeting.title}`)
          : null,
        el('div', { class: 'wt-cal-tile__hint' },
          pendingCount ? `${pendingCount} not logged yet · ` : '', 'Click to expand →')
      )
    );
  },

  async renderDetail(container, ctx) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'Loading…'));
    let calendarData;
    try {
      calendarData = await ctx.fetchMyData();
    } catch (err) {
      renderLoadError(container, err, false);
      return;
    }
    container.innerHTML = '';

    const entryList = calendarData.entries || [];
    const timeContext = buildTimeContext(calendarData);
    const projectNameVsColorMap = buildProjectColorMap(entryList);
    const todayWorkDate = timeContext.currentWorkDate();

    let viewMode = 'week';
    let weekMonday = mondayOf(todayWorkDate);
    let monthFirstDay = firstOfMonth(todayWorkDate);

    const toolbar = el('div', { class: 'wt-cal-toolbar' });
    const summaryBar = el('div', { class: 'wt-cal-summary' });
    const viewContainer = el('div', { class: 'wt-cal-view' });
    const listContainer = el('div', { class: 'wt-cal-list' });
    container.append(toolbar, summaryBar, viewContainer, listContainer);

    function entriesBetween(firstWorkDate, lastWorkDate) {
      return entryList.filter(calendarEntry =>
        calendarEntry.work_date >= firstWorkDate && calendarEntry.work_date <= lastWorkDate);
    }

    function renderToolbar() {
      const isCurrentPeriod = viewMode === 'week'
        ? weekMonday === mondayOf(todayWorkDate)
        : monthFirstDay === firstOfMonth(todayWorkDate);
      const periodLabel = viewMode === 'week'
        ? `${formatShortDate(weekMonday)} – ${formatShortDate(addDays(weekMonday, 6))}, ${weekMonday.slice(0, 4)}`
        : formatShortDate(monthFirstDay, { month: 'long', year: 'numeric' });
      const stepPeriod = (stepDirection) => {
        if (viewMode === 'week') weekMonday = addDays(weekMonday, 7 * stepDirection);
        else monthFirstDay = addMonths(monthFirstDay, stepDirection);
        renderAll();
      };
      toolbar.innerHTML = '';
      toolbar.append(
        el('div', { class: 'wt-cal-toolbar__nav' },
          el('button', { class: 'wt-cal-btn', title: `Previous ${viewMode}`, 'aria-label': `Previous ${viewMode}`, onclick: () => stepPeriod(-1) }, '‹'),
          el('span', { class: 'wt-cal-toolbar__label' }, periodLabel),
          el('button', { class: 'wt-cal-btn', title: `Next ${viewMode}`, 'aria-label': `Next ${viewMode}`, onclick: () => stepPeriod(1) }, '›'),
          isCurrentPeriod ? null : el('button', {
            class: 'wt-cal-btn wt-cal-btn--text',
            onclick: () => { weekMonday = mondayOf(todayWorkDate); monthFirstDay = firstOfMonth(todayWorkDate); renderAll(); },
          }, 'Today')),
        el('div', { class: 'wt-cal-toggle', role: 'group', 'aria-label': 'Calendar view' },
          ...['week', 'month'].map(modeName => el('button', {
            class: 'wt-cal-toggle__btn' + (viewMode === modeName ? ' is-active' : ''),
            'aria-pressed': viewMode === modeName ? 'true' : 'false',
            onclick: () => { viewMode = modeName; renderAll(); },
          }, modeName === 'week' ? 'Week' : 'Month')))
      );
    }

    function renderSummary(periodEntryList) {
      const projectMinutesList = loggedMinutesByProject(periodEntryList);
      const totalLoggedMinutes = projectMinutesList.reduce((sum, [, minuteCount]) => sum + minuteCount, 0);
      const statusVsCountMap = {};
      for (const calendarEntry of periodEntryList) statusVsCountMap[calendarEntry.status] = (statusVsCountMap[calendarEntry.status] || 0) + 1;
      summaryBar.innerHTML = '';
      summaryBar.append(
        el('span', { class: 'wt-cal-chip wt-cal-chip--total' },
          el('strong', {}, formatMinutes(totalLoggedMinutes)), ` logged · ${statusVsCountMap.logged || 0} meeting${statusVsCountMap.logged === 1 ? '' : 's'}`),
        ...projectMinutesList.map(([projectName, minuteCount]) => el('span', { class: 'wt-cal-chip' },
          el('span', { class: 'wt-cal-swatch', style: { background: projectNameVsColorMap[projectName] || NO_PROJECT_COLOR } }),
          `${projectName} `, el('strong', {}, formatMinutes(minuteCount)))),
        ...['pending', 'missing', 'excluded'].filter(statusName => statusVsCountMap[statusName]).map(statusName =>
          el('span', { class: `wt-cal-chip wt-cal-chip--muted` },
            el('span', { class: `wt-cal-swatch wt-cal-swatch--${statusName}` }),
            `${statusVsCountMap[statusName]} ${STATUS_LABEL_MAP[statusName].toLowerCase()}`))
      );
    }

    function meetingBlock(calendarEntry, extraStyleMap) {
      const projectColor = colorOf(calendarEntry, projectNameVsColorMap);
      return el('div', {
        class: `wt-cal-event ${statusClassOf(calendarEntry)}` + (calendarEntry.minutes < 30 ? ' is-short' : ''),
        style: { '--wt-cal-color': projectColor, ...extraStyleMap },
        title: meetingTooltip(calendarEntry, timeContext),
        tabindex: '0',
      },
        el('div', { class: 'wt-cal-event__title' }, calendarEntry.title),
        el('div', { class: 'wt-cal-event__meta' },
          `${timeContext.formatClock(calendarEntry.start)}–${timeContext.formatClock(calendarEntry.end)}` +
          (calendarEntry.project ? ` · ${calendarEntry.project}` : ''))
      );
    }

    /** Side-by-side lanes for overlapping meetings within one day column. */
    function assignLanes(dayEntryList) {
      const positionedList = dayEntryList.map(calendarEntry => ({
        calendarEntry,
        startOffset: timeContext.shiftOffsetMinutes(calendarEntry.work_date, calendarEntry.start),
        endOffset: timeContext.shiftOffsetMinutes(calendarEntry.work_date, calendarEntry.end),
      })).sort((first, second) => first.startOffset - second.startOffset || second.endOffset - first.endOffset);

      let clusterList = [];
      let currentCluster = null;
      for (const positioned of positionedList) {
        if (!currentCluster || positioned.startOffset >= currentCluster.clusterEnd) {
          currentCluster = { memberList: [], laneEndList: [], clusterEnd: positioned.endOffset };
          clusterList.push(currentCluster);
        }
        let laneIndex = currentCluster.laneEndList.findIndex(laneEnd => laneEnd <= positioned.startOffset);
        if (laneIndex === -1) { laneIndex = currentCluster.laneEndList.length; currentCluster.laneEndList.push(0); }
        currentCluster.laneEndList[laneIndex] = positioned.endOffset;
        currentCluster.clusterEnd = Math.max(currentCluster.clusterEnd, positioned.endOffset);
        positioned.laneIndex = laneIndex;
        currentCluster.memberList.push(positioned);
      }
      for (const cluster of clusterList) {
        for (const positioned of cluster.memberList) positioned.laneCount = cluster.laneEndList.length;
      }
      return positionedList;
    }

    function renderWeek() {
      const weekDateList = Array.from({ length: 7 }, (_, dayIndex) => addDays(weekMonday, dayIndex));
      const weekEntryList = entriesBetween(weekDateList[0], weekDateList[6]);

      // Vertical range: the shift window, stretched to fit any meeting outside it.
      let rangeStartOffset = 0;
      let rangeEndOffset = timeContext.shiftLengthMinutes;
      for (const calendarEntry of weekEntryList) {
        rangeStartOffset = Math.min(rangeStartOffset, timeContext.shiftOffsetMinutes(calendarEntry.work_date, calendarEntry.start));
        rangeEndOffset = Math.max(rangeEndOffset, timeContext.shiftOffsetMinutes(calendarEntry.work_date, calendarEntry.end));
      }
      rangeStartOffset = Math.floor(rangeStartOffset / 60) * 60;
      rangeEndOffset = Math.ceil(rangeEndOffset / 60) * 60;
      const pixelsPerMinute = 1.2;
      const gridHeightPixels = (rangeEndOffset - rangeStartOffset) * pixelsPerMinute;

      const hourLabelColumn = el('div', { class: 'wt-cal-week__hours', style: { height: `${gridHeightPixels}px` } });
      for (let hourOffset = rangeStartOffset; hourOffset < rangeEndOffset; hourOffset += 60) {
        hourLabelColumn.appendChild(el('span', {
          class: 'wt-cal-week__hour-label',
          style: { top: `${(hourOffset - rangeStartOffset) * pixelsPerMinute}px` },
        }, timeContext.clockLabelForOffset(hourOffset)));
      }

      const headerRow = el('div', { class: 'wt-cal-week__head' },
        el('div', { class: 'wt-cal-week__corner' }, timeContext.timezoneShortLabel),
        ...weekDateList.map(workDate => el('div', {
          class: 'wt-cal-week__day-head' + (workDate === todayWorkDate ? ' is-today' : ''),
        },
          el('span', { class: 'wt-cal-week__weekday' }, formatShortDate(workDate, { weekday: 'short' })),
          el('span', { class: 'wt-cal-week__daynum' }, formatShortDate(workDate, { day: 'numeric' })))));

      const dayColumnList = weekDateList.map(workDate => {
        const dayColumn = el('div', {
          class: 'wt-cal-week__day' + (workDate === todayWorkDate ? ' is-today' : ''),
          style: {
            height: `${gridHeightPixels}px`,
            backgroundSize: `100% ${60 * pixelsPerMinute}px`,
            backgroundPositionY: `${(((0 - rangeStartOffset) % 60) + 60) % 60 * pixelsPerMinute}px`,
          },
        });
        const dayEntryList = weekEntryList.filter(calendarEntry => calendarEntry.work_date === workDate);
        for (const positioned of assignLanes(dayEntryList)) {
          const laneWidthPercent = 100 / positioned.laneCount;
          dayColumn.appendChild(meetingBlock(positioned.calendarEntry, {
            top: `${(positioned.startOffset - rangeStartOffset) * pixelsPerMinute}px`,
            height: `${Math.max(18, (positioned.endOffset - positioned.startOffset) * pixelsPerMinute - 2)}px`,
            left: `calc(${positioned.laneIndex * laneWidthPercent}% + 2px)`,
            width: `calc(${laneWidthPercent}% - 4px)`,
          }));
        }
        return dayColumn;
      });

      viewContainer.innerHTML = '';
      viewContainer.appendChild(el('div', { class: 'wt-cal-week-scroll' },
        el('div', { class: 'wt-cal-week' },
          headerRow,
          el('div', { class: 'wt-cal-week__body' }, hourLabelColumn, ...dayColumnList))));
      viewContainer.appendChild(el('p', { class: 'wt-cal-footnote' },
        `Columns are work days (shift ${calendarData.work_shift?.start}→${calendarData.work_shift?.end}); ` +
        'a meeting after midnight stays on the day its shift started, same as the Timesheet.'));
      return weekEntryList;
    }

    function renderMonth() {
      const monthLastDay = addDays(addMonths(monthFirstDay, 1), -1);
      const gridFirstDay = mondayOf(monthFirstDay);
      const gridDayCount = Math.ceil((dayDifference(gridFirstDay, monthLastDay) + 1) / 7) * 7;
      const monthEntryList = entriesBetween(monthFirstDay, monthLastDay);

      const monthGrid = el('div', { class: 'wt-cal-month' },
        ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(weekdayName =>
          el('div', { class: 'wt-cal-month__weekday' }, weekdayName)));
      for (let dayIndex = 0; dayIndex < gridDayCount; dayIndex++) {
        const workDate = addDays(gridFirstDay, dayIndex);
        const isInMonth = workDate >= monthFirstDay && workDate <= monthLastDay;
        const dayEntryList = isInMonth ? monthEntryList.filter(calendarEntry => calendarEntry.work_date === workDate) : [];
        const dayLoggedMinutes = dayEntryList
          .filter(calendarEntry => calendarEntry.status === 'logged')
          .reduce((sum, calendarEntry) => sum + calendarEntry.minutes, 0);
        monthGrid.appendChild(el('div', {
          class: 'wt-cal-month__cell' + (isInMonth ? '' : ' is-outside') + (workDate === todayWorkDate ? ' is-today' : ''),
        },
          el('div', { class: 'wt-cal-month__cell-head' },
            el('span', { class: 'wt-cal-month__daynum' }, String(Number(workDate.slice(8)))),
            dayLoggedMinutes ? el('span', { class: 'wt-cal-month__day-total' }, formatMinutes(dayLoggedMinutes)) : null),
          ...dayEntryList.map(calendarEntry => el('div', {
            class: `wt-cal-month__chip ${statusClassOf(calendarEntry)}`,
            style: { '--wt-cal-color': colorOf(calendarEntry, projectNameVsColorMap) },
            title: meetingTooltip(calendarEntry, timeContext),
            tabindex: '0',
          },
            el('span', { class: 'wt-cal-month__chip-time' }, timeContext.formatClock(calendarEntry.start)),
            ` ${calendarEntry.title}`))));
      }
      viewContainer.innerHTML = '';
      viewContainer.appendChild(monthGrid);
      return monthEntryList;
    }

    /** Plain list under the grid — readable on phones, and shows the "why" for greyed meetings. */
    function renderList(periodEntryList) {
      listContainer.innerHTML = '';
      if (!periodEntryList.length) {
        listContainer.appendChild(el('p', { class: 'wt-tile__placeholder' },
          `No meetings this ${viewMode}` +
          (calendarData.range?.start_date && (viewMode === 'week' ? addDays(weekMonday, 6) : addDays(addMonths(monthFirstDay, 1), -1)) < calendarData.range.start_date
            ? ` — tracking starts ${formatShortDate(calendarData.range.start_date, { month: 'short', day: 'numeric', year: 'numeric' })}.`
            : '.')));
        return;
      }
      const workDateList = [...new Set(periodEntryList.map(calendarEntry => calendarEntry.work_date))].sort().reverse();
      listContainer.appendChild(el('h3', { class: 'wt-cal-list__heading' }, `Meetings this ${viewMode}`));
      for (const workDate of workDateList) {
        listContainer.appendChild(el('div', { class: 'wt-cal-list__day' },
          el('div', { class: 'wt-cal-list__date' },
            formatShortDate(workDate, { weekday: 'short', month: 'short', day: 'numeric' })),
          el('ul', { class: 'wt-cal-list__items' },
            ...periodEntryList.filter(calendarEntry => calendarEntry.work_date === workDate).map(calendarEntry =>
              el('li', { class: `wt-cal-list__item ${statusClassOf(calendarEntry)}`,
                         style: { '--wt-cal-color': colorOf(calendarEntry, projectNameVsColorMap) } },
                el('span', { class: 'wt-cal-list__time' },
                  `${timeContext.formatClock(calendarEntry.start)}–${timeContext.formatClock(calendarEntry.end)}`),
                el('span', { class: 'wt-cal-list__title' }, calendarEntry.title,
                  calendarEntry.response === 'tentative' ? el('span', { class: 'wt-cal-list__note' }, ' (tentative)') : null),
                el('span', { class: 'wt-cal-list__project' },
                  el('span', { class: 'wt-cal-swatch', style: { background: colorOf(calendarEntry, projectNameVsColorMap) } }),
                  calendarEntry.project || 'Unassigned'),
                el('span', { class: `wt-cal-badge wt-cal-badge--${calendarEntry.status}` },
                  STATUS_LABEL_MAP[calendarEntry.status] || calendarEntry.status),
                calendarEntry.reason && calendarEntry.status !== 'logged'
                  ? el('span', { class: 'wt-cal-list__reason' }, calendarEntry.reason) : null)))));
      }
    }

    function renderAll() {
      renderToolbar();
      const periodEntryList = viewMode === 'week' ? renderWeek() : renderMonth();
      renderSummary(periodEntryList);
      renderList(periodEntryList);
    }

    renderAll();
    container.appendChild(el('p', { class: 'wt-cal-footnote' },
      `${entryList.length} meetings tracked since ${calendarData.range?.start_date || '—'} · ` +
      `last synced ${calendarData.last_synced_at?.slice(0, 16).replace('T', ' ') || '—'} UTC`));
  },
};
