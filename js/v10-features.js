/* Mathside V10 classroom features: To-Do, Calendar, Feedback Inbox,
   Draft Saving, Notifications, Resubmission controls, and Class Record export.
   Attendance and private messaging are intentionally not included. */
(() => {
  'use strict';

  const feature = {
    calendarCursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    calendarSelectedDay: '',
    draftTimer: null,
    notifications: [],
    notificationCleanupDone: false,
    notificationFetchedAt: 0,
    notificationFetchPromise: null,
    notificationUserId: null,
    pollTimer: null
  };

  const safeDate = value => {
    const d = value ? new Date(value) : null;
    return d && Number.isFinite(d.getTime()) ? d : null;
  };
  const dayKey = value => {
    const d = safeDate(value);
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const formatFullDate = value => {
    const d = safeDate(value);
    return d ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(d) : 'No date';
  };
  const formatDateTime = value => {
    const d = safeDate(value);
    return d ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d) : '';
  };
  const relativeDue = value => {
    const d = safeDate(value);
    if (!d) return { label: 'No deadline', key: 'none' };
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((target - today) / 86400000);
    if (days < 0) return { label: `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`, key: 'overdue' };
    if (days === 0) return { label: 'Due today', key: 'today' };
    if (days === 1) return { label: 'Due tomorrow', key: 'soon' };
    if (days <= 7) return { label: `Due in ${days} days`, key: 'soon' };
    return { label: `Due ${formatFullDate(d)}`, key: 'later' };
  };
  const currentUserId = () => state.user?.id || null;
  const connected = () => Boolean(db && currentUserId());
  const studentAssignments = () => state.assignments.filter(a => a.status === 'published' && !a.archived_at);
  const todoAssignments = () => studentAssignments().filter(a => studentNeedsToSubmit(a));

  function setBadge(id, count) {
    const node = document.getElementById(id);
    if (!node) return;
    const n = Math.max(0, Number(count || 0));
    node.textContent = n > 99 ? '99+' : String(n);
    node.hidden = n === 0;
  }

  function featureEmpty(title, copy = '') {
    return `<div class="v10-feature-empty"><b>${esc(title)}</b>${copy ? `<span>${esc(copy)}</span>` : ''}</div>`;
  }

  // ------------------------------------------------------------------
  // STUDENT TO-DO
  // ------------------------------------------------------------------
  function renderTodo() {
    const list = document.getElementById('studentTodoList');
    const summary = document.getElementById('studentTodoSummary');
    if (!list || !summary) return;
    const pending = todoAssignments().sort((a, b) => {
      const ad = safeDate(a.due_at)?.getTime() ?? Infinity;
      const bd = safeDate(b.due_at)?.getTime() ?? Infinity;
      return ad - bd || new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
    const overdue = pending.filter(a => safeDate(a.due_at) && safeDate(a.due_at).getTime() < Date.now()).length;
    const dueWeek = pending.filter(a => {
      const d = safeDate(a.due_at);
      return d && d.getTime() >= Date.now() && d.getTime() <= Date.now() + 7 * 86400000;
    }).length;
    summary.innerHTML = `<article><b>${pending.length}</b><span>To do</span></article><article><b>${overdue}</b><span>Overdue</span></article><article><b>${dueWeek}</b><span>Due this week</span></article>`;
    setBadge('studentTodoNavBadge', pending.length);
    if (!pending.length) {
      list.innerHTML = featureEmpty('You’re all caught up!', 'No unfinished activities right now.');
      return;
    }
    list.innerHTML = pending.map(a => {
      const due = relativeDue(a.due_at);
      const section = sectionById(a.section_id);
      return `<article class="v10-todo-card ${due.key}">
        <div class="v10-todo-check" aria-hidden="true">✓</div>
        <div class="v10-todo-copy"><span>${esc(sectionLabel(section))}</span><h3>${esc(a.title)}</h3><p>${esc(a.instructions || 'Open this activity to continue working.')}</p></div>
        <div class="v10-todo-meta"><span class="v10-due-chip ${due.key}">${esc(due.label)}</span><button class="v8-view-button" type="button" data-answer-assignment="${esc(a.id)}">Open</button></div>
      </article>`;
    }).join('');
  }

  // ------------------------------------------------------------------
  // STUDENT CALENDAR
  // ------------------------------------------------------------------
  function renderCalendar() {
    const grid = document.getElementById('studentCalendarGrid');
    const label = document.getElementById('calendarMonthLabel');
    const agenda = document.getElementById('studentCalendarAgenda');
    const agendaTitle = document.getElementById('studentCalendarAgendaTitle');
    if (!grid || !label) return;
    const cursor = feature.calendarCursor;
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    label.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(cursor);
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevDays = first.getDay();
    const assignments = studentAssignments().filter(a => {
      const d = safeDate(a.due_at);
      return d && d.getFullYear() === year && d.getMonth() === month;
    }).sort((a,b) => new Date(a.due_at || 0) - new Date(b.due_at || 0));
    const byDay = new Map();
    assignments.forEach(a => {
      const key = dayKey(a.due_at);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(a);
    });
    const cells = [];
    for (let i = 0; i < prevDays; i += 1) cells.push('<div class="v10-calendar-day is-outside" aria-hidden="true"></div>');
    const today = dayKey(new Date());
    for (let day = 1; day <= daysInMonth; day += 1) {
      const d = new Date(year, month, day);
      const key = dayKey(d);
      const tasks = byDay.get(key) || [];
      const taskLabel = tasks.length ? `${tasks.length} deadline${tasks.length === 1 ? '' : 's'}` : 'No deadlines';
      cells.push(`<button type="button" class="v10-calendar-day ${key === today ? 'is-today' : ''} ${tasks.length ? 'has-task' : ''} ${feature.calendarSelectedDay === key ? 'is-selected' : ''}" data-calendar-day="${key}" aria-label="${esc(new Intl.DateTimeFormat(undefined,{month:'long',day:'numeric',year:'numeric'}).format(d))}: ${taskLabel}" title="${esc(taskLabel)}"><span class="v15-calendar-number">${day}</span>${tasks.length ? '<span class="v15-calendar-deadline-dot" aria-hidden="true"></span>' : ''}</button>`);
    }
    grid.innerHTML = cells.join('');

    if (!agenda) return;
    const selectedTasks = feature.calendarSelectedDay ? (byDay.get(feature.calendarSelectedDay) || []) : assignments;
    if (agendaTitle) {
      if (feature.calendarSelectedDay) {
        const selectedDate = safeDate(`${feature.calendarSelectedDay}T12:00:00`);
        agendaTitle.textContent = selectedDate
          ? `Deadlines for ${new Intl.DateTimeFormat(undefined,{month:'long',day:'numeric'}).format(selectedDate)}`
          : 'Deadlines';
      } else {
        agendaTitle.textContent = 'Deadlines this month';
      }
    }
    if (!selectedTasks.length) {
      agenda.innerHTML = `<div class="v10-calendar-empty">${feature.calendarSelectedDay ? 'No deadlines on this day.' : 'No deadlines this month.'}</div>`;
      return;
    }
    agenda.innerHTML = selectedTasks.map(a => {
      const submitted = submissionFor(a.id);
      const finished = studentHasRecordedSubmission(a.id);
      const missed = !finished && safeDate(a.due_at)?.getTime() < Date.now();
      const status = finished ? 'Submitted' : missed ? 'Missed' : 'To do';
      const statusKey = finished ? 'done' : missed ? 'missed' : 'todo';
      const type = isPerformanceTask(a) ? 'Performance Task' : 'Activity';
      const action = submitted ? `data-preview-response="${esc(submitted.id)}"` : finished ? '' : isPerformanceTask(a) ? `data-submit-performance="${esc(a.id)}"` : `data-answer-assignment="${esc(a.id)}"`;
      return `<article class="v10-agenda-row"><time>${esc(formatDateTime(a.due_at))}</time><div><span>${esc(type)}</span><b>${esc(a.title)}</b></div><span class="v10-agenda-status ${statusKey}">${status}</span><button type="button" class="v8-view-button" ${action} ${finished && !submitted ? 'disabled title="Submission already recorded"' : ''}>${submitted ? 'View' : finished ? 'Recorded' : 'Open'}</button></article>`;
    }).join('');
  }

  // ------------------------------------------------------------------
  // FEEDBACK INBOX
  // ------------------------------------------------------------------
  function renderFeedbackInbox() {
    const box = document.getElementById('studentFeedbackInbox');
    if (!box) return;
    const graded = state.submissions
      .filter(s => s.student_id === currentUserId() && s.status === 'graded')
      .sort((a,b) => new Date(b.graded_at || b.updated_at || b.submitted_at || 0) - new Date(a.graded_at || a.updated_at || a.submitted_at || 0));
    if (!graded.length) {
      box.innerHTML = featureEmpty('No teacher feedback yet.', 'Reviewed activities and teacher comments will appear here.');
      return;
    }
    box.innerHTML = graded.map(s => {
      const a = assignmentById(s.assignment_id);
      const total = a ? totalPoints(a.id) : 0;
      const raw = Number(s.teacher_score ?? s.auto_score ?? 0);
      const pct = total > 0 ? Math.round(raw / total * 100) : null;
      return `<article class="v10-feedback-card">
        <div class="v10-feedback-icon">✓</div>
        <div class="v10-feedback-main"><span>${esc(sectionLabel(sectionById(a?.section_id)))}</span><h3>${esc(a?.title || 'Reviewed activity')}</h3><p>${esc(s.feedback || 'Your teacher reviewed this activity.')}</p><time>${esc(formatDateTime(s.graded_at || s.updated_at || s.submitted_at))}</time></div>
        <div class="v10-feedback-score"><b>${pct === null ? '—' : `${pct}%`}</b><span>${raw}/${total}</span><button class="v8-view-button" type="button" data-preview-response="${esc(s.id)}">View response</button></div>
      </article>`;
    }).join('');
  }

  // ------------------------------------------------------------------
  // DRAFT SAVING
  // ------------------------------------------------------------------
  function collectDraftAnswers(assignment) {
    return questionsFor(assignment.id).map(q => ({
      question_id: q.id,
      answer: q.question_type === 'mcq'
        ? (document.querySelector(`input[name="answer_${q.id}"]:checked`)?.value || '')
        : (document.querySelector(`[name="answer_${q.id}"]`)?.value || '')
    }));
  }

  function applyDraftAnswers(assignment, answers = []) {
    const map = new Map((Array.isArray(answers) ? answers : []).map(row => [row.question_id, row.answer ?? '']));
    questionsFor(assignment.id).forEach(q => {
      const value = map.get(q.id);
      if (value == null) return;
      if (q.question_type === 'mcq') {
        const options = [...document.querySelectorAll(`input[name="answer_${q.id}"]`)];
        const match = options.find(input => input.value === value);
        if (match) match.checked = true;
      } else {
        const input = document.querySelector(`[name="answer_${q.id}"]`);
        if (input) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
  }

  async function saveDraft() {
    if (!connected() || state.profile?.role !== 'student' || !activeStudentAssignment) return;
    const status = document.getElementById('studentDraftStatus');
    const answers = collectDraftAnswers(activeStudentAssignment);
    if (status) status.textContent = 'Saving draft…';
    const { error } = await db.from('mathside_assignment_drafts').upsert({
      student_id: currentUserId(),
      assignment_id: activeStudentAssignment.id,
      answers,
      updated_at: new Date().toISOString()
    }, { onConflict: 'student_id,assignment_id' });
    if (error) {
      console.warn('Draft save failed:', error.message || error);
      if (status) status.textContent = 'Draft could not be saved. Check your connection.';
      return;
    }
    if (status) status.textContent = `Draft saved ${new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date())}`;
  }

  function queueDraftSave() {
    clearTimeout(feature.draftTimer);
    feature.draftTimer = setTimeout(() => saveDraft().catch(() => {}), 650);
  }

  async function prepareAnswerDraft(assignment) {
    if (!connected() || state.profile?.role !== 'student' || !assignment) return;
    const status = document.getElementById('studentDraftStatus');
    if (status) status.textContent = 'Loading saved draft…';
    const { data, error } = await db.from('mathside_assignment_drafts')
      .select('answers,updated_at')
      .eq('student_id', currentUserId())
      .eq('assignment_id', assignment.id)
      .maybeSingle();
    if (!error && data?.answers) {
      applyDraftAnswers(assignment, data.answers);
      if (status) status.textContent = `Draft restored from ${formatDateTime(data.updated_at)}.`;
      return;
    }
    const existing = submissionFor(assignment.id);
    if (existing && assignment.allow_resubmission) {
      const previousAnswers = state.submissionAnswers
        .filter(row => row.submission_id === existing.id)
        .map(row => ({ question_id: row.question_id, answer: row.answer_text || '' }));
      applyDraftAnswers(assignment, previousAnswers);
      if (status) status.textContent = 'Previous submission loaded for your new attempt.';
      return;
    }
    if (status) status.textContent = 'Draft saving is ready.';
  }

  async function clearDraft(assignmentId) {
    if (!connected() || !assignmentId) return;
    await db.from('mathside_assignment_drafts')
      .delete()
      .eq('student_id', currentUserId())
      .eq('assignment_id', assignmentId);
  }

  document.getElementById('answerForm')?.addEventListener('input', queueDraftSave);
  document.getElementById('answerForm')?.addEventListener('change', event => {
    if (event.target?.id === 'studentSolutionImage') return;
    queueDraftSave();
  });


  // Notifications and announcements were removed from Mathside.
  // Keep compatibility no-ops for any older callers, but never query the
  // removed Supabase notification tables or RPCs.
  async function refreshNotifications() { return; }
  async function openNotifications() { return; }
  function routeNotification() { return; }

  // ------------------------------------------------------------------
  // EXPORT CLASS RECORD
  // ------------------------------------------------------------------
  function safeFilename(value) {
    return String(value || 'class').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'class';
  }

  function classRecordGenderRank(value) {
    const gender = String(value || '').trim().toLowerCase();
    if (gender === 'male' || gender === 'm' || gender === 'boy' || gender === 'boys') return 0;
    if (gender === 'female' || gender === 'f' || gender === 'girl' || gender === 'girls') return 1;
    return 2;
  }

  function classRecordGenderLabel(value) {
    const rank = classRecordGenderRank(value);
    if (rank === 0) return 'Male';
    if (rank === 1) return 'Female';
    return String(value || 'Not specified');
  }

  function downloadExcelBuffer(buffer, filename) {
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportRosterAccounts() {
    if (!window.ExcelJS) return toast('Excel export library is not available.', 'orange', 'Export unavailable');
    const section = sectionById(activeRosterSectionId);
    if (!section) return toast('Open a class roster first.', 'orange', 'Choose a class');

    const students = studentsForSection(section.id).slice().sort((a, b) => {
      const genderDifference = classRecordGenderRank(a.gender) - classRecordGenderRank(b.gender);
      if (genderDifference) return genderDifference;
      return String(a.display_name || '').localeCompare(String(b.display_name || ''), undefined, { sensitivity: 'base' });
    });
    if (!students.length) return toast('This class does not have any student accounts yet.', 'orange', 'Nothing to export');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Mathside';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Student Accounts', { views: [{ state: 'frozen', ySplit: 4 }] });
    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FFC9B7A8' } },
      left: { style: 'thin', color: { argb: 'FFC9B7A8' } },
      bottom: { style: 'thin', color: { argb: 'FFC9B7A8' } },
      right: { style: 'thin', color: { argb: 'FFC9B7A8' } }
    };

    sheet.mergeCells('A1:D1');
    const title = sheet.getCell('A1');
    title.value = 'MATHSIDE STUDENT ACCOUNTS';
    title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
    title.alignment = { vertical: 'middle', horizontal: 'left' };
    title.border = thinBorder;
    sheet.getRow(1).height = 28;

    sheet.mergeCells('A2:D2');
    const info = sheet.getCell('A2');
    info.value = `${section.name}   •   Grade ${section.grade_level}   •   Downloaded: ${new Date().toLocaleString()}`;
    info.font = { bold: true, color: { argb: 'FF7C2D00' } };
    info.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE8D5' } };
    info.alignment = { vertical: 'middle', horizontal: 'left' };
    info.border = thinBorder;

    const header = sheet.getRow(4);
    header.values = ['No.', 'Student Name', 'Gender', 'Username'];
    header.height = 25;
    header.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = thinBorder;
    });

    let rowNumber = 5;
    let currentGroup = null;
    let number = 1;
    students.forEach(student => {
      const rank = classRecordGenderRank(student.gender);
      const group = rank === 0 ? 'MALE' : rank === 1 ? 'FEMALE' : 'OTHER / NOT SPECIFIED';
      if (group !== currentGroup) {
        currentGroup = group;
        sheet.mergeCells(`A${rowNumber}:D${rowNumber}`);
        const groupCell = sheet.getCell(`A${rowNumber}`);
        groupCell.value = group;
        groupCell.font = { bold: true, color: { argb: rank === 0 ? 'FF174A7E' : rank === 1 ? 'FF8C2458' : 'FF5B5B5B' } };
        groupCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rank === 0 ? 'FFDCEEFF' : rank === 1 ? 'FFFCE1EE' : 'FFECECEC' } };
        groupCell.alignment = { vertical: 'middle', horizontal: 'left' };
        for (let col = 1; col <= 4; col += 1) sheet.getCell(rowNumber, col).border = thinBorder;
        rowNumber += 1;
      }
      const row = sheet.getRow(rowNumber);
      row.values = [number++, student.display_name || '', classRecordGenderLabel(student.gender), student.username || ''];
      row.height = 21;
      row.eachCell((cell, col) => {
        cell.border = thinBorder;
        cell.alignment = { vertical: 'middle', horizontal: col === 1 ? 'center' : 'left', wrapText: true };
      });
      row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF6EA' } };
      rowNumber += 1;
    });

    sheet.getColumn(1).width = 7;
    sheet.getColumn(2).width = 34;
    sheet.getColumn(3).width = 14;
    sheet.getColumn(4).width = 32;

    const notes = workbook.addWorksheet('Read Me');
    notes.columns = [{ width: 24 }, { width: 90 }];
    const noteRows = [
      ['MATHSIDE — ACCOUNT LIST', ''],
      ['Purpose', 'Use this file to recover the current student names and Mathside usernames for this class.'],
      ['Passwords', 'For security, existing passwords are not stored in readable form and cannot be included in a later download. If a student forgot a password, the password must be reset rather than recovered.'],
      ['Class', section.name],
      ['Grade', `Grade ${section.grade_level}`]
    ];
    noteRows.forEach((values, index) => {
      const row = notes.addRow(values);
      row.eachCell(cell => { cell.border = thinBorder; cell.alignment = { vertical: 'top', wrapText: true }; });
      if (index === 0) {
        row.eachCell(cell => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
        });
      } else {
        row.getCell(1).font = { bold: true, color: { argb: 'FF7C2D00' } };
        row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE8D5' } };
      }
    });

    try {
      const buffer = await workbook.xlsx.writeBuffer();
      downloadExcelBuffer(buffer, `Mathside-${safeFilename(section.name)}-Grade-${section.grade_level}-Student-Accounts.xlsx`);
      toast('Student account list downloaded.', 'success', 'Download complete');
    } catch (error) {
      console.error('Student account export failed:', error);
      toast('Could not create the student account Excel file.', 'orange', 'Export failed');
    }
  }

  let latestClassRecordExport = null;

  function classRecordTimestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function downloadPreparedClassRecord(exportFile) {
    if (!exportFile?.blob || !exportFile?.filename) {
      return toast('The class record file is not ready. Export it again first.', 'orange', 'Download unavailable');
    }
    const url = URL.createObjectURL(exportFile.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFile.filename;
    link.rel = 'noopener';
    if (typeof isIOSDevice === 'function' && isIOSDevice()) link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function showClassRecordReady(section) {
    const title = document.getElementById('classRecordExportTitle');
    const lead = document.getElementById('classRecordExportLead');
    if (title) title.textContent = `${section.name} class record is ready.`;
    if (lead) lead.textContent = `Grade ${section.grade_level} • Tap Download Excel below. You can download the prepared file repeatedly or close this window and export a fresh copy later.`;
    openDialog('classRecordExportModal');
  }

  const performanceRatingDeduction = rating => ({ 5: 0, 4: 2, 3: 3, 2: 4, 1: 5 }[Number(rating)] ?? null);

  function submissionNumericScore(submission, { performanceTask = false } = {}) {
    if (!submission) return null;
    if (performanceTask) {
      if (submission.status !== 'graded' || submission.teacher_score === null || submission.teacher_score === undefined || submission.teacher_score === '') return null;
      const score = Number(submission.teacher_score);
      return Number.isFinite(score) ? score : null;
    }
    const rawScore = submission.status === 'graded'
      ? (submission.teacher_score ?? submission.auto_score)
      : submission.auto_score;
    if (rawScore === null || rawScore === undefined || rawScore === '') return null;
    const score = Number(rawScore);
    return Number.isFinite(score) ? score : null;
  }

  async function loadPerformanceTaskExportData(performanceAssignments) {
    const result = new Map();
    for (const assignment of performanceAssignments) {
      if ((assignment.collaboration_mode || 'individual') === 'individual') {
        result.set(assignment.id, { groups: [], ratingsByGroup: new Map() });
        continue;
      }

      const groupsResult = await db.rpc('mathside_get_performance_groups_for_teacher', { p_assignment_id: assignment.id });
      if (groupsResult.error) throw groupsResult.error;
      const groups = Array.isArray(groupsResult.data?.groups) ? groupsResult.data.groups : [];
      const ratingsByGroup = new Map();

      await Promise.all(groups.map(async group => {
        const ratingsResult = await db.rpc('mathside_get_participation_ratings', {
          p_assignment_id: assignment.id,
          p_group_id: group.id
        });
        if (ratingsResult.error) throw ratingsResult.error;
        ratingsByGroup.set(group.id, new Map(
          (Array.isArray(ratingsResult.data) ? ratingsResult.data : [])
            .map(row => [String(row.member_id || ''), Number(row.rating || 0)])
        ));
      }));

      result.set(assignment.id, { groups, ratingsByGroup });
    }
    return result;
  }

  // Fetch a full, current snapshot for exports. PostgREST defaults to at most
  // 1,000 rows per response; without pagination large classes lose grades.
  async function readClassRecordArchiveRows(table, columns, assignmentIds, { optional = false } = {}) {
    const rows = [];
    for (let i = 0; i < assignmentIds.length; i += 40) {
      const group = assignmentIds.slice(i, i + 40);
      for (let start = 0;; start += 400) {
        const { data, error } = await db.from(table).select(columns)
          .in('assignment_id', group)
          .order('assignment_id', { ascending: true })
          .order('student_id', { ascending: true })
          .range(start, start + 399);
        if (error) {
          if (optional && ['42P01', 'PGRST205'].includes(String(error.code))) return null;
          throw error;
        }
        const batch = data || [];
        rows.push(...batch);
        if (batch.length < 400) break;
      }
    }
    return rows;
  }

  function classRecordRowsToMap(rows, valueKey) {
    const result = new Map();
    (rows || []).forEach(row => {
      const assignmentKey = String(row.assignment_id);
      if (!result.has(assignmentKey)) result.set(assignmentKey, new Map());
      result.get(assignmentKey).set(String(row.student_id), valueKey === null ? row : Number(row[valueKey]));
    });
    return result;
  }

  function savedClassRecordValue(assignment, studentId, snapshots, archivedScores) {
    const row = snapshots.get(String(assignment.id))?.get(String(studentId));
    if (row) {
      if (row.score !== null && row.score !== undefined && row.score !== '') {
        const score = Number(row.score);
        if (Number.isFinite(score)) return { value: score, note: 'Score preserved when this task was archived.' };
      }
      if (row.display_status === 'Pending' || row.display_status === 'Not rated')
        return { value: row.display_status, note: 'Submission status preserved when this task was archived.' };
    }
    const olderGrade = archivedScores.get(String(assignment.id))?.get(String(studentId));
    if (olderGrade !== undefined)
      return { value: olderGrade, note: 'Teacher-graded score preserved from an earlier archive.' };
    return null;
  }

  function performanceTaskExportScore(assignment, studentId, performanceData, archivedScores, snapshots) {
    const preserved = savedClassRecordValue(assignment, studentId, snapshots, archivedScores);
    // Archived team memberships and submissions were deliberately deleted.
    // The durable score/status snapshot supplies this cell in the export.
    if (assignment.status === 'archived') return preserved || { value: '—', note: '' };
    const ownSubmission = state.submissions.find(s => s.assignment_id === assignment.id && s.student_id === studentId);
    if ((assignment.collaboration_mode || 'individual') === 'individual') {
      if (!ownSubmission) return preserved || { value: '—', note: '' };
      const score = submissionNumericScore(ownSubmission, { performanceTask: true });
      return score === null ? { value: 'Pending', note: '' } : { value: score, note: 'Individual performance task score.' };
    }

    const assignmentData = performanceData.get(assignment.id) || { groups: [], ratingsByGroup: new Map() };
    const group = assignmentData.groups.find(item => (item.members || []).some(member => String(member.id) === String(studentId)));
    if (!group) return preserved || { value: '—', note: 'No saved team was found for this learner.' };

    const leaderId = String(group.leader_id || '');
    const leaderSubmission = state.submissions.find(s => s.assignment_id === assignment.id && String(s.student_id) === leaderId);
    if (!leaderSubmission) return preserved || { value: '—', note: `${group.name || 'Team'} has no leader submission yet.` };

    const leaderScore = submissionNumericScore(leaderSubmission, { performanceTask: true });
    if (leaderScore === null) return { value: 'Pending', note: 'The team leader submission has not been graded yet.' };
    if (String(studentId) === leaderId) {
      return { value: leaderScore, note: `Team leader — full teacher-given grade (${leaderScore}).` };
    }

    // Classmates have mirrored submissions that already include the 1–5 rating
    // deduction and any teacher-entered individual adjustment. Do not subtract
    // the rating a second time during Excel export.
    if (assignment.collaboration_mode === 'class') {
      const rating = assignmentData.ratingsByGroup.get(group.id)?.get(String(studentId));
      const score = submissionNumericScore(ownSubmission, { performanceTask: true });
      if (score !== null) return {
        value: score,
        note: rating ? `Class representative rated participation ${rating}/5. Saved score includes applicable participation adjustment or teacher override.` : 'Score individually adjusted by the teacher.'
      };
      return { value: 'Not rated', note: 'Class representative has not saved a participation rating for this learner yet.' };
    }

    const rating = assignmentData.ratingsByGroup.get(group.id)?.get(String(studentId));
    const deduction = performanceRatingDeduction(rating);
    if (deduction === null) return { value: 'Not rated', note: 'The team leader has not saved a participation rating for this member yet.' };
    const adjustedScore = Math.max(0, leaderScore - deduction);
    return {
      value: adjustedScore,
      note: `Leader score ${leaderScore} − ${deduction} point${deduction === 1 ? '' : 's'} for participation rating ${rating}/5 = ${adjustedScore}.`
    };
  }

  function styleRecordTitle(sheet, lastColumn, title, section) {
    sheet.mergeCells(`A1:${lastColumn}1`);
    const titleCell = sheet.getCell('A1');
    titleCell.value = title;
    titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(1).height = 28;

    sheet.mergeCells(`A2:${lastColumn}2`);
    const infoCell = sheet.getCell('A2');
    infoCell.value = `Grade ${section.grade_level}   •   Teacher: ${state.profile?.display_name || 'Teacher'}   •   Exported: ${new Date().toLocaleString()}`;
    infoCell.font = { bold: true, color: { argb: 'FF7C2D00' } };
    infoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE8D5' } };
    infoCell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(2).height = 22;
  }

  async function exportClassRecord() {
    if (!window.ExcelJS) return toast('Excel export library is not available.', 'orange', 'Export unavailable');
    const section = sectionById(activeRosterSectionId);
    if (!section) return toast('Open a class roster first.', 'orange', 'Choose a class');

    const students = studentsForSection(section.id).slice().sort((a, b) => {
      const genderDifference = classRecordGenderRank(a.gender) - classRecordGenderRank(b.gender);
      if (genderDifference) return genderDifference;
      return String(a.display_name || '').localeCompare(String(b.display_name || ''), undefined, { sensitivity: 'base' });
    });
    const assignments = state.assignments
      .filter(a => a.section_id === section.id && (a.status === 'published' || a.status === 'archived'))
      .sort((a,b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    const writtenAssignments = assignments.filter(a => !isPerformanceTask(a));
    const performanceAssignments = assignments.filter(a => isPerformanceTask(a));

    const exportButton = document.getElementById('exportClassRecordBtn');
    if (exportButton) exportButton.disabled = true;
    latestClassRecordExport = null;

    try {
      let buffer = null;
      await withLoading('Preparing class record…', 'Creating separate Written Works and Performance Tasks sheets.', async () => {
        const assignmentIds = assignments.map(a => a.id);
        const [savedScoreRows, snapshotRows] = await Promise.all([
          readClassRecordArchiveRows('mathside_archived_scores',
            'assignment_id,student_id,score', assignmentIds, { optional: true }),
          readClassRecordArchiveRows('mathside_class_record_snapshots',
            'assignment_id,student_id,score,display_status', assignmentIds, { optional: true })
        ]);
        if (assignments.some(a => a.status === 'archived') && savedScoreRows === null && snapshotRows === null) {
          throw new Error('Archived grades cannot be read. Install the archive SQL migrations in Supabase before exporting.');
        }
        const archivedScores = classRecordRowsToMap(savedScoreRows, 'score');
        const archivedSnapshots = classRecordRowsToMap(snapshotRows, null);
        // Active tasks may have been restored; keep their current teams visible.
        const performanceData = await loadPerformanceTaskExportData(performanceAssignments.filter(a => a.status !== 'archived'));
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Mathside';
        workbook.created = new Date();

        const thinBorder = {
          top: { style: 'thin', color: { argb: 'FFB8B8B8' } },
          left: { style: 'thin', color: { argb: 'FFB8B8B8' } },
          bottom: { style: 'thin', color: { argb: 'FFB8B8B8' } },
          right: { style: 'thin', color: { argb: 'FFB8B8B8' } }
        };

        // ----------------------------------------------------------
        // WRITTEN WORKS SHEET — keeps the existing Total Score.
        // ----------------------------------------------------------
        const writtenSheet = workbook.addWorksheet('Written Works', {
          views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }]
        });
        const writtenItemCount = writtenAssignments.reduce((sum, assignment) => sum + questionsFor(assignment.id).length, 0);
        const writtenPossiblePoints = writtenAssignments.reduce((sum, assignment) => sum + Number(totalPoints(assignment.id) || 0), 0);
        const writtenTotalColumns = Math.max(3, 3 + writtenAssignments.length);
        const writtenLastAssignmentColumn = 2 + writtenAssignments.length;
        const writtenTotalScoreColumn = 3 + writtenAssignments.length;
        const writtenLastColumn = writtenSheet.getColumn(writtenTotalColumns).letter;

        styleRecordTitle(writtenSheet, writtenLastColumn, `Mathside Written Works — ${section.name}`, section);
        writtenSheet.mergeCells(`A3:${writtenLastColumn}3`);
        const writtenSummary = writtenSheet.getCell('A3');
        writtenSummary.value = `Written works: ${writtenAssignments.length}   •   Total items: ${writtenItemCount}   •   Total possible score: ${writtenPossiblePoints}`;
        writtenSummary.font = { bold: true, color: { argb: 'FF334155' } };
        writtenSummary.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        writtenSummary.alignment = { vertical: 'middle', horizontal: 'left' };
        writtenSheet.getRow(3).height = 21;

        const writtenHeaders = [
          'Student Name',
          'Gender',
          ...writtenAssignments.map(a => {
            const items = questionsFor(a.id).length;
            return `${a.title}\n(${items} item${items === 1 ? '' : 's'} · ${totalPoints(a.id)} pts)`;
          }),
          `Total Score\n(/ ${writtenPossiblePoints})`
        ];
        const writtenHeaderRow = writtenSheet.getRow(4);
        writtenHeaderRow.values = writtenHeaders;
        writtenHeaderRow.height = 38;
        writtenHeaderRow.eachCell(cell => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          cell.border = thinBorder;
        });

        let writtenRowNumber = 5;
        let writtenCurrentGroup = null;
        students.forEach(student => {
          const rank = classRecordGenderRank(student.gender);
          const genderGroup = rank === 0 ? 'MALE' : rank === 1 ? 'FEMALE' : 'OTHER / NOT SPECIFIED';
          if (genderGroup !== writtenCurrentGroup) {
            writtenCurrentGroup = genderGroup;
            writtenSheet.mergeCells(`A${writtenRowNumber}:${writtenLastColumn}${writtenRowNumber}`);
            const groupCell = writtenSheet.getCell(`A${writtenRowNumber}`);
            groupCell.value = genderGroup;
            groupCell.font = { bold: true, color: { argb: rank === 0 ? 'FF174A7E' : rank === 1 ? 'FF8C2458' : 'FF5B5B5B' } };
            groupCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rank === 0 ? 'FFDCEEFF' : rank === 1 ? 'FFFCE1EE' : 'FFECECEC' } };
            groupCell.alignment = { vertical: 'middle', horizontal: 'left' };
            for (let col = 1; col <= writtenTotalColumns; col += 1) writtenSheet.getCell(writtenRowNumber, col).border = thinBorder;
            writtenRowNumber += 1;
          }

          const scoreValues = writtenAssignments.map(a => {
            const sub = state.submissions.find(s => String(s.assignment_id) === String(a.id) && String(s.student_id) === String(student.id));
            const preserved = savedClassRecordValue(a, student.id, archivedSnapshots, archivedScores);
            if (a.status === 'archived') return preserved ? preserved.value : '—';
            if (!sub) return preserved ? preserved.value : '—';
            const numericScore = submissionNumericScore(sub);
            if (numericScore !== null) return numericScore;
            return sub.status === 'graded' ? 'Pending' : (sub.auto_score === null || sub.auto_score === undefined ? 'Pending' : Number(sub.auto_score));
          });
          const totalEarned = scoreValues.reduce((sum, value) => typeof value === 'number' && Number.isFinite(value) ? sum + value : sum, 0);
          const row = writtenSheet.getRow(writtenRowNumber);
          row.values = [student.display_name || '', classRecordGenderLabel(student.gender), ...scoreValues, totalEarned];
          row.getCell(writtenTotalScoreColumn).font = { bold: true, color: { argb: 'FF7C2D00' } };
          row.getCell(writtenTotalScoreColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE8D5' } };
          row.height = 22;
          row.eachCell((cell, colNumber) => {
            cell.border = thinBorder;
            cell.alignment = { vertical: 'middle', horizontal: colNumber <= 2 ? 'left' : 'center', wrapText: true };
            if (colNumber >= 3 && colNumber !== writtenTotalScoreColumn) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFAF5' } };
          });
          row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rank === 0 ? 'FFF0F7FF' : rank === 1 ? 'FFFFF1F7' : 'FFF5F5F5' } };
          writtenRowNumber += 1;
        });

        writtenRowNumber += 1;
        writtenSheet.mergeCells(`A${writtenRowNumber}:${writtenLastColumn}${writtenRowNumber}`);
        const writtenLegend = writtenSheet.getCell(`A${writtenRowNumber}`);
        writtenLegend.value = '— = Not submitted   •   Pending = Submitted but not yet scored';
        writtenLegend.font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
        writtenLegend.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        writtenLegend.border = thinBorder;
        writtenSheet.getColumn(1).width = 34;
        writtenSheet.getColumn(2).width = 13;
        for (let col = 3; col <= writtenLastAssignmentColumn; col += 1) writtenSheet.getColumn(col).width = 22;
        writtenSheet.getColumn(writtenTotalScoreColumn).width = 18;
        writtenSheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: writtenTotalColumns } };

        // ----------------------------------------------------------
        // PERFORMANCE TASKS SHEET — deliberately has NO Total Score.
        // ----------------------------------------------------------
        const performanceSheet = workbook.addWorksheet('Performance Tasks', {
          views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }]
        });
        const performanceTotalColumns = Math.max(2, 2 + performanceAssignments.length);
        const performanceLastColumn = performanceSheet.getColumn(performanceTotalColumns).letter;
        styleRecordTitle(performanceSheet, performanceLastColumn, `Mathside Performance Tasks — ${section.name}`, section);
        performanceSheet.mergeCells(`A3:${performanceLastColumn}3`);
        const performanceSummary = performanceSheet.getCell('A3');
        performanceSummary.value = `Performance tasks: ${performanceAssignments.length}   •   Team and class scoring: leader keeps the teacher grade; classmates and group members receive participation-based adjustments (teacher overrides take priority).`;
        performanceSummary.font = { bold: true, color: { argb: 'FF334155' } };
        performanceSummary.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        performanceSummary.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        performanceSheet.getRow(3).height = 34;

        const performanceHeaderRow = performanceSheet.getRow(4);
        performanceHeaderRow.values = [
          'Student Name',
          'Gender',
          ...performanceAssignments.map(a => `${a.title}\n(${totalPoints(a.id)} pts)`)
        ];
        performanceHeaderRow.height = 38;
        performanceHeaderRow.eachCell(cell => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          cell.border = thinBorder;
        });

        let performanceRowNumber = 5;
        let performanceCurrentGroup = null;
        students.forEach(student => {
          const rank = classRecordGenderRank(student.gender);
          const genderGroup = rank === 0 ? 'MALE' : rank === 1 ? 'FEMALE' : 'OTHER / NOT SPECIFIED';
          if (genderGroup !== performanceCurrentGroup) {
            performanceCurrentGroup = genderGroup;
            performanceSheet.mergeCells(`A${performanceRowNumber}:${performanceLastColumn}${performanceRowNumber}`);
            const groupCell = performanceSheet.getCell(`A${performanceRowNumber}`);
            groupCell.value = genderGroup;
            groupCell.font = { bold: true, color: { argb: rank === 0 ? 'FF174A7E' : rank === 1 ? 'FF8C2458' : 'FF5B5B5B' } };
            groupCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rank === 0 ? 'FFDCEEFF' : rank === 1 ? 'FFFCE1EE' : 'FFECECEC' } };
            groupCell.alignment = { vertical: 'middle', horizontal: 'left' };
            for (let col = 1; col <= performanceTotalColumns; col += 1) performanceSheet.getCell(performanceRowNumber, col).border = thinBorder;
            performanceRowNumber += 1;
          }

          const scoreDetails = performanceAssignments.map(a => performanceTaskExportScore(a, student.id, performanceData, archivedScores, archivedSnapshots));
          const row = performanceSheet.getRow(performanceRowNumber);
          row.values = [student.display_name || '', classRecordGenderLabel(student.gender), ...scoreDetails.map(item => item.value)];
          row.height = 22;
          row.eachCell((cell, colNumber) => {
            cell.border = thinBorder;
            cell.alignment = { vertical: 'middle', horizontal: colNumber <= 2 ? 'left' : 'center', wrapText: true };
            if (colNumber >= 3) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFAF5' } };
          });
          scoreDetails.forEach((detail, index) => {
            if (detail.note) row.getCell(index + 3).note = detail.note;
          });
          row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rank === 0 ? 'FFF0F7FF' : rank === 1 ? 'FFFFF1F7' : 'FFF5F5F5' } };
          performanceRowNumber += 1;
        });

        performanceRowNumber += 1;
        performanceSheet.mergeCells(`A${performanceRowNumber}:${performanceLastColumn}${performanceRowNumber}`);
        const performanceLegend = performanceSheet.getCell(`A${performanceRowNumber}`);
        performanceLegend.value = 'Participation deduction: Rating 5 = 0 points • 4 = 2 points • 3 = 3 points • 2 = 4 points • 1 = 5 points. Scores cannot go below 0.';
        performanceLegend.font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
        performanceLegend.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        performanceLegend.border = thinBorder;
        performanceLegend.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        performanceSheet.getRow(performanceRowNumber).height = 32;
        performanceRowNumber += 1;
        performanceSheet.mergeCells(`A${performanceRowNumber}:${performanceLastColumn}${performanceRowNumber}`);
        const statusLegend = performanceSheet.getCell(`A${performanceRowNumber}`);
        statusLegend.value = '— = No team/submission   •   Pending = Leader submission not yet graded   •   Not rated = Leader has not saved that member’s participation rating';
        statusLegend.font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
        statusLegend.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        statusLegend.border = thinBorder;
        statusLegend.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        performanceSheet.getRow(performanceRowNumber).height = 32;
        performanceSheet.getColumn(1).width = 34;
        performanceSheet.getColumn(2).width = 13;
        for (let col = 3; col <= performanceTotalColumns; col += 1) performanceSheet.getColumn(col).width = 22;
        performanceSheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: performanceTotalColumns } };

        // Reference sheet for all work in the class.
        const assignmentSheet = workbook.addWorksheet('Assignments');
        assignmentSheet.columns = [
          { header: 'Type', key: 'type', width: 20 },
          { header: 'Assignment', key: 'assignment', width: 38 },
          { header: 'Items', key: 'items', width: 12 },
          { header: 'Maximum Points', key: 'points', width: 18 },
          { header: 'Deadline', key: 'deadline', width: 24 },
          { header: 'Resubmission', key: 'resubmission', width: 18 }
        ];
        assignmentSheet.getRow(1).height = 26;
        assignmentSheet.getRow(1).eachCell(cell => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          cell.border = thinBorder;
        });
        assignments.forEach(a => {
          const row = assignmentSheet.addRow({
            type: isPerformanceTask(a) ? 'Performance Task' : 'Written Work',
            assignment: a.title,
            items: isPerformanceTask(a) ? 1 : questionsFor(a.id).length,
            points: totalPoints(a.id),
            deadline: a.due_at ? formatFullDate(a.due_at) : 'No deadline',
            resubmission: a.allow_resubmission ? 'Allowed' : 'Not allowed'
          });
          row.eachCell(cell => {
            cell.border = thinBorder;
            cell.alignment = { vertical: 'middle', wrapText: true };
          });
        });
        assignmentSheet.views = [{ state: 'frozen', ySplit: 1 }];

        buffer = await workbook.xlsx.writeBuffer();
      });

      latestClassRecordExport = {
        blob: new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        filename: `Mathside-${safeFilename(section.name)}-Grade-${section.grade_level}-Class-Record-${classRecordTimestamp()}.xlsx`
      };
      showClassRecordReady(section);
      toast('Class record is ready to download.', 'success', 'Export ready');
    } catch (error) {
      console.error('Class record export failed:', error);
      toast(friendlyErrorMessage(error, 'Could not create the Excel class record.'), 'orange', 'Export failed');
    } finally {
      if (exportButton) exportButton.disabled = false;
    }
  }
  document.getElementById('downloadRosterAccountsBtn')?.addEventListener('click', exportRosterAccounts);
  document.getElementById('exportClassRecordBtn')?.addEventListener('click', exportClassRecord);
  document.getElementById('downloadClassRecordExcelBtn')?.addEventListener('click', () => downloadPreparedClassRecord(latestClassRecordExport));

  // ------------------------------------------------------------------
  // PANEL HOOKS + CALENDAR CONTROLS
  // ------------------------------------------------------------------
  document.getElementById('calendarPrevBtn')?.addEventListener('click', () => {
    feature.calendarCursor = new Date(feature.calendarCursor.getFullYear(), feature.calendarCursor.getMonth() - 1, 1);
    feature.calendarSelectedDay = '';
    renderCalendar();
  });
  document.getElementById('calendarNextBtn')?.addEventListener('click', () => {
    feature.calendarCursor = new Date(feature.calendarCursor.getFullYear(), feature.calendarCursor.getMonth() + 1, 1);
    feature.calendarSelectedDay = '';
    renderCalendar();
  });
  document.getElementById('studentCalendarGrid')?.addEventListener('click', event => {
    const day = event.target.closest('[data-calendar-day]');
    if (!day) return;
    const key = day.dataset.calendarDay || '';
    feature.calendarSelectedDay = feature.calendarSelectedDay === key ? '' : key;
    renderCalendar();
  });

  async function renderStudentPanel(panel) {
    if (state.profile?.role !== 'student') return;
    renderTodo();
    if (panel === 'calendar') renderCalendar();
    if (panel === 'feedback') renderFeedbackInbox();
  }

  async function renderTeacherView() {
    if (state.profile?.role !== 'teacher') return;
  }

  async function syncWorkspace() {
    if (!connected() || !state.profile) return;
    if (state.profile.role === 'student') {
      renderTodo();
      renderCalendar();
      renderFeedbackInbox();
    }
  }

  const teacherApp = document.getElementById('teacherApp');
  const studentApp = document.getElementById('studentApp');
  if (teacherApp) new MutationObserver(syncWorkspace).observe(teacherApp, { attributes: true, attributeFilter: ['hidden'] });
  if (studentApp) new MutationObserver(syncWorkspace).observe(studentApp, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('focus', () => syncWorkspace().catch(() => {}));

  window.MathsideV10 = {
    renderStudentPanel,
    renderTeacherView,
    prepareAnswerDraft,
    clearDraft,
    refreshNotifications,
    openNotifications,
    routeNotification,
    exportClassRecord
  };

  // Initial render for sessions restored before this script loaded.
  setTimeout(() => syncWorkspace().catch(() => {}), 0);
})();

