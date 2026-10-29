/* Mathside V12: archive workflow, class reuse, grouped submissions,
   safer destructive actions, and mobile quality-of-life updates. */
(() => {
  'use strict';

  const archiveState = {
    assignmentIds: [],
    classId: null,
    deleteClassId: null,
    clearSubmissionId: null,
  };

  const activeSections = () => (state.sections || []).filter(section => !section.archived_at);
  const archivedSections = () => (state.sections || []).filter(section => Boolean(section.archived_at));
  const isArchivedAssignment = assignment => assignment?.status === 'archived';
  const safeSheetName = (value, fallback = 'Activity') => {
    const cleaned = String(value || fallback).replace(/[\\/?*\[\]:]/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
    return cleaned.slice(0, 31);
  };
  const archiveFileName = value => String(value || 'Mathside').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'Mathside';
  const nowStamp = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  };

  // ---------------------------------------------------------------
  // PASSWORD VISIBILITY
  // ---------------------------------------------------------------
  const passwordInput = document.getElementById('authPasswordInput');
  const passwordToggle = document.getElementById('toggleAuthPassword');
  passwordToggle?.addEventListener('click', () => {
    if (!passwordInput) return;
    const reveal = passwordInput.type === 'password';
    passwordInput.type = reveal ? 'text' : 'password';
    passwordToggle.setAttribute('aria-pressed', reveal ? 'true' : 'false');
    passwordToggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    passwordToggle.classList.toggle('is-visible', reveal);
  });

  // ---------------------------------------------------------------
  // CLASS HELPERS / RENDERING
  // ---------------------------------------------------------------
  classCard = function(section, dashboard = false) {
    const studentCount = studentsForSection(section.id).length;
    const sectionAssignments = state.assignments.filter(a => a.section_id === section.id);
    const activeAssignmentCount = sectionAssignments.filter(a => a.status !== 'archived').length;
    const archivedAssignmentCount = sectionAssignments.filter(a => a.status === 'archived').length;
    const archived = Boolean(section.archived_at);
    return `<article class="class-card ${archived ? 'class-card-archived' : ''}" data-class-card-id="${section.id}" ${dashboard ? 'data-dashboard-class="true"' : ''}>
      <div class="class-card-top">
        <div class="class-card-heading">
          <span class="class-icon">${iconSvg('class', 'class-card-icon')}</span>
          <div class="class-card-copy"><small>${archived ? 'ARCHIVED CLASS' : 'CLASS'}</small><h3 title="${esc(section.name)}">${esc(section.name)}</h3></div>
        </div>
        <span class="grade-pill">Grade ${esc(section.grade_level)}</span>
      </div>
      <footer><span><b>${studentCount}</b> student${studentCount === 1 ? '' : 's'}</span><span>${activeAssignmentCount} active${archivedAssignmentCount ? ` · ${archivedAssignmentCount} archived` : ''}</span></footer>
      <div class="class-card-actions">
        <button class="btn btn-light class-view-students-btn" type="button" data-view-class-students="${section.id}">${iconSvg('people', 'btn-icon')}View students</button>
        ${dashboard ? '' : `${archived
          ? `<button class="btn btn-unarchive" type="button" data-unarchive-class="${section.id}">Unarchive</button><button class="btn btn-light" type="button" data-create-from-archive="${section.id}">Reuse students</button>`
          : `<button class="btn btn-danger-outline" type="button" data-archive-class="${section.id}">Archive class</button>`}
          <button class="btn btn-danger" type="button" data-delete-class="${section.id}">Delete class</button>`}
      </div>
    </article>`;
  };

  renderClasses = function() {
    const grid = $('#classGrid');
    if (!grid) return;
    const active = activeSections();
    grid.innerHTML = active.length
      ? `<div class="class-grid-group">${active.map(section => classCard(section)).join('')}</div>`
      : `<div class="class-empty"><span>${iconSvg('class', 'empty-icon')}</span><h3>No active classes</h3><p>Create a class for the current term. Archived classes are available in the Archived panel.</p><button class="btn btn-orange" data-empty-create-class>Create class</button></div>`;
  };

  function populateArchivedImportOptions(preselect = '') {
    const select = document.getElementById('importArchivedSection');
    if (!select) return;
    const sources = [...(state.sections || [])].sort((a,b) => {
      const aa = a.archived_at ? 1 : 0, bb = b.archived_at ? 1 : 0;
      if (aa !== bb) return aa - bb;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    select.innerHTML = `<option value="">No — start with an empty class</option>` + sources.map(section => {
      const status = section.archived_at ? 'Archived' : 'Active';
      return `<option value="${section.id}">${esc(section.name)} · Grade ${esc(section.grade_level)} · ${studentsForSection(section.id).length} students · ${status}</option>`;
    }).join('');
    if (preselect && sources.some(section => section.id === preselect)) select.value = preselect;
  }

  populateAssignmentSections = function() {
    const list = $('#assignmentSectionChecklist');
    if (!list) return;
    const sections = activeSections();
    if (!sections.length) {
      list.innerHTML = '<p class="class-checklist-empty">Create an active class first.</p>';
      return;
    }
    list.innerHTML = sections.map((section, index) => `
      <label class="class-check-option">
        <input type="checkbox" name="assignment_sections" value="${section.id}" ${sections.length === 1 && index === 0 ? 'checked' : ''}>
        <span><b>${esc(section.name)}</b><small>Grade ${esc(section.grade_level)}</small></span>
      </label>`).join('');
  };

  renderTeacher = function() {
    const active = activeSections();
    const activeIds = new Set(active.map(section => section.id));
    const uniqueStudents = new Set(state.members.filter(m => activeIds.has(m.section_id)).map(m => m.student_id)).size;
    $('#studentTotal').textContent = uniqueStudents;
    $('#classTotal').textContent = active.length;
    $('#assignmentTotal').textContent = groupedAssignmentsForDisplay().filter(group => group.some(a => a.status !== 'archived')).length;
    $('#dashboardClassGrid').innerHTML = active.length
      ? active.map(section => classCard(section, true)).join('')
      : `<div class="class-empty"><span>${iconSvg('class', 'empty-icon')}</span><h3>No active classes yet</h3><p>Create your current-term class or reuse students from an archived class.</p><button class="btn btn-orange" data-empty-create-class>Create class</button></div>`;
    renderClasses();
    renderAssignments();
    renderSubmissions();
    populateAssignmentSections();
    populateArchivedImportOptions();
    window.renderArchiveCenter?.();
  };

  document.addEventListener('click', event => {
    const reuse = event.target.closest('[data-create-from-archive]');
    if (reuse) {
      $('#sectionForm')?.reset();
      if ($('#sectionGrade')) $('#sectionGrade').value = String(sectionById(reuse.dataset.createFromArchive)?.grade_level || 7);
      populateArchivedImportOptions(reuse.dataset.createFromArchive);
      openDialog('sectionModal');
      return;
    }
    const create = event.target.closest('#createClassBtn, #dashboardCreateClass, [data-empty-create-class]');
    if (create) setTimeout(() => populateArchivedImportOptions(), 0);
  });

  // Capture the class form submit so the existing handler does not create a duplicate.
  document.getElementById('sectionForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!requireSupabase()) return;
    const formElement = event.currentTarget;
    const submitBtn = formElement.querySelector('button[type="submit"]');
    const form = new FormData(formElement);
    const grade = Number(form.get('grade_level'));
    const name = String(form.get('name') || '').trim();
    const sourceSectionId = String(form.get('import_archived_section') || '').trim();
    const colors = { 7:'#ff6b00', 8:'#ff8f00', 9:'#ff4f81', 10:'#3e8ef7', 11:'#7b61c8', 12:'#2c9c78' };
    if (!name) return toast('Enter a class name.', 'orange');
    if (!window.MathsideActionButton?.start(submitBtn, 'Creating…')) return;
    try {
      let created;
      await withLoading('Creating class…', sourceSectionId ? 'Creating the class and enrolling existing student accounts.' : `Setting up ${name} for Grade ${grade}.`, async () => {
        const { data, error } = await db.from('mathside_sections').insert({
          teacher_id: state.user.id,
          grade_level: grade,
          name,
          color: colors[grade] || '#ff6b00'
        }).select().single();
        if (error) throw error;
        created = data;
        if (sourceSectionId) {
          const { data: imported, error: importError } = await db.rpc('mathside_import_archived_students', {
            p_source_section_id: sourceSectionId,
            p_target_section_id: data.id
          });
          if (importError) throw importError;
          data.imported_count = Number(imported || 0);
        }
        activeSectionId = data.id;
        await refreshTeacher();
        showTeacherView('classes');
      });
      await window.MathsideActionButton.done(submitBtn, 'Done');
      closeDialog('sectionModal');
      toast(sourceSectionId ? `Class created. ${Number(created?.imported_count || 0)} existing student account${Number(created?.imported_count || 0) === 1 ? '' : 's'} enrolled.` : 'Class created.', 'success');
    } catch (error) {
      window.MathsideActionButton?.reset(submitBtn);
      console.error(error);
      toast(friendlyErrorMessage(error, 'Could not create the class.'), 'orange');
    }
  }, true);

  
// ---------------------------------------------------------------
  // ASSIGNMENT RENDERING + ARCHIVE ACTIONS
  // ---------------------------------------------------------------
  updateAssignmentBulkToolbar = function() {
    const validIds = state.assignments.map(assignment => assignment.id);
    [...selectedAssignmentIds].forEach(id => { if (!validIds.includes(id)) selectedAssignmentIds.delete(id); });
    const groups = groupedAssignmentsForDisplay();
    const selectedGroups = groups.filter(group => group.length && group.every(assignment => selectedAssignmentIds.has(assignment.id)));
    const count = selectedGroups.length;
    $('#selectedAssignmentCount') && ($('#selectedAssignmentCount').textContent = `${count} selected`);
    $('#bulkDeleteAssignmentsBtn') && ($('#bulkDeleteAssignmentsBtn').disabled = count === 0);
    $('#bulkArchiveAssignmentsBtn') && ($('#bulkArchiveAssignmentsBtn').disabled = count === 0 || !selectedGroups.some(group => group.some(a => a.status !== 'archived')));
    $('#bulkUnarchiveAssignmentsBtn') && ($('#bulkUnarchiveAssignmentsBtn').disabled = count === 0 || !selectedGroups.some(group => group.some(a => a.status === 'archived')));
    const selectAll = $('#selectAllAssignments');
    if (selectAll) {
      selectAll.checked = count > 0 && count === groups.length;
      selectAll.indeterminate = count > 0 && count < groups.length;
    }
  };

  renderAssignments = function() {
    const list = $('#assignmentList');
    if (!list) return;
    if (!state.assignments.length) {
      selectedAssignmentIds.clear();
      list.innerHTML = `<div class="assignment-empty v9-empty"><span class="v9-empty-icon" aria-hidden="true">${iconSvg('assignment','assignment-line-icon')}</span><b>No assignments yet</b><p>Create your first Mathematics activity to get started.</p><button class="btn btn-orange" type="button" data-v9-new-assignment>＋ New assignment</button></div>`;
      return;
    }
    const groups = groupedAssignmentsForDisplay();
    const cards = groups.map(group => {
      const assignment = group[0];
      const groupIds = group.map(item => item.id);
      const groupIdsAttr = groupIds.join(',');
      const sectionLabels = assignmentGroupSectionLabels(group);
      const questions = questionsFor(assignment.id);
      const missingAnswers = questions.filter(question => !(keyFor(question.id)?.correct_answer || '').trim()).length;
      const scheduled = assignment.status === 'draft' && assignment.publish_at && new Date(assignment.publish_at).getTime() > Date.now();
      const archived = group.every(item => item.status === 'archived');
      const selected = group.every(item => selectedAssignmentIds.has(item.id));
      const classSummary = sectionLabels.length === 1 ? `<span class="meta-chip">${esc(sectionLabels[0])}</span>` : `<span class="meta-chip assignment-group-count">${sectionLabels.length} classes</span>`;
      const classList = sectionLabels.length > 1 ? `<div class="assignment-class-list" aria-label="Classes">${sectionLabels.map(label => `<span>${esc(label)}</span>`).join('')}</div>` : '';
      return `<article class="assignment-card assignment-group-card ${selected ? 'is-selected' : ''} ${scheduled ? 'assignment-scheduled' : ''} ${archived ? 'assignment-archived' : ''}">
        <label class="assignment-select-check"><input class="row-check" type="checkbox" data-select-assignment="${assignment.id}" data-assignment-group-ids="${esc(groupIdsAttr)}" ${selected ? 'checked' : ''}><span class="sr-only">Select ${esc(assignment.title)}</span></label>
        <div class="assignment-thumb">${assignment.image_url ? `<img src="${esc(assignment.image_url)}" alt="Assignment image" data-assignment-storage-path="${esc(assignment.image_path || '')}">` : iconSvg('assignment', 'assignment-line-icon')}</div>
        <div class="assignment-card-body"><div class="assignment-title-line"><h3>${esc(assignment.title)}</h3>${group.length > 1 ? '<span class="shared-assignment-badge">Shared assignment</span>' : ''}${scheduled ? '<span class="scheduled-badge">Scheduled</span>' : ''}${archived ? '<span class="archived-badge">Archived</span>' : ''}</div><p>${esc(assignment.instructions || 'Mathematics assignment')}</p>${classList}<div class="assignment-meta">${classSummary}${scheduled ? `<span class="meta-chip scheduled-chip">Posts ${esc(formatDeadlineDate(assignment.publish_at))}</span>` : ''}${missingAnswers ? `<span class="meta-chip answer-key-warning">${missingAnswers} answer${missingAnswers===1?'':'s'} pending</span>` : ''}</div></div>
        <div class="assignment-card-actions"><button class="btn btn-light" data-preview-assignment="${assignment.id}">Preview</button>${archived ? `<button class="btn btn-unarchive" data-unarchive-assignment-group="${esc(groupIdsAttr)}">Unarchive</button>` : `<button class="btn btn-light" data-edit-assignment="${assignment.id}">Edit</button><button class="btn btn-archive" data-archive-assignment-group="${esc(groupIdsAttr)}">Archive</button>`}<button class="btn btn-danger-outline" data-delete-assignment-group="${esc(groupIdsAttr)}">Delete</button></div>
      </article>`;
    }).join('');
    list.innerHTML = `<div class="bulk-toolbar assignment-bulk-toolbar"><label class="bulk-select-all"><input id="selectAllAssignments" class="row-check" type="checkbox"><span>Select all activities</span></label><span class="bulk-selected-count" id="selectedAssignmentCount">0 selected</span><div class="bulk-actions"><button class="btn btn-archive" id="bulkArchiveAssignmentsBtn" type="button" disabled>Archive selected</button><button class="btn btn-unarchive" id="bulkUnarchiveAssignmentsBtn" type="button" disabled>Unarchive selected</button><button class="btn btn-danger" id="bulkDeleteAssignmentsBtn" type="button" disabled>Delete selected</button></div></div>${cards}`;
    updateAssignmentBulkToolbar();
  };

  // ---------------------------------------------------------------
  // EXCEL ARCHIVE
  // ---------------------------------------------------------------
  function archiveBorders() {
    return {
      top: { style: 'thin', color: { argb: 'FFD8C7B8' } },
      left: { style: 'thin', color: { argb: 'FFD8C7B8' } },
      bottom: { style: 'thin', color: { argb: 'FFD8C7B8' } },
      right: { style: 'thin', color: { argb: 'FFD8C7B8' } }
    };
  }

  function styleHeaderRow(row, fill = 'FF2E2118') {
    row.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = archiveBorders();
    });
  }

  function downloadWorkbook(workbook, filename) {
    return workbook.xlsx.writeBuffer().then(buffer => {
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  async function buildArchiveWorkbook(assignmentIds, archiveLabel = 'Activity Archive') {
    if (!window.ExcelJS) throw new Error('Excel export could not load. Check your internet connection and try again.');
    const assignments = assignmentIds.map(assignmentById).filter(Boolean);
    const allPerformance = assignments.length > 0 && assignments.every(isPerformanceTask);
    const recordSingular = allPerformance ? 'performance task' : 'activity';
    const recordPlural = allPerformance ? 'performance tasks' : 'activities';
    if (!assignments.length) throw new Error(`No ${recordPlural} were found to archive.`);
    const submissionIds = state.submissions.filter(s => assignmentIds.includes(s.assignment_id)).map(s => s.id);
    const answerRows = [];
    // Archive backups must contain all answer rows, even when more than
    // 1,000 answers have been submitted across a large class.
    for (let i = 0; i < submissionIds.length; i += 40) {
      const batchIds = submissionIds.slice(i, i + 40);
      for (let offset = 0;; offset += 400) {
        const { data, error } = await db.from('mathside_submission_answers')
          .select('*').in('submission_id', batchIds)
          .order('id', { ascending: true }).range(offset, offset + 399);
        if (error) throw error;
        const batch = data || [];
        answerRows.push(...batch);
        if (batch.length < 400) break;
      }
    }
    const answersBySubmission = new Map();
    answerRows.forEach(answer => {
      if (!answersBySubmission.has(answer.submission_id)) answersBySubmission.set(answer.submission_id, []);
      answersBySubmission.get(answer.submission_id).push(answer);
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Mathside';
    workbook.created = new Date();
    const general = workbook.addWorksheet('General', { views: [{ state: 'frozen', ySplit: 4 }] });
    general.mergeCells('A1:J1');
    general.getCell('A1').value = `MATHSIDE — ${archiveLabel.toUpperCase()}`;
    general.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    general.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
    general.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };
    general.mergeCells('A2:J2');
    general.getCell('A2').value = `Archived ${new Date().toLocaleString()} · ${assignments.length} ${recordSingular} record${assignments.length === 1 ? '' : 's'}`;
    general.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE8D5' } };
    general.getCell('A2').font = { bold: true, color: { argb: 'FF7C2D00' } };
    const gh = general.getRow(4);
    gh.values = ['Section', 'Grade', allPerformance ? 'Performance Task' : 'Activity', 'Items', 'Total Points', 'Students', 'Submitted', 'Graded', 'Total Earned Scores', 'Average Final Score'];
    styleHeaderRow(gh);
    let grow = 5;
    const usedSheetNames = new Set(['General']);

    for (const assignment of assignments) {
      const section = sectionById(assignment.section_id);
      const questions = questionsFor(assignment.id).sort((a,b) => Number(a.position||0)-Number(b.position||0));
      const subs = state.submissions.filter(s => s.assignment_id === assignment.id);
      const sectionStudents = studentsForSection(assignment.section_id);
      const scored = subs.map(s => Number(s.teacher_score ?? s.auto_score ?? 0)).filter(Number.isFinite);
      const avg = scored.length ? scored.reduce((a,b)=>a+b,0)/scored.length : null;
      const row = general.getRow(grow++);
      row.values = [section?.name || '', section?.grade_level || '', assignment.title || '', questions.length, totalPoints(assignment.id), sectionStudents.length, subs.length, subs.filter(s => s.status === 'graded').length, scored.reduce((sum, value) => sum + value, 0), avg == null ? '' : Number(avg.toFixed(2))];
      row.eachCell(cell => { cell.border = archiveBorders(); cell.alignment = { vertical: 'middle', wrapText: true }; });

      let baseName = safeSheetName(`${section?.name || 'Class'} - ${assignment.title || (allPerformance ? 'Performance Task' : 'Activity')}`);
      let sheetName = baseName;
      let n = 2;
      while (usedSheetNames.has(sheetName)) sheetName = safeSheetName(`${baseName.slice(0,26)} ${n++}`);
      usedSheetNames.add(sheetName);
      const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }] });
      const fixedCols = ['Student Name','Gender','Submission Status','Auto Score','Teacher Score','Final Score','Attempt','Submitted At','Feedback'];
      const questionCols = questions.flatMap((q, i) => [`Q${i+1} Answer`,`Q${i+1} Result`,`Q${i+1} Points`]);
      const allCols = [...fixedCols, ...questionCols];
      sheet.mergeCells(1,1,1,allCols.length);
      const title = sheet.getCell(1,1);
      title.value = assignment.title || (allPerformance ? 'Performance Task' : 'Activity');
      title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
      title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B00' } };
      sheet.mergeCells(2,1,2,allCols.length);
      sheet.getCell(2,1).value = `${sectionLabel(section)} · ${questions.length} item${questions.length===1?'':'s'} · ${totalPoints(assignment.id)} total points · Status: ${assignment.status}`;
      sheet.getCell(2,1).font = { bold: true, color: { argb: 'FF7C2D00' } };
      sheet.getCell(2,1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE8D5' } };
      sheet.mergeCells(3,1,3,allCols.length);
      sheet.getCell(3,1).value = assignment.instructions || 'No instructions';
      sheet.getCell(3,1).alignment = { wrapText: true };
      const header = sheet.getRow(5);
      header.values = allCols;
      styleHeaderRow(header);
      let r = 6;
      const orderedStudents = [...sectionStudents].sort((a,b) => String(a.display_name||'').localeCompare(String(b.display_name||''), undefined, { sensitivity:'base' }));
      for (const student of orderedStudents) {
        const sub = subs.find(s => s.student_id === student.id);
        const ans = sub ? (answersBySubmission.get(sub.id) || []) : [];
        const finalScore = sub ? Number(sub.teacher_score ?? sub.auto_score ?? 0) : '';
        const values = [
          student.display_name || '', student.gender || 'Not specified', sub ? sub.status : 'Not submitted',
          sub ? Number(sub.auto_score || 0) : '', sub?.teacher_score ?? '', finalScore,
          sub ? Number(sub.attempt_count || 1) : '', sub?.submitted_at ? new Date(sub.submitted_at).toLocaleString() : '', sub?.feedback || ''
        ];
        questions.forEach(q => {
          const a = ans.find(x => x.question_id === q.id);
          const effectiveCorrect = a?.manual_is_correct !== null && a?.manual_is_correct !== undefined ? Boolean(a.manual_is_correct) : Boolean(a?.is_correct);
          values.push(a?.answer_text || '', a ? (effectiveCorrect ? 'Correct' : 'Wrong') : '', a ? Number(effectiveCorrect ? q.max_points || 0 : 0) : '');
        });
        const dataRow = sheet.getRow(r++);
        dataRow.values = values;
        dataRow.eachCell(cell => { cell.border = archiveBorders(); cell.alignment = { vertical:'top', wrapText:true }; });
      }
      sheet.getColumn(1).width = 30;
      sheet.getColumn(2).width = 14;
      sheet.getColumn(3).width = 18;
      sheet.getColumn(9).width = 38;
      for (let c=10;c<=allCols.length;c++) sheet.getColumn(c).width = (c-10)%3===0 ? 24 : 13;
    }
    [1,2,3,4,5,6,7,8,9,10].forEach((_,i) => general.getColumn(i+1).width = [24,10,34,10,14,12,12,10,20,20][i]);
    return workbook;
  }

  // V24.12 — Queue-aware cleanup. Retain failed paths in Supabase so a
  // network interruption cannot silently leak the uploaded student files.
  async function finishArchivedStorageCleanup({ notify = false } = {}) {
    const { data: pending, error: listError } = await db
      .from('mathside_archive_cleanup_queue')
      .select('id, object_path')
      .order('created_at', { ascending: true })
      .limit(1000);
    if (listError) throw listError;
    if (!pending?.length) {
      if (notify) toast('There are no pending student files to delete.', 'success', 'Storage clean');
      return 0;
    }
    let failed = 0;
    // Supabase Storage removes up to 100 object paths per request.
    for (let start = 0; start < pending.length; start += 90) {
      const batch = pending.slice(start, start + 90);
      const paths = [...new Set(batch.map(row => row.object_path).filter(Boolean))];
      if (!paths.length) continue;
      const result = await db.storage.from('mathside-submission-proofs').remove(paths);
      if (result.error) {
        console.warn('Mathside archive storage cleanup failed:', result.error);
        failed += batch.length;
        continue;
      }
      // A successful Storage remove request also covers objects that were
      // already missing from a previous partial cleanup attempt.
      const ids = batch.map(row => row.id);
      if (ids.length) {
        const { error: clearError } = await db.from('mathside_archive_cleanup_queue').delete().in('id', ids);
        if (clearError) throw clearError;
      }
    }
    if (failed && notify) toast(`${failed} file cleanup item(s) still need attention. Tap Retry file cleanup again.`, 'orange', 'Cleanup incomplete');
    else if (notify) toast('Archived student files were removed from Supabase Storage.', 'success', 'Cleanup complete');
    return failed;
  }

  $('#retryArchiveCleanupBtn')?.addEventListener('click', async () => {
    const btn = $('#retryArchiveCleanupBtn');
    if (btn?.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Cleaning…'; }
    try { await finishArchivedStorageCleanup({ notify: true }); }
    catch (error) { console.error(error); toast(friendlyErrorMessage(error, 'Could not complete file cleanup.'), 'orange', 'Cleanup failed'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Retry file cleanup'; } }
  });

  const archiveAck = $('#archiveDeletionAck');
  archiveAck?.addEventListener('change', () => {
    const confirm = $('#confirmArchiveAssignmentBtn');
    if (confirm) confirm.disabled = !archiveAck.checked;
  });

  function openArchiveAssignments(ids) {
    const valid = [...new Set((ids || []).filter(id => assignmentById(id) && assignmentById(id).status !== 'archived'))];
    const assignments = valid.map(id => assignmentById(id)).filter(Boolean);
    const allPerformance = assignments.length > 0 && assignments.every(isPerformanceTask);
    if (!valid.length) return toast(allPerformance ? 'The selected performance task is already archived.' : 'The selected activity is already archived.', 'orange');
    archiveState.assignmentIds = valid;
    const first = assignments[0];
    const kindSingular = allPerformance ? 'performance task' : 'activity';
    const kindPlural = allPerformance ? 'performance tasks' : 'activities';
    const title = valid.length === 1 ? first?.title || (allPerformance ? 'Performance Task' : 'Activity') : `${valid.length} ${kindPlural}`;
    const modal = $('#archiveAssignmentModal');
    const eyebrow = $('.eyebrow', modal);
    const warning = $('.archive-warning span', modal);
    if (eyebrow) eyebrow.textContent = allPerformance ? 'ARCHIVE PERFORMANCE TASK' : 'ARCHIVE ACTIVITY';
    if (warning) warning.textContent = allPerformance
      ? 'Archiving keeps student submissions, graded scores, feedback, group assignments, and uploaded file references. An Excel backup downloads first.'
      : 'Archiving keeps student answers, grades, feedback and uploaded solution file references. An Excel backup downloads first.';
    if (archiveAck) archiveAck.checked = false;
    if ($('#confirmArchiveAssignmentBtn')) $('#confirmArchiveAssignmentBtn').disabled = true;
    $('#archiveAssignmentTitle').textContent = `Archive ${title}?`;
    $('#archiveAssignmentText').textContent = valid.length === 1
      ? `Mathside will download an Excel backup of “${first?.title || `this ${kindSingular}`}”, preserve each student’s Class Record score/status, then retain all student submissions.`
      : `Mathside will download one Excel backup for ${valid.length} selected ${kindSingular} records while retaining their submissions.`;
    openDialog('archiveAssignmentModal');
  }

  async function unarchiveAssignments(ids) {
    const stayInArchive = Boolean($('#view-archive')?.classList.contains('active'));
    const valid = [...new Set((ids || []).filter(id => assignmentById(id)?.status === 'archived'))];
    if (!valid.length) return toast('The selected activity is already active.', 'orange');
    const assignments = valid.map(id => assignmentById(id)).filter(Boolean);
    const allPerformance = assignments.length > 0 && assignments.every(isPerformanceTask);
    const targetView = allPerformance ? 'performance' : 'assignments';
    try {
      await withLoading(
        allPerformance ? 'Unarchiving performance task…' : 'Unarchiving activity…',
        'Restoring the task only. Old submissions, proof files, and feedback cannot be recovered; saved Class Record scores and statuses stay in Excel export.',
        async () => {
          const now = Date.now();
          const scheduledIds = assignments
            .filter(a => a.publish_at && new Date(a.publish_at).getTime() > now)
            .map(a => a.id);
          const publishedIds = assignments
            .filter(a => !scheduledIds.includes(a.id))
            .map(a => a.id);
          if (scheduledIds.length) {
            const { error } = await db.from('mathside_assignments')
              .update({ status: 'draft', archived_at: null })
              .in('id', scheduledIds);
            if (error) throw error;
          }
          if (publishedIds.length) {
            const { error } = await db.from('mathside_assignments')
              .update({ status: 'published', archived_at: null })
              .in('id', publishedIds);
            if (error) throw error;
          }
          valid.forEach(id => selectedAssignmentIds.delete(id));
          await refreshTeacher();
          showTeacherView(stayInArchive ? 'archive' : targetView);
        }
      );
      toast(
        allPerformance ? 'Performance task restored without old submissions. Saved scores remain in Class Record export.' : 'Activity restored without old submissions. Saved scores remain in Class Record export.',
        'success',
        'Unarchived'
      );
    } catch (error) {
      console.error(error);
      toast(friendlyErrorMessage(error, 'Could not unarchive the selected activity.'), 'orange', 'Unarchive failed');
    }
  }

  document.addEventListener('click', event => {
    const unarchive = event.target.closest('[data-unarchive-assignment-group]');
    if (unarchive) return unarchiveAssignments(String(unarchive.dataset.unarchiveAssignmentGroup || '').split(',').filter(Boolean));
    if (event.target.closest('#bulkUnarchiveAssignmentsBtn')) {
      const ids = [...selectedAssignmentIds].filter(id => assignmentById(id)?.status === 'archived');
      return unarchiveAssignments(ids);
    }
    const button = event.target.closest('[data-archive-assignment-group]');
    if (button) return openArchiveAssignments(String(button.dataset.archiveAssignmentGroup || '').split(',').filter(Boolean));
    if (event.target.closest('#bulkArchiveAssignmentsBtn')) {
      const ids = [...selectedAssignmentIds].filter(id => assignmentById(id)?.status !== 'archived');
      openArchiveAssignments(ids);
    }
  });

  $('#confirmArchiveAssignmentBtn')?.addEventListener('click', async () => {
    const ids = archiveState.assignmentIds.filter(id => assignmentById(id)?.status !== 'archived');
    if (!ids.length) return closeDialog('archiveAssignmentModal');
    if (!state.archiveHistoryAvailable) {
      return toast('Archive paused to protect students’ submission counts. Run supabase/sql/05-grade-and-archive-retention.sql in Supabase, then reload Mathside before archiving.', 'orange', 'Install progress history first');
    }
    // Archiving is now non-destructive. No irreversible deletion acknowledgement is required.
    // Never allow destructive archiving using an older RPC that does not
    // snapshot ALL class-record values (including auto-scored written work).
    let retentionVersion = null;
    try {
      const { data, error } = await db.rpc('mathside_class_record_retention_version');
      if (!error) retentionVersion = data;
    } catch (guardError) {
      console.warn('Class Record archive protection verification failed:', guardError);
    }
    if (retentionVersion !== 'class-record-retention-v1') {
      return toast('Archiving paused to protect your Excel class record. First run supabase/sql/05-grade-and-archive-retention.sql in Supabase, then reload Mathside.', 'orange', 'Class Record protection required');
    }
    const assignments = ids.map(id => assignmentById(id)).filter(Boolean);
    const allPerformance = assignments.length > 0 && assignments.every(isPerformanceTask);
    const kindSingular = allPerformance ? 'performance task' : 'activity';
    const targetView = allPerformance ? 'performance' : 'assignments';
    try {
      closeDialog('archiveAssignmentModal');
      await withLoading(
        allPerformance ? 'Archiving performance task…' : 'Archiving activity…',
        'Downloading an Excel backup and preserving student submissions and all grades.',
        async () => {
          const workbook = await buildArchiveWorkbook(ids, allPerformance ? 'Performance Task Archive' : 'Activity Archive');
          const first = assignments[0];
          await downloadWorkbook(workbook, `Mathside-Archive-${archiveFileName(first?.title || (allPerformance ? 'Performance-Task' : 'Activities'))}-${nowStamp()}.xlsx`);
          // Non-destructive archive: all submissions, answers and files are retained.
          const { data: archivedResult, error } = await db.rpc('mathside_archive_assignments_clean', { p_assignment_ids: ids });
          if (error) {
            if (String(error.code) === 'PGRST202' || String(error.message || '').includes('mathside_archive_assignments_clean'))
              throw new Error('Install supabase/sql/05-grade-and-archive-retention.sql in your Mathside Supabase project first. No work was deleted.');
            throw error;
          }
          selectedAssignmentIds.clear();
          archiveState.assignmentIds = [];
          const remainingCleanup = 0; // No archive file deletion.
          await refreshTeacher();
          showTeacherView(targetView);
          toast('Archive complete. All submissions, grades and files remain available.', 'success');
        }
      );
    } catch (error) {
      console.error(error);
      toast(friendlyErrorMessage(error, `Could not archive the selected ${kindSingular}.`), 'orange', 'Archive failed');
    }
  });

  // ---------------------------------------------------------------
  // CLASS UNARCHIVING
  // ---------------------------------------------------------------
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-unarchive-class]');
    if (!button) return;
    const section = sectionById(button.dataset.unarchiveClass);
    if (!section || !section.archived_at) return;
    if (!window.MathsideActionButton?.start(button, 'Restoring…')) return;
    try {
      await withLoading('Unarchiving class…', 'Restoring the class to the active Classes panel while keeping its student roster.', async () => {
        const { error } = await db.from('mathside_sections')
          .update({ archived_at: null })
          .eq('id', section.id)
          .eq('teacher_id', state.user.id);
        if (error) throw error;
        await refreshTeacher();
        showTeacherView('archive');
      });
      await window.MathsideActionButton.done(button, 'Done');
      toast('Class restored to the Classes panel.', 'success', 'Class unarchived');
    } catch (error) {
      window.MathsideActionButton?.reset(button);
      console.error(error);
      toast(friendlyErrorMessage(error, 'Could not unarchive this class.'), 'orange', 'Unarchive failed');
    }
  });

  // ---------------------------------------------------------------
  // CLASS ARCHIVING
  // ---------------------------------------------------------------
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-archive-class]');
    if (!button) return;
    const section = sectionById(button.dataset.archiveClass);
    if (!section || section.archived_at) return;
    archiveState.classId = section.id;
    const assignments = state.assignments.filter(a => a.section_id === section.id);
    $('#archiveClassTitle').textContent = `Archive ${section.name}?`;
    $('#archiveClassText').textContent = `${sectionLabel(section)} has ${studentsForSection(section.id).length} students and ${assignments.length} activity record${assignments.length === 1 ? '' : 's'}. An Excel backup will download before Mathside removes the activities.`;
    openDialog('archiveClassModal');
  });

  $('#confirmArchiveClassBtn')?.addEventListener('click', async () => {
    const section = sectionById(archiveState.classId);
    if (!section || section.archived_at) return closeDialog('archiveClassModal');
    const ids = state.assignments.filter(a => a.section_id === section.id).map(a => a.id);
    try {
      closeDialog('archiveClassModal');
      await withLoading('Archiving class…', 'Saving the class record, deleting class activities, and preserving student accounts.', async () => {
        if (ids.length) {
          const workbook = await buildArchiveWorkbook(ids, `${section.name} Class Archive`);
          await downloadWorkbook(workbook, `Mathside-Class-Archive-${archiveFileName(section.name)}-Grade-${section.grade_level}-${nowStamp()}.xlsx`);
        } else if (window.ExcelJS) {
          const workbook = new ExcelJS.Workbook();
          const sheet = workbook.addWorksheet('General');
          sheet.addRow(['Mathside Class Archive', section.name]);
          sheet.addRow(['Grade', section.grade_level]);
          sheet.addRow(['Students', studentsForSection(section.id).length]);
          sheet.addRow(['Activities', 0]);
          await downloadWorkbook(workbook, `Mathside-Class-Archive-${archiveFileName(section.name)}-Grade-${section.grade_level}-${nowStamp()}.xlsx`);
        }
        if (ids.length) {
          const { data: sessionData, error: sessionError } = await db.auth.getSession();
          if (sessionError) throw sessionError;
          const accessToken = sessionData?.session?.access_token;
          if (!accessToken) throw new Error('Your teacher session has expired. Please sign in again.');
          for (const assignmentId of ids) {
            await deleteAssignmentThroughFunction(assignmentId, accessToken);
          }
        }
        const { error } = await db.rpc('mathside_archive_class', { p_section_id: section.id });
        if (error) throw error;
        archiveState.classId = null;
        activeSectionId = null;
        await refreshTeacher();
        showTeacherView('classes');
      });
      toast('Class archived. Student accounts were kept and can be reused in a new class.', 'success', 'Class archived');
    } catch (error) {
      console.error(error);
      toast(friendlyErrorMessage(error, 'Could not archive this class.'), 'orange', 'Archive failed');
    }
  });

  // ---------------------------------------------------------------
  // PERMANENT CLASS DELETION
  // ---------------------------------------------------------------
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-delete-class]');
    if (!button) return;
    const section = sectionById(button.dataset.deleteClass);
    if (!section) return;
    archiveState.deleteClassId = section.id;
    const assignments = state.assignments.filter(a => a.section_id === section.id);
    const studentCount = studentsForSection(section.id).length;
    $('#deleteClassTitle').textContent = `Delete ${section.name}?`;
    $('#deleteClassText').textContent = `${sectionLabel(section)} has ${studentCount} student${studentCount === 1 ? '' : 's'} and ${assignments.length} activity/performance-task record${assignments.length === 1 ? '' : 's'}.`;
    openDialog('deleteClassModal');
  });

  $('#confirmDeleteClassBtn')?.addEventListener('click', async () => {
    const button = $('#confirmDeleteClassBtn');
    const section = sectionById(archiveState.deleteClassId);
    if (!section) return closeDialog('deleteClassModal');
    if (!window.MathsideActionButton?.start(button, 'Deleting…')) return;

    try {
      const assignmentIds = state.assignments.filter(a => a.section_id === section.id).map(a => a.id);
      if (assignmentIds.length) {
        const { data: sessionData, error: sessionError } = await db.auth.getSession();
        if (sessionError) throw sessionError;
        const accessToken = sessionData?.session?.access_token;
        if (!accessToken) throw new Error('Your teacher session has expired. Please sign in again.');

        for (const assignmentId of assignmentIds) {
          await deleteAssignmentThroughFunction(assignmentId, accessToken);
        }
      }

      const { data: deletedSection, error: deleteError } = await db
        .from('mathside_sections')
        .delete()
        .eq('id', section.id)
        .select('id')
        .maybeSingle();
      if (deleteError) throw deleteError;
      if (!deletedSection?.id) throw new Error('Class could not be deleted or you no longer have permission to delete it.');

      if (activeSectionId === section.id) activeSectionId = null;
      archiveState.deleteClassId = null;
      await refreshTeacher();
      showTeacherView('classes');
      await window.MathsideActionButton.done(button, 'Deleted');
      closeDialog('deleteClassModal');
      toast('Class deleted permanently. Student login accounts were kept.', 'success', 'Class deleted');
    } catch (error) {
      console.error(error);
      window.MathsideActionButton?.reset(button);
      toast(friendlyErrorMessage(error, 'Could not delete this class.'), 'orange', 'Delete failed');
    }
  });

  // ---------------------------------------------------------------
  // CLEAR SUBMISSION
  // ---------------------------------------------------------------
  $('#clearSubmissionBtn')?.addEventListener('click', () => {
    const submission = state.submissions.find(s => s.id === activeSubmissionId);
    if (!submission) return;
    const assignment = assignmentById(submission.assignment_id);
    const student = studentById(submission.student_id);
    archiveState.clearSubmissionId = submission.id;
    const isPerformance = isPerformanceTask(assignment);
    const itemKind = isPerformance ? 'performance task' : 'activity';
    $('#clearSubmissionText').textContent = `Clear ${student?.display_name || 'this student'}’s submission for “${assignment?.title || `this ${itemKind}`}”?`;
    const warning = $('.archive-warning span', $('#clearSubmissionModal'));
    if (warning) warning.textContent = isPerformance
      ? 'The student’s submitted output pictures, score, feedback, and submission record will be cleared. The performance task itself is not deleted, so the team leader can submit again if the task is still open.'
      : 'The student’s submitted answers, score, feedback, and uploaded solution image will be cleared. The activity itself is not deleted, so the student can submit again if the activity is still open.';
    openDialog('clearSubmissionModal');
  });

  $('#confirmClearSubmissionBtn')?.addEventListener('click', async () => {
    const submission = state.submissions.find(s => s.id === archiveState.clearSubmissionId);
    if (!submission) return closeDialog('clearSubmissionModal');
    const proofPaths = submissionProofPaths(submission);
    try {
      closeDialog('clearSubmissionModal');
      closeDialog('reviewSubmissionModal');
      const assignment = assignmentById(submission.assignment_id);
      await withLoading(
        'Clearing submission…',
        isPerformanceTask(assignment)
          ? 'Removing the performance task submission, score, feedback, and uploaded output pictures.'
          : 'Removing the student response, score, feedback, and uploaded solution.',
        async () => {
        const { error } = await db.rpc('mathside_clear_submission', { p_submission_id: submission.id });
        if (error) throw error;
        // Only legacy Supabase Storage objects can be removed here.
        // R2 files remain in the private bucket until a secure, explicit R2 deletion is configured.
        const oldStoragePaths = proofPaths.filter(path => !window.MathsideR2?.isR2ProofPath(path));
        if (oldStoragePaths.length) {
          const removeResult = await db.storage.from('mathside-submission-proofs').remove(oldStoragePaths);
          if (removeResult.error) console.warn('Proof cleanup:', removeResult.error.message || removeResult.error);
        }
        archiveState.clearSubmissionId = null;
        activeSubmissionId = null;
        await refreshTeacher();
        showTeacherView('submissions');
      });
      toast(`The student submission was cleared. The ${isPerformanceTask(assignment) ? 'performance task' : 'activity'} remains available if it is still open.`, 'success', 'Submission cleared');
    } catch (error) {
      console.error(error);
      toast(friendlyErrorMessage(error, 'Could not clear this submission.'), 'orange', 'Clear failed');
    }
  });

  // ---------------------------------------------------------------
  // SUBMISSIONS: SECTION -> ACTIVITY -> STUDENTS
  // ---------------------------------------------------------------
  renderSubmissionSectionTabs = function() {
    const tabs = $('#submissionSectionTabs');
    if (!tabs) return;
    const counts = submissionSectionCounts();
    const visibleSections = activeSections();
    if (submissionSectionId !== 'all' && !visibleSections.some(s => s.id === submissionSectionId)) submissionSectionId = 'all';
    tabs.innerHTML = `<button type="button" class="submission-section-tab ${submissionSectionId === 'all' ? 'active' : ''}" data-submission-section="all"><b>All</b><span>${state.submissions.length}</span></button>` +
      visibleSections.map(section => `<button type="button" class="submission-section-tab ${submissionSectionId === section.id ? 'active' : ''}" data-submission-section="${section.id}"><b>${esc(section.name)}</b><small>Grade ${esc(section.grade_level)}</small><span>${counts.get(section.id) || 0}</span></button>`).join('');
  };

  function sortedSubmissionRows(rows) {
    return [...rows].sort((a,b) => {
      if (submissionSort === 'oldest') return new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0);
      if (submissionSort === 'name') return String(studentById(a.student_id)?.display_name || '').localeCompare(String(studentById(b.student_id)?.display_name || ''), undefined, { sensitivity:'base' });
      if (submissionSort === 'gender') {
        const order = { Male:0, Female:1, 'Prefer not to say':2, 'Not specified':3 };
        const ga = String(studentById(a.student_id)?.gender || 'Not specified');
        const gb = String(studentById(b.student_id)?.gender || 'Not specified');
        return (order[ga]??9)-(order[gb]??9) || String(studentById(a.student_id)?.display_name || '').localeCompare(String(studentById(b.student_id)?.display_name || ''), undefined, { sensitivity:'base' });
      }
      return new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0);
    });
  }

  function submissionCard(s) {
    const a = assignmentById(s.assignment_id);
    const student = studentById(s.student_id);
    const section = sectionById(a?.section_id);
    const total = a ? totalPoints(a.id) : 0;
    const shownScore = s.teacher_score ?? s.auto_score ?? 0;
    const genderClass = student?.gender === 'Male' ? 'submission-male' : student?.gender === 'Female' ? 'submission-female' : 'submission-other';
    return `<article class="submission-card ${genderClass}"><div class="submission-status-icon">${s.status === 'graded' ? iconSvg('check','assignment-line-icon') : iconSvg('inbox','assignment-line-icon')}</div><div class="submission-card-body"><div class="submission-student-row"><button type="button" class="submission-student-name" data-track-student-from-submissions="${student?.id || ''}" data-track-section="${section?.id || ''}">${esc(student?.display_name || 'Student')}</button><span class="gender-pill">${esc(student?.gender || 'Not specified')}</span></div><div class="submission-meta-grid"><span><small>Status</small><b>${esc(s.status)}</b></span><span><small>Score</small><b>${Number(shownScore || 0)}/${total}</b></span><span><small>Attempt</small><b>${Number(s.attempt_count || 1)}</b></span><span><small>Submitted</small><b>${esc(formatStudentDate(s.submitted_at) || '')}</b></span></div></div><button class="btn btn-orange submission-review-btn" data-review-submission="${s.id}">Review</button></article>`;
  }

  renderSubmissions = function() {
    const list = $('#submissionList');
    if (!list) return;
    renderSubmissionSectionTabs();
    if ($('#submissionSort')) $('#submissionSort').value = submissionSort;
    let rows = state.submissions.filter(sub => submissionSectionId === 'all' || assignmentById(sub.assignment_id)?.section_id === submissionSectionId);
    const uniqueStudents = new Set(rows.map(sub => sub.student_id)).size;
    const selectedSection = submissionSectionId === 'all' ? null : sectionById(submissionSectionId);
    const summary = $('#submissionSectionSummary');
    if (summary) summary.innerHTML = `<span><b>${rows.length}</b> submission${rows.length === 1 ? '' : 's'}</span><span><b>${uniqueStudents}</b> learner${uniqueStudents === 1 ? '' : 's'}</span>${selectedSection ? `<span><b>${esc(selectedSection.name)}</b> · Grade ${esc(selectedSection.grade_level)}</span>` : '<span>Grouped by section, then activity</span>'}`;
    if (!rows.length) {
      list.innerHTML = `<div class="assignment-empty v9-empty"><b>${selectedSection ? `No submissions yet from ${esc(selectedSection.name)}.` : 'No student submissions yet'}</b><p>Student work will be grouped by class and activity here.</p></div>`;
      return;
    }
    const sectionMap = new Map();
    rows.forEach(sub => {
      const assignment = assignmentById(sub.assignment_id);
      if (!assignment) return;
      if (!sectionMap.has(assignment.section_id)) sectionMap.set(assignment.section_id, new Map());
      const assignmentMap = sectionMap.get(assignment.section_id);
      if (!assignmentMap.has(assignment.id)) assignmentMap.set(assignment.id, []);
      assignmentMap.get(assignment.id).push(sub);
    });
    const sectionIds = [...sectionMap.keys()].sort((a,b) => sectionLabel(sectionById(a)).localeCompare(sectionLabel(sectionById(b))));
    list.innerHTML = sectionIds.map(sectionId => {
      const section = sectionById(sectionId);
      const assignmentMap = sectionMap.get(sectionId);
      const assignmentIds = [...assignmentMap.keys()].sort((a,b) => String(assignmentById(a)?.title || '').localeCompare(String(assignmentById(b)?.title || ''), undefined, { sensitivity:'base' }));
      const groups = assignmentIds.map(assignmentId => {
        const assignment = assignmentById(assignmentId);
        const subs = sortedSubmissionRows(assignmentMap.get(assignmentId));
        return `<section class="submission-activity-group"><header><div><span>ACTIVITY</span><h3>${esc(assignment?.title || 'Activity')}</h3></div><div><b>${subs.length}</b><small>submission${subs.length===1?'':'s'}</small></div></header><div class="submission-activity-list">${subs.map(submissionCard).join('')}</div></section>`;
      }).join('');
      return `<section class="submission-section-group"><div class="submission-section-group-title"><span>${iconSvg('class','btn-icon')}</span><div><p>SECTION</p><h2>${esc(section?.name || 'Class')}</h2><small>Grade ${esc(section?.grade_level || '')}</small></div></div>${groups}</section>`;
    }).join('');
  };

  // ---------------------------------------------------------------
  // ARCHIVED ACTIVITY SAFETY ON STUDENT DEVICES
  // ---------------------------------------------------------------
  document.addEventListener('click', event => {
    const answerButton = event.target.closest('[data-answer-assignment]');
    if (!answerButton) return;
    const assignment = assignmentById(answerButton.dataset.answerAssignment);
    if (assignment?.status !== 'archived') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast('This activity has been archived. You can still review it, but uploading and submitting are disabled.', 'orange', 'Activity archived');
  }, true);

  // ---------------------------------------------------------------
  // MOBILE ROSTER BUTTON VISIBILITY + INITIAL SYNC
  // ---------------------------------------------------------------
  setTimeout(() => {
    populateArchivedImportOptions();
    if (state.profile?.role === 'teacher') renderTeacher();
    if (state.profile?.role === 'student') renderStudentAssignments();
  }, 0);
})();
