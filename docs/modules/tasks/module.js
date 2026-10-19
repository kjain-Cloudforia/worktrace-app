/**
 * modules/tasks/module.js
 *
 * Task Board module for the WorkTrace dashboard — a small Jira-style board.
 *
 * One board per project (seeded from config.json projects by the laptop-side
 * `scripts/wt_tasks.py seed`, plus any board made by hand here). Each board
 * has its own customisable status columns; tasks are cards you drag between
 * columns. A task carries a Jira-like key (e.g. GEN-12) so it can be named
 * in a chat with Claude ("move GEN-12 to Done").
 *
 * Browser-editable like Tab Vault: state lives at modules/tasks/data.json in
 * the user's private data repo. Unlike Tab Vault there is a SECOND writer —
 * Claude, via scripts/wt_tasks.py on the laptop (GitHub contents API). So
 * every save re-reads the file fresh and re-applies the edit on top of it
 * (see persist()), instead of overwriting with the in-memory copy. Every
 * mutation is therefore an id-based function that can run twice: once on
 * the local model (instant UI) and once on the fresh remote copy (the save).
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

const ICON_GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

const SELECTED_BOARD_STORAGE_KEY = 'wt-tasks:selected-board';

// ---- id + key helpers ----

function makeId(prefix) {
  const randomChunk = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${randomChunk}`;
}

// Board key = the prefix of its task keys (GEN-12). Multi-word names use
// initials ("Mountain West" → MW), single words their first 3 letters
// ("Genserve" → GEN). A clash gets a numeric suffix.
function suggestBoardKey(boardName, takenKeySet) {
  const wordList = (boardName || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let baseKey = wordList.length > 1
    ? wordList.map(word => word[0]).join('').slice(0, 5)
    : (wordList[0] || 'TASK').slice(0, 3);
  if (!/^[A-Z]/.test(baseKey)) baseKey = 'T' + baseKey;
  if (baseKey.length < 2) baseKey = (baseKey + 'X').slice(0, 2);
  let candidateKey = baseKey;
  let suffixNumber = 2;
  while (takenKeySet.has(candidateKey)) candidateKey = `${baseKey}${suffixNumber++}`;
  return candidateKey;
}

function defaultColumnList() {
  return [
    { id: 'col_todo', name: 'To Do' },
    { id: 'col_inprogress', name: 'In Progress' },
    { id: 'col_blocked', name: 'Blocked' },
    { id: 'col_done', name: 'Done', is_done: true },
  ];
}

function nowIso() { return new Date().toISOString(); }

function formatShortDate(isoString) {
  if (!isoString) return '';
  const parsedDate = new Date(isoString);
  if (Number.isNaN(parsedDate.getTime())) return '';
  return parsedDate.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---- model helpers ----

function emptyModel(currentUser) {
  return {
    schema_version: 1,
    user_id: currentUser?.username || 'unknown',
    display_name: currentUser?.display_name || '',
    updated_at: nowIso(),
    boards: [],
  };
}

function normalizeModel(dataModel) {
  if (!Array.isArray(dataModel.boards)) dataModel.boards = [];
  for (const board of dataModel.boards) {
    if (!Array.isArray(board.columns) || board.columns.length === 0) board.columns = defaultColumnList();
    if (!Array.isArray(board.tasks)) board.tasks = [];
    if (!Number.isInteger(board.next_task_number)) board.next_task_number = board.tasks.length + 1;
  }
  return dataModel;
}

function findBoard(dataModel, boardId) {
  return dataModel.boards.find(board => board.id === boardId) || null;
}

function findTask(board, taskId) {
  return board?.tasks.find(task => task.id === taskId) || null;
}

function doneColumnIdSet(board) {
  return new Set(board.columns.filter(column => column.is_done).map(column => column.id));
}

function openTaskCount(board) {
  const doneIdSet = doneColumnIdSet(board);
  return board.tasks.filter(task => !doneIdSet.has(task.column_id)).length;
}

// ---- mutations (id-based; each may run twice — local, then on the fresh copy) ----

const mutations = {
  addBoard({ boardId, boardName, boardKey }) {
    return (dataModel) => {
      if (findBoard(dataModel, boardId)) return;
      const takenKeySet = new Set(dataModel.boards.map(board => board.key));
      dataModel.boards.push({
        id: boardId,
        name: boardName,
        key: takenKeySet.has(boardKey) ? suggestBoardKey(boardName, takenKeySet) : boardKey,
        project: null,
        source: 'manual',
        archived: false,
        created_at: nowIso(),
        columns: defaultColumnList(),
        next_task_number: 1,
        tasks: [],
      });
    };
  },

  updateBoard(boardId, { boardName, archived, columnList }) {
    return (dataModel) => {
      const board = findBoard(dataModel, boardId);
      if (!board) return;
      if (boardName !== undefined) board.name = boardName;
      if (archived !== undefined) board.archived = archived;
      if (columnList) {
        // Tasks sitting in a removed column fall back to the first column.
        const keptColumnIdSet = new Set(columnList.map(column => column.id));
        const fallbackColumnId = columnList[0].id;
        board.columns = columnList.map(column => ({ ...column }));
        const doneIdSet = doneColumnIdSet(board);
        for (const task of board.tasks) {
          if (!keptColumnIdSet.has(task.column_id)) task.column_id = fallbackColumnId;
          if (doneIdSet.has(task.column_id) && !task.completed_at) task.completed_at = nowIso();
          if (!doneIdSet.has(task.column_id)) delete task.completed_at;
        }
      }
    };
  },

  deleteBoard(boardId) {
    return (dataModel) => {
      dataModel.boards = dataModel.boards.filter(board => board.id !== boardId);
    };
  },

  addTask(boardId, { taskId, title, description, columnId }) {
    return (dataModel) => {
      const board = findBoard(dataModel, boardId);
      if (!board || findTask(board, taskId)) return;
      const timestamp = nowIso();
      const newTask = {
        id: taskId,
        key: `${board.key}-${board.next_task_number}`,
        title,
        description: description || '',
        column_id: board.columns.some(column => column.id === columnId) ? columnId : board.columns[0].id,
        created_at: timestamp,
        updated_at: timestamp,
        created_by: 'dashboard',
      };
      if (doneColumnIdSet(board).has(newTask.column_id)) newTask.completed_at = timestamp;
      board.next_task_number += 1;
      board.tasks.push(newTask);
    };
  },

  updateTask(boardId, taskId, { title, description }) {
    return (dataModel) => {
      const task = findTask(findBoard(dataModel, boardId), taskId);
      if (!task) return;
      if (title !== undefined) task.title = title;
      if (description !== undefined) task.description = description;
      task.updated_at = nowIso();
    };
  },

  // Move within / across columns. `beforeTaskId` null = end of the column.
  moveTask(boardId, taskId, targetColumnId, beforeTaskId) {
    return (dataModel) => {
      const board = findBoard(dataModel, boardId);
      const task = findTask(board, taskId);
      if (!task || !board.columns.some(column => column.id === targetColumnId)) return;
      board.tasks = board.tasks.filter(existingTask => existingTask.id !== taskId);
      const wasDone = doneColumnIdSet(board).has(task.column_id);
      task.column_id = targetColumnId;
      const isDone = doneColumnIdSet(board).has(targetColumnId);
      if (isDone && !wasDone) task.completed_at = nowIso();
      if (!isDone) delete task.completed_at;
      task.updated_at = nowIso();
      const beforeIndex = beforeTaskId
        ? board.tasks.findIndex(existingTask => existingTask.id === beforeTaskId) : -1;
      if (beforeIndex === -1) board.tasks.push(task);
      else board.tasks.splice(beforeIndex, 0, task);
    };
  },

  // Cross-board move: the task gets a fresh key from the target board.
  moveTaskToBoard(sourceBoardId, taskId, targetBoardId) {
    return (dataModel) => {
      const sourceBoard = findBoard(dataModel, sourceBoardId);
      const targetBoard = findBoard(dataModel, targetBoardId);
      const task = findTask(sourceBoard, taskId);
      if (!task || !targetBoard || sourceBoard === targetBoard) return;
      sourceBoard.tasks = sourceBoard.tasks.filter(existingTask => existingTask.id !== taskId);
      const sourceColumnName = sourceBoard.columns.find(column => column.id === task.column_id)?.name;
      const matchingColumn = targetBoard.columns.find(column => column.name === sourceColumnName)
        || targetBoard.columns[0];
      task.column_id = matchingColumn.id;
      if (matchingColumn.is_done) task.completed_at = task.completed_at || nowIso();
      else delete task.completed_at;
      task.key = `${targetBoard.key}-${targetBoard.next_task_number}`;
      targetBoard.next_task_number += 1;
      task.updated_at = nowIso();
      targetBoard.tasks.push(task);
    };
  },

  deleteTask(boardId, taskId) {
    return (dataModel) => {
      const board = findBoard(dataModel, boardId);
      if (board) board.tasks = board.tasks.filter(task => task.id !== taskId);
    };
  },
};

// ---- Module export ----

export default {
  id: 'tasks',
  displayName: 'Task Board',
  description: 'Project boards · drag tasks across statuses',
  schemaVersion: 1,
  stylesheet: 'module.css',
  hideForAdmin: true,

  async init(_shell) {},

  /** Tile: open-task total, board count, and per-board open-count chips. */
  async renderTile(container, ctx) {
    container.innerHTML = '';
    let dataModel;
    try {
      dataModel = normalizeModel(await ctx.fetchMyData());
    } catch (err) {
      container.appendChild(el('p', { class: 'wt-tile__placeholder' },
        err.code === 'NOT_FOUND' ? 'No boards yet — click to create one →' : `Error: ${err.message}`));
      return;
    }
    const activeBoardList = dataModel.boards.filter(board => !board.archived);
    if (activeBoardList.length === 0) {
      container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'No boards yet — click to create one →'));
      return;
    }
    const totalOpenCount = activeBoardList.reduce((runningTotal, board) => runningTotal + openTaskCount(board), 0);
    const chipList = activeBoardList.map(board =>
      el('span', { class: 'wt-tb-chip' },
        board.name,
        el('span', { class: 'wt-tb-chip__count' }, String(openTaskCount(board)))));

    container.append(
      el('div', { class: 'wt-tb-tile' },
        el('div', { class: 'wt-tb-tile__stats' },
          el('div', { class: 'wt-tb-tile__stat' },
            el('span', { class: 'wt-tb-tile__stat-num' }, String(totalOpenCount)),
            el('span', { class: 'wt-tb-tile__stat-label' }, totalOpenCount === 1 ? 'open task' : 'open tasks')),
          el('div', { class: 'wt-tb-tile__stat' },
            el('span', { class: 'wt-tb-tile__stat-num' }, String(activeBoardList.length)),
            el('span', { class: 'wt-tb-tile__stat-label' }, activeBoardList.length === 1 ? 'board' : 'boards'))),
        el('div', { class: 'wt-tb-tile__chips' }, ...chipList),
        el('div', { class: 'wt-tb-tile__hint' }, 'Click to open boards →')));
  },

  /** Detail: board tabs, columns of draggable cards, task + board editors. */
  async renderDetail(container, ctx) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'wt-tile__placeholder' }, 'Loading…'));

    let dataModel;
    try {
      dataModel = normalizeModel(await ctx.fetchMyData({ fresh: true }));
    } catch (err) {
      if (err.code !== 'NOT_FOUND') {
        container.innerHTML = '';
        container.appendChild(el('p', { class: 'wt-error' }, `Error loading data: ${err.message}`));
        return;
      }
      dataModel = emptyModel(ctx.currentUser);
    }
    container.innerHTML = '';

    // ---- save plumbing ----
    // Each persist() applies the mutation locally (instant UI), then — queued
    // behind earlier saves — re-reads the file fresh, applies the SAME
    // mutation to that copy and saves it. Claude's edits made in between are
    // kept. The saved copy then becomes the local model (it may carry
    // tasks Claude added, or a task key renumbered by a concurrent add).
    const saveStatusEl = el('span', { class: 'wt-tb-savestatus' }, '');
    function setSaveStatus(state, detail) {
      saveStatusEl.className = `wt-tb-savestatus wt-tb-savestatus--${state}`;
      if (state === 'saving') saveStatusEl.textContent = 'Saving…';
      else if (state === 'saved') saveStatusEl.textContent = 'Saved ✓';
      else if (state === 'error') saveStatusEl.textContent = `Save failed — ${detail?.message || 'retry'}`;
      else saveStatusEl.textContent = '';
    }
    let savePromiseChain = Promise.resolve();
    let pendingSaveCount = 0;
    function persist(mutationFn, commitMessage) {
      mutationFn(dataModel);
      renderAll();
      setSaveStatus('saving');
      pendingSaveCount += 1;
      savePromiseChain = savePromiseChain
        .then(async () => {
          let freshModel;
          try {
            freshModel = normalizeModel(await ctx.fetchMyData({ fresh: true }));
          } catch (err) {
            if (err.code !== 'NOT_FOUND') throw err;
            freshModel = emptyModel(ctx.currentUser);
          }
          mutationFn(freshModel);
          freshModel.updated_at = nowIso();
          await ctx.saveMyData(freshModel, commitMessage);
          pendingSaveCount -= 1;
          setSaveStatus('saved');
          // Adopt the saved copy once the queue is idle (an earlier copy
          // would undo later local edits still waiting to save).
          if (pendingSaveCount === 0
              && JSON.stringify(freshModel.boards) !== JSON.stringify(dataModel.boards)) {
            dataModel = freshModel;
            if (!isUserTyping()) renderAll();
          }
        })
        .catch((err) => {
          pendingSaveCount = Math.max(0, pendingSaveCount - 1);
          console.error('Task Board save failed:', err);
          setSaveStatus('error', err);
        });
      return savePromiseChain;
    }

    function isUserTyping() {
      const activeElement = document.activeElement;
      return !!activeElement && container.contains(activeElement)
        && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
    }

    // ---- selected board (remembered per browser; survives a missing store) ----
    let selectedBoardId = null;
    try { selectedBoardId = localStorage.getItem(SELECTED_BOARD_STORAGE_KEY); } catch { /* private mode */ }
    let showArchived = false;
    function selectBoard(boardId) {
      selectedBoardId = boardId;
      try { localStorage.setItem(SELECTED_BOARD_STORAGE_KEY, boardId); } catch { /* ignore */ }
      renderAll();
    }
    function currentBoard() {
      const visibleBoardList = dataModel.boards.filter(board => showArchived || !board.archived);
      return visibleBoardList.find(board => board.id === selectedBoardId) || visibleBoardList[0] || null;
    }

    // ---- skeleton ----
    const tabsEl = el('div', { class: 'wt-tb-tabs' });
    const toolbar = el('div', { class: 'wt-tb-toolbar' },
      tabsEl,
      el('div', { class: 'wt-tb-toolbar__right' },
        saveStatusEl,
        el('button', { class: 'wt-tb-btn wt-tb-btn--primary', onclick: () => openNewBoardModal() }, '+ New board')));
    const boardHeaderEl = el('div', { class: 'wt-tb-boardhead' });
    const columnsEl = el('div', { class: 'wt-tb-columns' });
    container.append(toolbar, boardHeaderEl, columnsEl);

    // ---- in-flight UI state held across re-renders ----
    let composerColumnId = null;      // column whose "add task" box is open
    let draggedTaskId = null;

    // ---- modals ----
    function openNewBoardModal() {
      const takenKeySet = new Set(dataModel.boards.map(board => board.key));
      const nameInput = el('input', { type: 'text', autocomplete: 'off', class: 'wt-tb-prose', placeholder: 'e.g. Genserve, Internal, Learning' });
      const keyInput = el('input', { type: 'text', autocomplete: 'off', maxlength: '6', class: 'wt-tb-keyinput' });
      let keyEditedByHand = false;
      nameInput.addEventListener('input', () => {
        if (!keyEditedByHand) keyInput.value = nameInput.value.trim() ? suggestBoardKey(nameInput.value, takenKeySet) : '';
      });
      keyInput.addEventListener('input', () => {
        keyEditedByHand = true;
        keyInput.value = keyInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      });
      const errBox = el('p', { class: 'wt-modal__error', hidden: true });
      const submit = el('button', { class: 'wt-modal__submit' }, 'Create board');
      const cancel = el('button', { class: 'wt-modal__cancel' }, 'Cancel');
      function attempt() {
        const boardName = nameInput.value.trim();
        const boardKey = keyInput.value.trim() || suggestBoardKey(boardName, takenKeySet);
        if (!boardName) { errBox.textContent = 'Give the board a name.'; errBox.hidden = false; return; }
        if (!/^[A-Z][A-Z0-9]{1,5}$/.test(boardKey)) {
          errBox.textContent = 'Key must be 2–6 letters/digits, starting with a letter.'; errBox.hidden = false; return;
        }
        if (takenKeySet.has(boardKey)) { errBox.textContent = `Key ${boardKey} is already used.`; errBox.hidden = false; return; }
        const boardId = makeId('brd');
        ctx.closeModal();
        selectedBoardId = boardId;
        try { localStorage.setItem(SELECTED_BOARD_STORAGE_KEY, boardId); } catch { /* ignore */ }
        persist(mutations.addBoard({ boardId, boardName, boardKey }), `Add board "${boardName}"`);
      }
      submit.addEventListener('click', attempt);
      cancel.addEventListener('click', () => ctx.closeModal());
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
      ctx.openModal([
        el('h2', {}, 'New board'),
        el('div', { class: 'wt-modal__field' }, el('label', {}, 'Board name'), nameInput),
        el('div', { class: 'wt-modal__field' }, el('label', {}, 'Key'), keyInput,
          el('p', { class: 'wt-modal__hint' }, 'Prefix for task keys, e.g. GEN → GEN-1, GEN-2. Can\'t be changed later.')),
        el('p', { class: 'wt-modal__hint' }, 'Starts with To Do / In Progress / Blocked / Done — edit columns any time in board settings.'),
        errBox,
        el('div', { class: 'wt-modal__actions' }, cancel, submit),
      ]);
    }

    function openBoardSettingsModal(board) {
      // Work on a draft copy of the columns; nothing changes until Save.
      const draftColumnList = board.columns.map(column => ({ ...column }));
      const nameInput = el('input', { type: 'text', autocomplete: 'off', class: 'wt-tb-prose', value: board.name });
      const archivedCheckbox = el('input', { type: 'checkbox', checked: !!board.archived });
      const columnRowsEl = el('div', { class: 'wt-tb-coleditor' });
      const errBox = el('p', { class: 'wt-modal__error', hidden: true });

      function taskCountInColumn(columnId) {
        return board.tasks.filter(task => task.column_id === columnId).length;
      }
      function renderColumnRows() {
        columnRowsEl.innerHTML = '';
        draftColumnList.forEach((draftColumn, columnIndex) => {
          const columnNameInput = el('input', { type: 'text', value: draftColumn.name, 'aria-label': 'Column name' });
          columnNameInput.addEventListener('input', () => { draftColumn.name = columnNameInput.value; });
          const doneCheckbox = el('input', { type: 'checkbox', checked: !!draftColumn.is_done });
          doneCheckbox.addEventListener('change', () => { draftColumn.is_done = doneCheckbox.checked; });
          const existingTaskCount = taskCountInColumn(draftColumn.id);
          columnRowsEl.appendChild(el('div', { class: 'wt-tb-coleditor__row' },
            columnNameInput,
            el('label', { class: 'wt-tb-coleditor__done', title: 'Tasks here count as finished' }, doneCheckbox, 'Done'),
            el('span', { class: 'wt-tb-coleditor__count' }, existingTaskCount ? `${existingTaskCount}` : ''),
            el('button', {
              type: 'button', class: 'wt-tb-iconbtn', title: 'Move left', disabled: columnIndex === 0,
              onclick: () => { draftColumnList.splice(columnIndex - 1, 0, draftColumnList.splice(columnIndex, 1)[0]); renderColumnRows(); },
            }, '↑'),
            el('button', {
              type: 'button', class: 'wt-tb-iconbtn', title: 'Move right', disabled: columnIndex === draftColumnList.length - 1,
              onclick: () => { draftColumnList.splice(columnIndex + 1, 0, draftColumnList.splice(columnIndex, 1)[0]); renderColumnRows(); },
            }, '↓'),
            el('button', {
              type: 'button', class: 'wt-tb-iconbtn wt-tb-iconbtn--danger', title: 'Remove column',
              disabled: draftColumnList.length === 1, html: ICON_TRASH,
              onclick: () => { draftColumnList.splice(columnIndex, 1); renderColumnRows(); },
            })));
        });
      }
      renderColumnRows();

      const addColumnButton = el('button', {
        type: 'button', class: 'wt-tb-btn wt-tb-btn--ghost',
        onclick: () => { draftColumnList.push({ id: makeId('col'), name: 'New column' }); renderColumnRows(); },
      }, '+ Add column');

      const deleteBoardButton = el('button', {
        type: 'button', class: 'wt-tb-btn wt-tb-btn--danger',
        onclick: () => {
          const warning = board.tasks.length
            ? `Delete "${board.name}" and its ${board.tasks.length} task(s)? This can't be undone. (Archive keeps them.)`
            : `Delete "${board.name}"?`;
          if (!window.confirm(warning)) return;
          ctx.closeModal();
          persist(mutations.deleteBoard(board.id), `Delete board "${board.name}"`);
        },
      }, 'Delete board');

      const submit = el('button', { class: 'wt-modal__submit' }, 'Save');
      const cancel = el('button', { class: 'wt-modal__cancel' }, 'Cancel');
      submit.addEventListener('click', () => {
        const boardName = nameInput.value.trim();
        if (!boardName) { errBox.textContent = 'Board name can\'t be empty.'; errBox.hidden = false; return; }
        if (draftColumnList.some(draftColumn => !draftColumn.name.trim())) {
          errBox.textContent = 'Every column needs a name.'; errBox.hidden = false; return;
        }
        const keptColumnIdSet = new Set(draftColumnList.map(draftColumn => draftColumn.id));
        const orphanedTaskCount = board.tasks.filter(task => !keptColumnIdSet.has(task.column_id)).length;
        if (orphanedTaskCount && !window.confirm(
          `${orphanedTaskCount} task(s) sit in removed columns — they'll move to "${draftColumnList[0].name.trim()}". Continue?`)) return;
        const columnList = draftColumnList.map(draftColumn => {
          const savedColumn = { id: draftColumn.id, name: draftColumn.name.trim() };
          if (draftColumn.is_done) savedColumn.is_done = true;
          return savedColumn;
        });
        ctx.closeModal();
        persist(mutations.updateBoard(board.id, { boardName, archived: archivedCheckbox.checked, columnList }),
          `Update board "${boardName}"`);
      });
      cancel.addEventListener('click', () => ctx.closeModal());

      ctx.openModal([
        el('h2', {}, `Board settings · ${board.key}`),
        el('div', { class: 'wt-modal__field' }, el('label', {}, 'Board name'), nameInput),
        el('div', { class: 'wt-modal__field' },
          el('label', {}, 'Columns (left → right)'),
          columnRowsEl,
          addColumnButton,
          el('p', { class: 'wt-modal__hint' }, 'Tick "Done" on columns whose tasks count as finished (hidden from open-task counts).')),
        el('label', { class: 'wt-tb-checkline' }, archivedCheckbox, 'Archive this board (hide it from the tabs)'),
        errBox,
        el('div', { class: 'wt-modal__actions wt-tb-modal-actions' }, deleteBoardButton, el('span', { class: 'wt-tb-spacer' }), cancel, submit),
      ]);
    }

    function openTaskModal(board, task) {
      const titleInput = el('input', { type: 'text', autocomplete: 'off', class: 'wt-tb-prose', value: task.title });
      const descriptionTextarea = el('textarea', { class: 'wt-tb-textarea', rows: '8', placeholder: 'Details, links, notes…' });
      descriptionTextarea.value = task.description || '';
      const columnSelect = el('select', { class: 'wt-tb-select' },
        ...board.columns.map(column => el('option', { value: column.id, selected: column.id === task.column_id }, column.name)));
      const boardSelect = el('select', { class: 'wt-tb-select' },
        ...dataModel.boards.map(otherBoard => el('option', { value: otherBoard.id, selected: otherBoard.id === board.id },
          `${otherBoard.name}${otherBoard.archived ? ' (archived)' : ''}`)));
      const errBox = el('p', { class: 'wt-modal__error', hidden: true });

      const metaPartList = [`Created ${formatShortDate(task.created_at)}${task.created_by === 'claude' ? ' by Claude' : ''}`];
      if (task.updated_at && task.updated_at !== task.created_at) metaPartList.push(`updated ${formatShortDate(task.updated_at)}`);
      if (task.completed_at) metaPartList.push(`done ${formatShortDate(task.completed_at)}`);

      const deleteButton = el('button', {
        type: 'button', class: 'wt-tb-btn wt-tb-btn--danger',
        onclick: () => {
          if (!window.confirm(`Delete ${task.key} "${task.title}"?`)) return;
          ctx.closeModal();
          persist(mutations.deleteTask(board.id, task.id), `Delete task ${task.key}`);
        },
      }, 'Delete');
      const submit = el('button', { class: 'wt-modal__submit' }, 'Save');
      const cancel = el('button', { class: 'wt-modal__cancel' }, 'Cancel');
      function attempt() {
        const title = titleInput.value.trim();
        if (!title) { errBox.textContent = 'Title can\'t be empty.'; errBox.hidden = false; return; }
        const description = descriptionTextarea.value.trim();
        ctx.closeModal();
        const mutationList = [];
        if (title !== task.title || description !== (task.description || '')) {
          mutationList.push(mutations.updateTask(board.id, task.id, { title, description }));
        }
        if (columnSelect.value !== task.column_id) {
          mutationList.push(mutations.moveTask(board.id, task.id, columnSelect.value, null));
        }
        if (boardSelect.value !== board.id) {
          mutationList.push(mutations.moveTaskToBoard(board.id, task.id, boardSelect.value));
        }
        if (mutationList.length === 0) return;
        persist((targetModel) => { for (const mutationFn of mutationList) mutationFn(targetModel); }, `Edit task ${task.key}`);
      }
      submit.addEventListener('click', attempt);
      cancel.addEventListener('click', () => ctx.closeModal());
      titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

      ctx.openModal([
        el('h2', {}, el('span', { class: 'wt-tb-modalkey' }, task.key), ' Edit task'),
        el('div', { class: 'wt-modal__field' }, el('label', {}, 'Title'), titleInput),
        el('div', { class: 'wt-modal__field' }, el('label', {}, 'Description'), descriptionTextarea),
        el('div', { class: 'wt-tb-fieldpair' },
          el('div', { class: 'wt-modal__field' }, el('label', {}, 'Status'), columnSelect),
          el('div', { class: 'wt-modal__field' }, el('label', {}, 'Board'), boardSelect)),
        el('p', { class: 'wt-modal__hint' }, metaPartList.join(' · ')),
        errBox,
        el('div', { class: 'wt-modal__actions wt-tb-modal-actions' }, deleteButton, el('span', { class: 'wt-tb-spacer' }), cancel, submit),
      ]);
    }

    // ---- renderers ----
    function renderTabs() {
      tabsEl.innerHTML = '';
      const board = currentBoard();
      const archivedBoardCount = dataModel.boards.filter(otherBoard => otherBoard.archived).length;
      for (const tabBoard of dataModel.boards) {
        if (tabBoard.archived && !showArchived) continue;
        tabsEl.appendChild(el('button', {
          class: 'wt-tb-tab' + (tabBoard === board ? ' wt-tb-tab--on' : '') + (tabBoard.archived ? ' wt-tb-tab--archived' : ''),
          onclick: () => selectBoard(tabBoard.id),
        }, tabBoard.name, el('span', { class: 'wt-tb-tab__count' }, String(openTaskCount(tabBoard)))));
      }
      if (archivedBoardCount) {
        tabsEl.appendChild(el('button', {
          class: 'wt-tb-tab wt-tb-tab--toggle',
          onclick: () => { showArchived = !showArchived; renderAll(); },
        }, showArchived ? 'Hide archived' : `Archived (${archivedBoardCount})`));
      }
    }

    function renderBoardHeader(board) {
      boardHeaderEl.innerHTML = '';
      if (!board) return;
      const doneCount = board.tasks.length - openTaskCount(board);
      boardHeaderEl.append(
        el('span', { class: 'wt-tb-boardhead__key' }, board.key),
        el('span', { class: 'wt-tb-boardhead__meta' },
          `${openTaskCount(board)} open · ${doneCount} done${board.archived ? ' · archived' : ''}`),
        el('button', {
          class: 'wt-tb-iconbtn', title: 'Board settings (name, columns, archive)', 'aria-label': 'Board settings',
          html: ICON_GEAR, onclick: () => openBoardSettingsModal(board),
        }));
    }

    function renderCard(board, task) {
      const cardEl = el('div', {
        class: 'wt-tb-card', draggable: 'true', tabindex: '0', 'data-task-id': task.id,
        onclick: () => openTaskModal(board, task),
        onkeydown: (e) => { if (e.key === 'Enter') openTaskModal(board, task); },
      },
        el('div', { class: 'wt-tb-card__title' }, task.title),
        task.description ? el('div', { class: 'wt-tb-card__desc' }, task.description) : null,
        el('div', { class: 'wt-tb-card__foot' },
          el('span', { class: 'wt-tb-card__key' }, task.key),
          task.created_by === 'claude' ? el('span', { class: 'wt-tb-card__by', title: 'Added by Claude' }, 'Claude') : null));
      cardEl.addEventListener('dragstart', (e) => {
        draggedTaskId = task.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        setTimeout(() => cardEl.classList.add('wt-tb-card--dragging'), 0);
      });
      cardEl.addEventListener('dragend', () => {
        draggedTaskId = null;
        cardEl.classList.remove('wt-tb-card--dragging');
        clearDropMarkers();
      });
      return cardEl;
    }

    function clearDropMarkers() {
      for (const markerEl of columnsEl.querySelectorAll('.wt-tb-dropmarker')) markerEl.remove();
      for (const columnEl of columnsEl.querySelectorAll('.wt-tb-column--over')) columnEl.classList.remove('wt-tb-column--over');
    }

    // The card the pointer is above (by vertical midpoint) = insert-before
    // target; none = end of column. Skips the card being dragged.
    function cardAfterPointer(cardListEl, pointerY) {
      for (const cardEl of cardListEl.querySelectorAll('.wt-tb-card')) {
        if (cardEl.dataset.taskId === draggedTaskId) continue;
        const rect = cardEl.getBoundingClientRect();
        if (pointerY < rect.top + rect.height / 2) return cardEl;
      }
      return null;
    }

    function renderComposer(board, column) {
      const titleTextarea = el('textarea', { class: 'wt-tb-composer__input', rows: '2', placeholder: 'What needs doing? (Enter to add)' });
      function closeComposer() { composerColumnId = null; renderColumns(board); }
      function addFromComposer() {
        const title = titleTextarea.value.trim();
        if (!title) { closeComposer(); return; }
        // Composer stays open for rapid entry.
        persist(mutations.addTask(board.id, { taskId: makeId('tsk'), title, description: '', columnId: column.id }),
          `Add task to "${board.name}": ${title.slice(0, 60)}`);
      }
      titleTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addFromComposer(); }
        else if (e.key === 'Escape') { e.stopPropagation(); closeComposer(); }
      });
      setTimeout(() => titleTextarea.focus(), 0);
      return el('div', { class: 'wt-tb-composer' },
        titleTextarea,
        el('div', { class: 'wt-tb-composer__actions' },
          el('button', { class: 'wt-tb-btn wt-tb-btn--primary wt-tb-btn--small', onclick: addFromComposer }, 'Add'),
          el('button', { class: 'wt-tb-btn wt-tb-btn--ghost wt-tb-btn--small', onclick: closeComposer }, 'Cancel')));
    }

    function renderColumns(board) {
      columnsEl.innerHTML = '';
      if (!board) {
        columnsEl.appendChild(el('div', { class: 'wt-tb-empty' },
          el('p', {}, 'No boards yet.'),
          el('p', {}, 'Create one per project with "+ New board", or ask Claude to "seed my task boards".')));
        return;
      }
      for (const column of board.columns) {
        const columnTaskList = board.tasks.filter(task => task.column_id === column.id);
        const cardListEl = el('div', { class: 'wt-tb-cardlist' }, ...columnTaskList.map(task => renderCard(board, task)));
        const columnEl = el('div', { class: 'wt-tb-column' + (column.is_done ? ' wt-tb-column--done' : '') },
          el('div', { class: 'wt-tb-column__head' },
            el('span', { class: 'wt-tb-column__name' }, column.name),
            el('span', { class: 'wt-tb-column__count' }, String(columnTaskList.length))),
          cardListEl,
          composerColumnId === column.id
            ? renderComposer(board, column)
            : el('button', {
              class: 'wt-tb-addtask',
              onclick: () => { composerColumnId = column.id; renderColumns(board); },
            }, '+ Add task'));

        columnEl.addEventListener('dragover', (e) => {
          if (!draggedTaskId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const beforeCardEl = cardAfterPointer(cardListEl, e.clientY);
          const existingMarkerEl = cardListEl.querySelector('.wt-tb-dropmarker');
          if (existingMarkerEl && existingMarkerEl.nextElementSibling === beforeCardEl) return;
          clearDropMarkers();
          columnEl.classList.add('wt-tb-column--over');
          cardListEl.insertBefore(el('div', { class: 'wt-tb-dropmarker' }), beforeCardEl);
        });
        columnEl.addEventListener('dragleave', (e) => {
          if (!columnEl.contains(e.relatedTarget)) clearDropMarkers();
        });
        columnEl.addEventListener('drop', (e) => {
          if (!draggedTaskId) return;
          e.preventDefault();
          const movedTaskId = draggedTaskId;
          const beforeCardEl = cardAfterPointer(cardListEl, e.clientY);
          const beforeTaskId = beforeCardEl ? beforeCardEl.dataset.taskId : null;
          draggedTaskId = null;
          clearDropMarkers();
          const movedTask = findTask(board, movedTaskId);
          if (!movedTask) return;
          // Dropped back where it was — no write.
          const columnTaskIdList = columnTaskList.map(task => task.id);
          const currentIndex = columnTaskIdList.indexOf(movedTaskId);
          if (movedTask.column_id === column.id && currentIndex !== -1
              && (columnTaskIdList[currentIndex + 1] || null) === beforeTaskId) { renderColumns(board); return; }
          const commitMessage = movedTask.column_id === column.id
            ? `Reorder ${movedTask.key}`
            : `Move ${movedTask.key} to ${column.name}`;
          persist(mutations.moveTask(board.id, movedTaskId, column.id, beforeTaskId), commitMessage);
        });
        columnsEl.appendChild(columnEl);
      }
    }

    function renderAll() {
      const board = currentBoard();
      renderTabs();
      renderBoardHeader(board);
      renderColumns(board);
    }

    renderAll();
  },
};