/* Mathside V10.8: keep the auth dialog inside the visual viewport while
   the mobile keyboard is open. This is intentionally independent from
   the classroom-feature IIFE above. */
(() => {
  'use strict';

  const root = document.documentElement;
  const mobileQuery = window.matchMedia('(max-width: 760px)');

  function syncVisualViewport(){
    const viewport = window.visualViewport;
    if (viewport) {
      root.style.setProperty('--mathside-vvh', `${Math.max(240, Math.round(viewport.height))}px`);
      root.style.setProperty('--mathside-vv-top', `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    } else {
      root.style.setProperty('--mathside-vvh', `${window.innerHeight}px`);
      root.style.setProperty('--mathside-vv-top', '0px');
    }
  }

  function revealFocusedAuthField(target){
    if (!mobileQuery.matches || !target?.closest?.('#authDialog')) return;
    window.setTimeout(() => {
      try {
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      } catch (_) {
        target.scrollIntoView(false);
      }
    }, 140);
  }

  syncVisualViewport();
  window.addEventListener('resize', syncVisualViewport, { passive: true });
  window.addEventListener('orientationchange', () => window.setTimeout(syncVisualViewport, 120), { passive: true });
  window.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });

  document.addEventListener('focusin', event => revealFocusedAuthField(event.target));

  const authDialog = document.getElementById('authDialog');
  authDialog?.addEventListener('close', () => {
    root.style.removeProperty('--mathside-vv-top');
    syncVisualViewport();
  });
})();


/* Mathside V10.9: keep class-roster management controls collapsed until the
   teacher requests them. This keeps the roster much cleaner on phones. */
(() => {
  'use strict';

  function setupRosterManagementTools(){
    const modal = document.getElementById('classStudentsModal');
    const heading = modal?.querySelector('.roster-modal-heading');
    const actions = modal?.querySelector('.v10-roster-actions');
    const controls = modal?.querySelector('.roster-controls');
    const bulk = document.getElementById('studentBulkToolbar');
    if (!modal || !heading || !actions || !controls || !bulk) return;
    if (document.getElementById('rosterManagementTools')) return;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'rosterToolsToggle';
    toggle.className = 'v10-roster-tools-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'rosterManagementTools');
    toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span>Manage roster</span>';

    const tools = document.createElement('div');
    tools.id = 'rosterManagementTools';
    tools.className = 'v10-roster-management-tools';
    tools.hidden = true;

    heading.appendChild(toggle);
    heading.insertAdjacentElement('afterend', tools);
    tools.append(actions, controls, bulk);

    const setOpen = (open) => {
      tools.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const label = toggle.querySelector('span');
      if (label) label.textContent = open ? 'Hide roster tools' : 'Manage roster';
    };

    toggle.addEventListener('click', () => setOpen(tools.hidden));
    modal.addEventListener('close', () => setOpen(false));

    /* If Add students opens another dialog, close the tools again so returning
       to the roster is clean and focused on the learner list. */
    document.getElementById('rosterAddStudentsBtn')?.addEventListener('click', () => setOpen(false));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupRosterManagementTools, { once: true });
  } else {
    setupRosterManagementTools();
  }
})();
