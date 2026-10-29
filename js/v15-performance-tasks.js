/* Mathside V24.9 — Reuse past Performance Task groups and edit leaders after posting.
   Adapted from the established EduCore performance-task workflow while
   preserving Mathside archive, manual review and controlled resubmission. */
(() => {
  'use strict';

  let submissionWorkType = 'written_work';
  let submissionAssignmentFilter = 'all';
  let editingPerformanceTaskId = null;
  let editingPerformanceTaskIds = [];
  let activePerformanceTaskId = null;
  let performanceTaskSectionFilter = 'all';
  let performanceTaskStatusFilter = 'all';
  let performanceTaskModeFilter = 'all';
  let performanceTaskSort = 'newest';
  let activitySectionFilter = 'all';
  let activityStatusFilter = 'all';
  let activitySort = 'newest';
  let archiveCategoryFilter = 'all';
  let archiveSort = 'newest';
  const performanceLeaderSelections = new Map();
  const performanceTeamOrders = new Map();
  const performanceImportedGroups = new Map();
  let performanceGroupingDirty = false;
  let performanceLeaderDirty = false;

  const originalOpenAssignmentPreview = openAssignmentPreview;
  const originalOpenSubmissionReview = openSubmissionReview;
  const originalOpenStudentResponsePreview = openStudentResponsePreview;
  const originalShowTeacherView = showTeacherView;
  const originalRenderTeacher = renderTeacher;
  const originalShowStudentPanel = showStudentPanel;

  const asPaths = (value, fallback = '') => normalizeStoredPaths(value, fallback);
  const performanceTasks = () => state.assignments.filter(a => isPerformanceTask(a));
  const writtenWorks = () => state.assignments.filter(a => !isPerformanceTask(a));
  const assignmentTaskImages = a => asPaths(a?.image_paths, a?.image_path || '');
  const submissionOutputPaths = s => asPaths(s?.proof_paths, s?.proof_path || '');
  const activeSections = () => state.sections.filter(section => !section.archived_at);

  function performanceSignature(a) {
    return JSON.stringify({
      title: String(a.title || '').trim(),
      instructions: String(a.instructions || '').trim(),
      due: a.due_at || null,
      reminder: Number(a.reminder_hours_before || 0),
      status: a.status || 'published',
      publish: a.publish_at || null,
      resubmit: Boolean(a.allow_resubmission),
      points: Number(a.max_points || 0),
      collaboration: a.collaboration_mode || 'individual',
      groupingCreator: a.grouping_creator || 'teacher',
      groupCount: Number(a.group_count || 0),
      type: 'performance_task'
    });
  }

  function performanceGroups() {
    const bySignature = new Map();
    performanceTasks().forEach(task => {
      const sig = performanceSignature(task);
      if (!bySignature.has(sig)) bySignature.set(sig, []);
      const buckets = bySignature.get(sig);
      let group = buckets.find(candidate => !candidate.some(item => item.section_id === task.section_id));
      if (!group) { group = []; buckets.push(group); }
      group.push(task);
    });
    return [...bySignature.values()].flat();
  }

  function performanceGroupForId(id) {
    return performanceGroups().find(group => group.some(item => item.id === id)) || [];
  }

  function groupSectionLabels(group) {
    return [...new Set(group.map(item => sectionLabel(sectionById(item.section_id))))];
  }

  async function signedLinks(bucket, paths, seconds = 1800) {
    const results = [];
    for (const path of paths) {
      const url = await signedUrl(bucket, path, seconds);
      if (url) results.push({ path, url });
    }
    return results;
  }

  async function removeStoragePaths(bucket, paths) {
    // Intentionally retain uploaded files. Removing an attachment from an activity
    // only unlinks it; previous submissions and archived records remain intact.
    // Legacy Supabase paths are also left untouched to prevent accidental loss.
    return;
  }

  async function uploadTeacherFiles(taskId, files, prefix) {
    const paths = [];
    for (const originalFile of files) {
      const file = String(originalFile.type || '').startsWith('image/')
        ? await compressImageForUpload(originalFile, { maxDimension: 1800, targetBytes: 700 * 1024 })
        : originalFile;
      paths.push(await window.MathsideR2.uploadTeacherFile(db, {
        assignmentId: taskId, userId: state.user.id, file
      }));
    }
    return paths;
  }

  // ---------------------------------------------------------------
  // TEACHER NAV / COUNTS
  // ---------------------------------------------------------------
  showTeacherView = function(view) {
    originalShowTeacherView(view);
    if (view === 'performance') {
      $('#teacherPageTitle').textContent = 'Performance Tasks';
      renderPerformanceTasks();
    }
    if (view === 'assignments') $('#teacherPageTitle').textContent = 'Activities';
    if (view === 'archive') {
      $('#teacherPageTitle').textContent = 'Archived';
      renderArchiveCenter();
    }
  };

  renderTeacher = function() {
    originalRenderTeacher();
    const performanceTotal = $('#performanceTotal');
    if (performanceTotal) performanceTotal.textContent = String(performanceTasks().filter(a => a.status !== 'archived').length);
    const assignmentTotal = $('#assignmentTotal');
    if (assignmentTotal) assignmentTotal.textContent = String(writtenWorks().filter(a => a.status !== 'archived').length);
    renderPerformanceTasks();
    renderArchiveCenter();
  };

  // ---------------------------------------------------------------
  // WRITTEN ACTIVITY LIST + COMPACT FILTERS
  // ---------------------------------------------------------------
  function activityGroupState(group) {
    const archived = group.every(item => item.status === 'archived');
    const scheduled = !archived && group.some(item => item.status === 'draft' && item.publish_at && new Date(item.publish_at).getTime() > Date.now());
    return archived ? 'archived' : scheduled ? 'scheduled' : 'posted';
  }

  function syncActivityFilterUi() {
    const sectionSelect = $('#activitySectionFilter');
    if (sectionSelect) {
      const activeIds = new Set(activeSections().map(section => section.id));
      if (activitySectionFilter !== 'all' && !activeIds.has(activitySectionFilter)) activitySectionFilter = 'all';
      sectionSelect.innerHTML = `<option value="all">All sections</option>` + activeSections().map(section => `<option value="${esc(section.id)}">${esc(section.name)} · Grade ${esc(section.grade_level)}</option>`).join('');
      sectionSelect.value = activitySectionFilter;
    }
    if ($('#activityStatusFilter')) $('#activityStatusFilter').value = activityStatusFilter;
    if ($('#activitySort')) $('#activitySort').value = activitySort;
    const activeCount = Number(activitySectionFilter !== 'all') + Number(activityStatusFilter !== 'all') + Number(activitySort !== 'newest');
    const badge = $('#activityFilterBadge');
    if (badge) { badge.textContent = String(activeCount); badge.hidden = activeCount === 0; }
  }

  function activityGroupsForDisplay() {
    activityStatusFilter = ['all','posted','scheduled'].includes(activityStatusFilter) ? activityStatusFilter : 'all';
    activitySort = ['newest','name','name-desc','due'].includes(activitySort) ? activitySort : 'newest';
    syncActivityFilterUi();
    const groups = groupedAssignmentsForDisplay().filter(group => {
      if (!group.length || isPerformanceTask(group[0])) return false;
      if (activityGroupState(group) === 'archived') return false;
      if (activitySectionFilter !== 'all' && !group.some(item => item.section_id === activitySectionFilter)) return false;
      return activityStatusFilter === 'all' || activityGroupState(group) === activityStatusFilter;
    });
    groups.sort((ga, gb) => {
      const a = ga[0], b = gb[0];
      const nameA = String(a?.title || ''), nameB = String(b?.title || '');
      if (activitySort === 'name') return nameA.localeCompare(nameB, undefined, { sensitivity:'base' });
      if (activitySort === 'name-desc') return nameB.localeCompare(nameA, undefined, { sensitivity:'base' });
      if (activitySort === 'due') {
        const ad = a?.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
        const bd = b?.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
        return ad - bd || nameA.localeCompare(nameB, undefined, { sensitivity:'base' });
      }
      return new Date(b?.created_at || b?.publish_at || 0) - new Date(a?.created_at || a?.publish_at || 0);
    });
    return groups;
  }

  updateAssignmentBulkToolbar = function() {
    const validIds = state.assignments.map(assignment => assignment.id);
    [...selectedAssignmentIds].forEach(id => { if (!validIds.includes(id)) selectedAssignmentIds.delete(id); });
    const groups = activityGroupsForDisplay();
    const selectedGroups = groups.filter(group => group.length && group.every(assignment => selectedAssignmentIds.has(assignment.id)));
    const count = selectedGroups.length;
    $('#selectedAssignmentCount') && ($('#selectedAssignmentCount').textContent = `${count} selected`);
    $('#bulkDeleteAssignmentsBtn') && ($('#bulkDeleteAssignmentsBtn').disabled = count === 0);
    $('#bulkArchiveAssignmentsBtn') && ($('#bulkArchiveAssignmentsBtn').disabled = count === 0 || !selectedGroups.some(group => group.some(a => a.status !== 'archived')));
    $('#bulkUnarchiveAssignmentsBtn') && ($('#bulkUnarchiveAssignmentsBtn').disabled = count === 0 || !selectedGroups.some(group => group.some(a => a.status === 'archived')));
    const selectAll = $('#selectAllAssignments');
    if (selectAll) {
      selectAll.checked = groups.length > 0 && count === groups.length;
      selectAll.indeterminate = count > 0 && count < groups.length;
    }
  };

  renderAssignments = function() {
    const list = $('#assignmentList');
    if (!list) return;
    const allGroups = groupedAssignmentsForDisplay().filter(group => group.length && !isPerformanceTask(group[0]) && activityGroupState(group) !== 'archived');
    const groups = activityGroupsForDisplay();
    if (!groups.length) {
      selectedAssignmentIds.clear();
      const hasFilter = activitySectionFilter !== 'all' || activityStatusFilter !== 'all' || activitySort !== 'newest';
      list.innerHTML = allGroups.length
        ? `<div class="assignment-empty v9-empty"><span class="v9-empty-icon">⌁</span><b>No activities match these filters</b><p>Tap Filter and choose another section or status.</p></div>`
        : `<div class="assignment-empty v9-empty"><span class="v9-empty-icon">${iconSvg('assignment','assignment-line-icon')}</span><b>No activities yet</b><p>Create your first question-based Mathematics activity.</p><button class="btn btn-orange" type="button" data-v9-new-assignment>＋ New activity</button></div>`;
      return;
    }
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
        <div class="assignment-thumb">${assignment.image_url ? `<img src="${esc(assignment.image_url)}" alt="Activity image" data-assignment-storage-path="${esc(assignment.image_path || '')}">` : iconSvg('assignment','assignment-line-icon')}</div>
        <div class="assignment-card-body"><div class="assignment-title-line"><h3>${esc(assignment.title)}</h3>${group.length > 1 ? '<span class="shared-assignment-badge">Shared activity</span>' : ''}${scheduled ? '<span class="scheduled-badge">Scheduled</span>' : ''}${archived ? '<span class="archived-badge">Archived</span>' : ''}</div><p>${esc(assignment.instructions || 'Mathematics activity')}</p>${classList}<div class="assignment-meta">${classSummary}${scheduled ? `<span class="meta-chip scheduled-chip">Posts ${esc(formatDeadlineDate(assignment.publish_at))}</span>` : ''}${missingAnswers ? `<span class="meta-chip answer-key-warning">${missingAnswers} answer${missingAnswers===1?'':'s'} pending</span>` : ''}</div></div>
        <div class="assignment-card-actions"><button class="btn btn-light" data-preview-assignment="${assignment.id}">Preview</button>${archived ? `<button class="btn btn-unarchive" data-unarchive-assignment-group="${esc(groupIdsAttr)}">Unarchive</button>` : `<button class="btn btn-light" data-edit-assignment="${assignment.id}">Edit</button><button class="btn btn-archive" data-archive-assignment-group="${esc(groupIdsAttr)}">Archive</button>`}<button class="btn btn-danger-outline" data-delete-assignment-group="${esc(groupIdsAttr)}">Delete</button></div>
      </article>`;
    }).join('');
    list.innerHTML = `<div class="bulk-toolbar assignment-bulk-toolbar"><label class="bulk-select-all"><input id="selectAllAssignments" class="row-check" type="checkbox"><span>Select all activities</span></label><span class="bulk-selected-count" id="selectedAssignmentCount">0 selected</span><div class="bulk-actions"><button class="btn btn-archive" id="bulkArchiveAssignmentsBtn" type="button" disabled>Archive selected</button><button class="btn btn-danger" id="bulkDeleteAssignmentsBtn" type="button" disabled>Delete selected</button></div></div>${cards}`;
    updateAssignmentBulkToolbar();
  };

  // ---------------------------------------------------------------
  // PERFORMANCE TASK EDITOR
  // ---------------------------------------------------------------
  function populatePerformanceSections() {
    const list = $('#performanceSectionChecklist');
    if (!list) return;
    const sections = activeSections();
    if (!sections.length) { list.innerHTML = '<p class="class-checklist-empty">Create an active class first.</p>'; return; }
    list.innerHTML = sections.map((section, index) => `<label class="class-check-option"><input type="checkbox" name="performance_sections" value="${section.id}" ${sections.length === 1 && index === 0 ? 'checked' : ''}><span><b>${esc(section.name)}</b><small>Grade ${esc(section.grade_level)}</small></span></label>`).join('');
  }

  function selectedPerformanceSections() {
    return $$('input[name="performance_sections"]:checked', $('#performanceSectionChecklist')).map(n => n.value);
  }

  function performanceMode() {
    return $('input[name="performance_mode"]:checked')?.value || 'individual';
  }

  function performanceGroupingCreator() {
    return $('input[name="grouping_creator"]:checked')?.value || 'teacher';
  }

  function performanceGroupCount() {
    const value = Number($('#performanceGroupCount')?.value || 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  function syncPerformanceTeamOptions() {
    const mode = performanceMode();
    const grouped = mode !== 'individual';
    if (mode === 'class') { const teacherRadio = $('input[name="grouping_creator"][value="teacher"]'); if (teacherRadio) teacherRadio.checked = true; }
    const creator = performanceGroupingCreator();
    const help = $('#performanceClassHelp'); if (help) help.hidden = mode !== 'class';
    const creatorRow = $('#performanceGroupingOptions .performance-creator-options')?.parentElement; if (creatorRow) creatorRow.hidden = mode === 'class';
    const shuffle = $('#reshufflePerformanceTeamsBtn'); if (shuffle) shuffle.hidden = mode === 'class';
    const generate = $('#generatePerformanceTeamsBtn'); if (generate) generate.hidden = mode === 'class';
    const importRow = $('#performanceGroupingOptions .performance-import-groups-row'); if (importRow) importRow.hidden = mode === 'class';
    if ($('#performanceGroupingOptions')) $('#performanceGroupingOptions').hidden = !grouped;
    if ($('#performanceGroupCountWrap')) $('#performanceGroupCountWrap').hidden = mode !== 'group';
    if ($('#performanceTeacherGroupingTools')) $('#performanceTeacherGroupingTools').hidden = !grouped || creator !== 'teacher';
    if (!grouped && $('#performanceTeamPreview')) $('#performanceTeamPreview').innerHTML = '';
  }

  function sortedStudentsForSection(sectionId) {
    return studentsForSection(sectionId).slice().sort((a,b) => {
      const byName = String(a.display_name || '').localeCompare(String(b.display_name || ''), undefined, { sensitivity:'base' });
      return byName || String(a.id || '').localeCompare(String(b.id || ''));
    });
  }

  function orderedStudentsForPerformanceSection(sectionId) {
    const students = sortedStudentsForSection(sectionId);
    const savedOrder = performanceTeamOrders.get(sectionId);
    if (!Array.isArray(savedOrder) || savedOrder.length !== students.length) return students;
    const byId = new Map(students.map(student => [student.id, student]));
    const ordered = savedOrder.map(id => byId.get(id)).filter(Boolean);
    return ordered.length === students.length ? ordered : students;
  }

  function clearImportedPerformanceGroups(sectionIds = null) {
    const ids = Array.isArray(sectionIds) ? sectionIds : [...performanceImportedGroups.keys()];
    ids.forEach(sectionId => performanceImportedGroups.delete(sectionId));
  }

  function clearLeaderSelectionsForSections(sectionIds = []) {
    const prefixes = sectionIds.map(sectionId => `${sectionId}::`);
    [...performanceLeaderSelections.keys()].forEach(key => {
      if (prefixes.some(prefix => key.startsWith(prefix))) performanceLeaderSelections.delete(key);
    });
  }

  function savedGroupsForSection(sectionId, data, { adaptRoster = false, mode = 'group' } = {}) {
    const roster = sortedStudentsForSection(sectionId);
    const rosterById = new Map(roster.map(student => [student.id, student]));
    const seen = new Set();
    const sourceGroups = Array.isArray(data?.groups) ? data.groups : [];
    const groups = sourceGroups.map((source, index) => {
      const members = (Array.isArray(source.members) ? source.members : []).map(member => {
        const id = String(member?.id || '');
        if (!id || seen.has(id)) return null;
        const rosterStudent = rosterById.get(id);
        if (adaptRoster && !rosterStudent) return null;
        seen.add(id);
        return rosterStudent || {
          id,
          display_name: String(member?.display_name || 'Student')
        };
      }).filter(Boolean);
      if (!members.length) return null;
      const leaderId = members.some(member => member.id === source.leader_id)
        ? source.leader_id
        : members[0].id;
      return {
        id: source.id || null,
        name: String(source.name || (mode === 'pair' ? `Pair ${index + 1}` : `Group ${index + 1}`)),
        members,
        leader_id: leaderId
      };
    }).filter(Boolean);

    if (adaptRoster) {
      const unassigned = roster.filter(student => !seen.has(student.id));
      if (mode === 'pair') {
        let pairNumber = groups.length + 1;
        for (let index = 0; index < unassigned.length; index += 2) {
          const members = unassigned.slice(index, index + 2);
          groups.push({
            id: null,
            name: `Pair ${pairNumber++}`,
            members,
            leader_id: members[0]?.id || ''
          });
        }
      } else if (groups.length) {
        unassigned.forEach(student => {
          const target = groups.reduce((smallest, group) => group.members.length < smallest.members.length ? group : smallest, groups[0]);
          target.members.push(student);
        });
      }
    }

    groups.forEach(group => {
      if (!group.members.some(member => member.id === group.leader_id)) group.leader_id = group.members[0]?.id || '';
    });
    return groups;
  }

  function setImportedGroupsForSection(sectionId, groups) {
    performanceImportedGroups.set(sectionId, groups);
    clearLeaderSelectionsForSections([sectionId]);
    groups.forEach(group => {
      if (group.leader_id) performanceLeaderSelections.set(performanceLeaderKey(sectionId, group.name), group.leader_id);
    });
  }

  function teamPreviewForSection(sectionId, mode, requestedGroupCount) {
    const imported = performanceImportedGroups.get(sectionId);
    if (mode === 'class') {
      const members = orderedStudentsForPerformanceSection(sectionId);
      if (!members.length) return [];
      const previous = Array.isArray(imported) ? imported[0] : null;
      return [{ name: 'Whole Class', members, leader_id: previous?.leader_id || '' }];
    }
    if (Array.isArray(imported) && imported.length) {
      return imported.map(group => ({
        ...group,
        members: group.members.slice()
      }));
    }
    const students = orderedStudentsForPerformanceSection(sectionId);
    if (!students.length) return [];
    const count = mode === 'pair' ? Math.ceil(students.length / 2) : Math.max(1, Math.min(students.length, Number(requestedGroupCount || 1)));
    const groups = Array.from({length: count}, (_, index) => ({ name: mode === 'pair' ? `Pair ${index + 1}` : `Group ${index + 1}`, members: [] }));
    students.forEach((student, index) => groups[index % count].members.push(student));
    return groups.filter(group => group.members.length);
  }

  function secureShuffle(values) {
    const result = values.slice();
    const random = new Uint32Array(1);
    for (let i = result.length - 1; i > 0; i -= 1) {
      if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(random);
        const j = random[0] % (i + 1);
        [result[i], result[j]] = [result[j], result[i]];
      } else {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
    }
    return result;
  }

  function reshufflePerformanceTeams() {
    const mode = performanceMode();
    if (mode === 'individual' || mode === 'class' || performanceGroupingCreator() !== 'teacher') return toast('Choose Pair or Group with teacher-created teams first.', 'orange');
    if (mode === 'group' && !performanceGroupCount()) return toast('Enter how many groups you want first.', 'orange');
    const sectionIds = selectedPerformanceSections();
    if (!sectionIds.length) return toast('Select at least one class first.', 'orange');
    sectionIds.forEach(sectionId => {
      const ids = sortedStudentsForSection(sectionId).map(student => student.id);
      performanceTeamOrders.set(sectionId, secureShuffle(ids));
      performanceImportedGroups.delete(sectionId);
    });
    clearLeaderSelectionsForSections(sectionIds);
    performanceGroupingDirty = true;
    performanceLeaderDirty = false;
    renderPerformanceTeamPreview();
    toast(`Groups reshuffled for ${sectionIds.length} class${sectionIds.length === 1 ? '' : 'es'}.`, 'success');
  }

  function serializedPerformanceGroupsForSection(sectionId, mode = performanceMode(), requestedGroupCount = performanceGroupCount()) {
    return teamPreviewForSection(sectionId, mode, requestedGroupCount).map(group => ({
      name: group.name,
      member_ids: group.members.map(member => member.id),
      leader_id: selectedLeaderForGroup(sectionId, group)
    }));
  }

  function performanceLeaderKey(sectionId, groupName) {
    return `${sectionId}::${groupName}`;
  }

  function selectedLeaderForGroup(sectionId, group) {
    const key = performanceLeaderKey(sectionId, group.name);
    const current = performanceLeaderSelections.get(key);
    if (current && group.members.some(member => member.id === current)) return current;
    const savedLeader = group.leader_id;
    if (savedLeader && group.members.some(member => member.id === savedLeader)) {
      performanceLeaderSelections.set(key, savedLeader);
      return savedLeader;
    }
    if (performanceMode() === 'class') return ''; // Require a teacher-selected representative.
    const fallback = group.members[0]?.id || '';
    if (fallback) performanceLeaderSelections.set(key, fallback);
    return fallback;
  }

  function leaderAssignmentsForSection(sectionId, mode = performanceMode(), requestedGroupCount = performanceGroupCount()) {
    return teamPreviewForSection(sectionId, mode, requestedGroupCount).map(group => ({
      group_name: group.name,
      leader_id: selectedLeaderForGroup(sectionId, group)
    })).filter(item => item.leader_id);
  }

  function renderPerformanceTeamPreview() {
    const box = $('#performanceTeamPreview');
    if (!box) return;
    const mode = performanceMode();
    const creator = performanceGroupingCreator();
    if (mode === 'individual' || creator !== 'teacher') { box.innerHTML = ''; return; }
    const sectionIds = selectedPerformanceSections();
    if (!sectionIds.length) { box.innerHTML = '<p class="muted">Select at least one class first.</p>'; return; }
    if (mode === 'group' && !performanceGroupCount()) { box.innerHTML = '<p class="muted">Enter how many groups you want for each class.</p>'; return; }
    box.innerHTML = sectionIds.map(sectionId => {
      const section = sectionById(sectionId);
      const groups = teamPreviewForSection(sectionId, mode, performanceGroupCount());
      if (!groups.length) return `<article><h4>${esc(section?.name || 'Class')}</h4><p class="muted">No students are enrolled yet.</p></article>`;
      return `<article data-team-preview-section="${esc(sectionId)}"><div class="performance-team-preview-head"><h4>${esc(section?.name || 'Class')} <small>Grade ${esc(section?.grade_level || '')}</small></h4><button type="button" class="btn btn-light performance-download-team-image" data-download-performance-team-image="${esc(sectionId)}">Download image</button></div><div class="performance-team-preview-grid">${groups.map(group => { const leaderId = selectedLeaderForGroup(sectionId, group); return `<div><b>${esc(group.name)}</b><label class="performance-leader-picker"><span>${mode === 'class' ? 'Class representative (required)' : 'Team leader'}</span><select data-performance-leader-select data-section-id="${esc(sectionId)}" data-group-name="${esc(group.name)}" ${mode === 'class' ? 'required' : ''}>${mode === 'class' ? '<option value="">Choose a class representative</option>' : ''}${group.members.map(member => `<option value="${esc(member.id)}" ${member.id===leaderId?'selected':''}>${esc(member.display_name)}</option>`).join('')}</select></label><div class="performance-team-members">${group.members.map(member => `<span>${member.id === leaderId ? (mode === 'class' ? '<strong>Representative</strong> ' : '<strong>Leader</strong> ') : ''}${esc(member.display_name)}</span>`).join('')}</div></div>`; }).join('')}</div></article>`;
    }).join('');
  }

  function safeImageFileName(value) {
    return String(value || 'class').trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'class';
  }

  function canvasRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, width, height, r); return; }
    ctx.moveTo(x + r, y); ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r); ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function wrapCanvasText(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    words.forEach(word => {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) { lines.push(current); current = word; }
      else current = test;
    });
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  function downloadPerformanceGroupingImage(sectionId) {
    const section = sectionById(sectionId);
    if (!section) return toast('Class not found.', 'orange');
    const mode = performanceMode();
    const groups = teamPreviewForSection(sectionId, mode, performanceGroupCount());
    if (!groups.length) return toast('There are no students to include in this grouping.', 'orange');

    const width = 1200, margin = 70, cardGap = 24, colCount = 2;
    const cardWidth = (width - (margin * 2) - cardGap) / colCount;
    const ctxProbe = document.createElement('canvas').getContext('2d');
    ctxProbe.font = '28px Arial';
    const groupHeights = groups.map(group => 84 + group.members.reduce((sum, member) => {
      const lines = wrapCanvasText(ctxProbe, `${member.display_name || 'Student'}`, cardWidth - 54);
      return sum + Math.max(38, lines.length * 32);
    }, 0) + 24);
    const rows = Math.ceil(groups.length / colCount);
    let contentHeight = 0;
    for (let r=0; r<rows; r+=1) contentHeight += Math.max(...groupHeights.slice(r*colCount, r*colCount+colCount)) + cardGap;
    const height = Math.max(620, 230 + contentHeight + 80);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fffaf5'; ctx.fillRect(0,0,width,height);
    ctx.fillStyle = '#ff6b00'; ctx.fillRect(0,0,width,18);
    ctx.fillStyle = '#2f241d'; ctx.font = '700 50px Arial'; ctx.fillText('Mathside Team Grouping', margin, 92);
    ctx.fillStyle = '#a94d0e'; ctx.font = '700 27px Arial'; ctx.fillText(`${section.name} · Grade ${section.grade_level}`, margin, 140);
    ctx.fillStyle = '#75685f'; ctx.font = '24px Arial'; ctx.fillText(mode === 'class' ? 'Class Performance Task' : mode === 'pair' ? 'Pair Performance Task' : 'Group Performance Task', margin, 178);

    let y = 220;
    for (let r=0; r<rows; r+=1) {
      const rowGroups = groups.slice(r*colCount, r*colCount+colCount);
      const rowHeight = Math.max(...groupHeights.slice(r*colCount, r*colCount+colCount));
      rowGroups.forEach((group, c) => {
        const x = margin + c * (cardWidth + cardGap);
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ead8c9'; ctx.lineWidth = 3;
        ctx.beginPath(); canvasRoundedRect(ctx,x,y,cardWidth,rowHeight,24); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff0e3'; ctx.beginPath(); canvasRoundedRect(ctx,x+20,y+20,cardWidth-40,56,14); ctx.fill();
        ctx.fillStyle = '#b94b0b'; ctx.font = '700 27px Arial'; ctx.fillText(group.name, x+38, y+58);
        let my = y + 108;
        const leaderId = selectedLeaderForGroup(sectionId, group);
        group.members.forEach((member) => {
          const isLeader = member.id === leaderId;
          ctx.fillStyle = isLeader ? '#28734a' : '#40362f'; ctx.font = isLeader ? '700 25px Arial' : '25px Arial';
          const prefix = isLeader ? 'Leader — ' : '';
          const lines = wrapCanvasText(ctx, prefix + (member.display_name || 'Student'), cardWidth - 74);
          lines.forEach((line, li) => ctx.fillText(line, x+38, my + li*31));
          my += Math.max(38, lines.length * 32);
        });
      });
      y += rowHeight + cardGap;
    }
    ctx.fillStyle = '#9a8c82'; ctx.font = '18px Arial'; ctx.fillText('Generated by Mathside', margin, height - 38);
    canvas.toBlob(blob => {
      if (!blob) return toast('Could not create the grouping image.', 'orange');
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `Mathside-${safeImageFileName(section.name)}-${mode}-grouping.png`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1200);
      toast(`Grouping image downloaded for ${section.name}.`, 'success');
    }, 'image/png');
  }

  document.addEventListener('change', event => {
    const select = event.target.closest('[data-performance-leader-select]');
    if (!select) return;
    performanceLeaderSelections.set(performanceLeaderKey(select.dataset.sectionId, select.dataset.groupName), select.value);
    performanceLeaderDirty = true;
    renderPerformanceTeamPreview();
  });

  document.addEventListener('click', event => {
    const btn = event.target.closest('[data-download-performance-team-image]');
    if (!btn) return;
    event.preventDefault();
    downloadPerformanceGroupingImage(btn.dataset.downloadPerformanceTeamImage);
  });

  function performanceGroupSeriesForImport() {
    const selectedSections = selectedPerformanceSections();
    if (!selectedSections.length) return [];
    return performanceGroups()
      .filter(group => {
        if (!group.length) return false;
        const first = group[0];
        if ((first.collaboration_mode || 'individual') === 'individual') return false;
        if ((first.grouping_creator || 'teacher') !== 'teacher') return false;
        if (editingPerformanceTaskIds.some(id => group.some(item => item.id === id))) return false;
        const sourceSections = new Set(group.map(item => item.section_id));
        return selectedSections.every(sectionId => sourceSections.has(sectionId));
      })
      .sort((a, b) => {
        const aTime = Math.max(...a.map(item => new Date(item.created_at || item.publish_at || item.due_at || 0).getTime() || 0));
        const bTime = Math.max(...b.map(item => new Date(item.created_at || item.publish_at || item.due_at || 0).getTime() || 0));
        return bTime - aTime;
      });
  }

  function populatePastPerformanceGroupSources() {
    const select = $('#pastPerformanceGroupSource');
    const button = $('#importPastPerformanceGroupsBtn');
    if (!select || !button) return;
    const choices = performanceGroupSeriesForImport();
    if (!choices.length) {
      select.innerHTML = '<option value="">No past grouped task for the selected class(es)</option>';
      select.disabled = true;
      button.disabled = true;
      return;
    }
    select.disabled = false;
    button.disabled = false;
    select.innerHTML = '<option value="">Choose a past performance task</option>' + choices.map(group => {
      const task = group[0];
      const created = new Date(task.created_at || task.publish_at || task.due_at || Date.now());
      const dateLabel = Number.isNaN(created.getTime()) ? '' : ` · ${created.toLocaleDateString()}`;
      const classLabel = group.length > 1 ? ` · ${group.length} classes` : ` · ${sectionById(task.section_id)?.name || 'Class'}`;
      return `<option value="${esc(task.id)}">${esc(task.title || 'Performance Task')}${esc(classLabel)}${esc(dateLabel)}</option>`;
    }).join('');
  }

  async function importPastPerformanceGroups() {
    const select = $('#pastPerformanceGroupSource');
    const sourceId = select?.value || '';
    if (!sourceId) return toast('Choose a past performance task first.', 'orange');
    const sourceTask = assignmentById(sourceId);
    if (!sourceTask) return toast('That past performance task is no longer available.', 'orange');
    const sourceSeries = performanceGroupForId(sourceId);
    const linked = sourceSeries.length ? sourceSeries : [sourceTask];
    const sourceBySection = new Map(linked.map(task => [task.section_id, task]));
    const sectionIds = selectedPerformanceSections();
    if (!sectionIds.length) return toast('Select at least one class first.', 'orange');
    if (sectionIds.some(sectionId => !sourceBySection.has(sectionId))) {
      return toast('The selected past task does not contain groups for every selected class.', 'orange');
    }

    const button = $('#importPastPerformanceGroupsBtn');
    if (!window.MathsideActionButton?.start(button, 'Importing…')) return;
    try {
      const sourceMode = sourceTask.collaboration_mode || 'group';
      $$('input[name="performance_mode"]').forEach(input => { input.checked = input.value === sourceMode; });
      $$('input[name="grouping_creator"]').forEach(input => { input.checked = input.value === 'teacher'; });
      let importedCount = 0;
      let firstGroupCount = null;

      await withLoading('Importing past groups…', 'Loading the saved team members and leaders, then matching them with the current class roster.', async () => {
        for (const sectionId of sectionIds) {
          const pastTask = sourceBySection.get(sectionId);
          const data = await getTeacherPerformanceGroups(pastTask.id);
          const groups = savedGroupsForSection(sectionId, data, { adaptRoster: true, mode: sourceMode });
          if (!groups.length) throw new Error(`No saved groups were found for ${sectionById(sectionId)?.name || 'one selected class'}.`);
          setImportedGroupsForSection(sectionId, groups);
          performanceTeamOrders.delete(sectionId);
          importedCount += groups.length;
          if (firstGroupCount == null) firstGroupCount = groups.length;
        }
      });

      if (sourceMode === 'group' && $('#performanceGroupCount')) {
        $('#performanceGroupCount').value = String(Number(sourceTask.group_count || firstGroupCount || 1));
      }
      syncPerformanceTeamOptions();
      performanceGroupingDirty = true;
      performanceLeaderDirty = false;
      renderPerformanceTeamPreview();
      await window.MathsideActionButton.done(button, 'Imported ✓');
      toast(`Imported ${importedCount} saved group${importedCount === 1 ? '' : 's'} from "${sourceTask.title || 'past performance task'}".`, 'success');
    } catch (error) {
      window.MathsideActionButton?.reset(button);
      console.error(error);
      toast(friendlyErrorMessage(error, 'Could not import the past groups.'), 'orange');
    }
  }

  async function loadStoredTeacherGroupsIntoEditor(linkedTasks) {
    const teacherTasks = (linkedTasks || []).filter(task =>
      (task.collaboration_mode || 'individual') !== 'individual' &&
      (task.grouping_creator || 'teacher') === 'teacher'
    );
    if (!teacherTasks.length) return;
    for (const task of teacherTasks) {
      const data = await getTeacherPerformanceGroups(task.id);
      const groups = savedGroupsForSection(task.section_id, data, {
        adaptRoster: false,
        mode: task.collaboration_mode || 'group'
      });
      if (groups.length) setImportedGroupsForSection(task.section_id, groups);
    }
  }

  function generatePerformanceTeams() {
    const sectionIds = selectedPerformanceSections();
    clearImportedPerformanceGroups(sectionIds);
    sectionIds.forEach(sectionId => performanceTeamOrders.delete(sectionId));
    clearLeaderSelectionsForSections(sectionIds);
    performanceGroupingDirty = true;
    performanceLeaderDirty = false;
    renderPerformanceTeamPreview();
  }

  async function applyStoredPerformanceGrouping(task) {
    if (!task || task.collaboration_mode === 'individual') return;
    if ((task.grouping_creator || 'teacher') !== 'teacher') return;
    const groups = serializedPerformanceGroupsForSection(
      task.section_id,
      task.collaboration_mode,
      task.group_count || performanceGroupCount()
    );
    const result = await db.rpc('mathside_set_teacher_performance_groups', {
      p_assignment_id: task.id,
      p_groups: groups
    });
    if (result.error) throw result.error;
  }

  function resetPerformanceForm() {
    performanceLeaderSelections.clear();
    performanceTeamOrders.clear();
    performanceImportedGroups.clear();
    performanceGroupingDirty = false;
    performanceLeaderDirty = false;
    const form = $('#performanceTaskForm');
    form?.reset();
    if (form?.elements?.max_points) form.elements.max_points.value = '100';
    $('#performanceImagePreview').innerHTML = '';
    $('#performanceRubricExisting').innerHTML = '';
    $('#performanceRubricExisting').hidden = true;
    $('#removePerformanceImagesWrap').hidden = true;
    $('#removePerformanceRubricWrap').hidden = true;
    $('#performancePublishAtWrap').hidden = true;
    if ($('#performanceTeamPreview')) $('#performanceTeamPreview').innerHTML = '';
    editingPerformanceTaskId = null;
    editingPerformanceTaskIds = [];
    if ($('#performanceSectionEditNote')) $('#performanceSectionEditNote').hidden = true;
    if ($('#performanceClassHint')) $('#performanceClassHint').textContent = 'Select one or more';
    populatePerformanceSections();
    syncPerformanceTeamOptions();
  }

  function syncPerformancePublishFields() {
    const scheduled = $('#performancePublishMode')?.value === 'schedule';
    if ($('#performancePublishAtWrap')) $('#performancePublishAtWrap').hidden = !scheduled;
    if (!scheduled && $('#performancePublishAt')) $('#performancePublishAt').value = '';
  }

  async function openPerformanceTaskModal(taskId = null) {
    if (!activeSections().length) { toast('Create at least one active class before posting a performance task.', 'orange'); showTeacherView('classes'); return; }
    resetPerformanceForm();
    const task = taskId ? assignmentById(taskId) : null;
    if (taskId && (!task || !isPerformanceTask(task))) return toast('This performance task is no longer available.', 'orange');
    if (task) {
      const group = performanceGroupForId(task.id);
      editingPerformanceTaskId = task.id;
      editingPerformanceTaskIds = (group.length ? group : [task]).map(item => item.id);
      const form = $('#performanceTaskForm');
      form.elements.title.value = task.title || '';
      form.elements.instructions.value = task.instructions || '';
      form.elements.max_points.value = String(Number(task.max_points || 100));
      const isScheduled = task.status === 'draft' && task.publish_at && new Date(task.publish_at).getTime() > Date.now();
      form.elements.publish_mode.value = isScheduled ? 'schedule' : 'now';
      form.elements.publish_at.value = isScheduled ? formatDateTimeLocalInput(task.publish_at) : '';
      form.elements.due_at.value = formatDateTimeLocalInput(task.due_at);
      form.elements.reminder_hours_before.value = String(Number(task.reminder_hours_before || 0));
      form.elements.allow_resubmission.checked = Boolean(task.allow_resubmission);
      $$('input[name="performance_mode"]').forEach(input => { input.checked = input.value === (task.collaboration_mode || 'individual'); });
      $$('input[name="grouping_creator"]').forEach(input => { input.checked = input.value === (task.grouping_creator || 'teacher'); });
      if ($('#performanceGroupCount')) $('#performanceGroupCount').value = String(Number(task.group_count || 4));
      syncPerformancePublishFields();
      syncPerformanceTeamOptions();
      const linkedTasks = group.length ? group : [task];
      const sectionIds = new Set(linkedTasks.map(item => item.section_id));
      $$('input[name="performance_sections"]', $('#performanceSectionChecklist')).forEach(input => { input.checked = sectionIds.has(input.value); input.disabled = false; input.closest('.class-check-option')?.classList.toggle('editing-class-option', input.checked); });
      $('#performanceSectionEditNote').hidden = false;
      syncPerformanceEditingClasses();
      if ((task.collaboration_mode || 'individual') !== 'individual' && (task.grouping_creator || 'teacher') === 'teacher') {
        try { await loadStoredTeacherGroupsIntoEditor(linkedTasks); }
        catch (error) { console.error('Could not load saved teacher groups into editor', error); }
        renderPerformanceTeamPreview();
      }
      populatePastPerformanceGroupSources();
      const existingImages = assignmentTaskImages(task);
      if (existingImages.length) {
        $('#removePerformanceImagesWrap').hidden = false;
        const links = await signedLinks('mathside-assignment-images', existingImages, 1800);
        $('#performanceImagePreview').innerHTML = links.map((x,i)=>`<img src="${esc(x.url)}" alt="Existing task picture ${i+1}">`).join('');
      }
      if (task.rubric_path) {
        $('#removePerformanceRubricWrap').hidden = false;
        const url = await signedUrl('mathside-assignment-images', task.rubric_path, 1800);
        if (url) { $('#performanceRubricExisting').hidden = false; $('#performanceRubricExisting').innerHTML = `<a class="btn btn-light btn-small" href="${esc(url)}" target="_blank" rel="noopener">Open current rubric</a>`; }
      }
      $('#performanceTaskModalTitle').textContent = 'Edit performance task';
      $('#performanceTaskSubmitBtn').textContent = 'Save performance task';
    } else {
      $('#performanceTaskModalTitle').textContent = 'Create performance task';
      $('#performanceTaskSubmitBtn').textContent = 'Post performance task';
      populatePastPerformanceGroupSources();
    }
    openDialog('performanceTaskModal');
    window.MathsideCompetencies?.loadPerformance(editingPerformanceTaskIds || []);
  }

  $('#postPerformanceTaskBtn')?.addEventListener('click', () => openPerformanceTaskModal());
  $('#performancePublishMode')?.addEventListener('change', syncPerformancePublishFields);
  $('#performanceWorkMode')?.addEventListener('change', event => {
    const input = event.target.closest('input[name="performance_mode"]');
    if (!input) return;
    if (!input.checked) { input.checked = true; return; }
    $$('input[name="performance_mode"]').forEach(other => { if (other !== input) other.checked = false; });
    clearImportedPerformanceGroups();
    performanceTeamOrders.clear();
    performanceLeaderSelections.clear();
    performanceGroupingDirty = true;
    performanceLeaderDirty = false;
    syncPerformanceTeamOptions();
    populatePastPerformanceGroupSources();
    renderPerformanceTeamPreview();
  });
  $$('input[name="grouping_creator"]').forEach(input => input.addEventListener('change', () => {
    clearImportedPerformanceGroups();
    performanceTeamOrders.clear();
    performanceLeaderSelections.clear();
    performanceGroupingDirty = true;
    performanceLeaderDirty = false;
    syncPerformanceTeamOptions();
    populatePastPerformanceGroupSources();
    renderPerformanceTeamPreview();
  }));
  $('#performanceGroupCount')?.addEventListener('input', () => {
    const sectionIds = selectedPerformanceSections();
    clearImportedPerformanceGroups(sectionIds);
    clearLeaderSelectionsForSections(sectionIds);
    performanceGroupingDirty = true;
    performanceLeaderDirty = false;
    renderPerformanceTeamPreview();
  });
  function syncPerformanceEditingClasses() {
    if (!editingPerformanceTaskId) return;
    const selected = selectedPerformanceSections();
    if ($('#performanceClassHint')) $('#performanceClassHint').textContent = `${selected.length} selected · editable`;
    $$('input[name="performance_sections"]', $('#performanceSectionChecklist')).forEach(input => {
      input.closest('.class-check-option')?.classList.toggle('editing-class-option', input.checked);
    });
  }

  $('#performanceSectionChecklist')?.addEventListener('change', () => {
    syncPerformanceEditingClasses();
    populatePastPerformanceGroupSources();
    renderPerformanceTeamPreview();
  });
  $('#generatePerformanceTeamsBtn')?.addEventListener('click', generatePerformanceTeams);
  $('#reshufflePerformanceTeamsBtn')?.addEventListener('click', reshufflePerformanceTeams);
  $('#importPastPerformanceGroupsBtn')?.addEventListener('click', importPastPerformanceGroups);
  $('#performanceImages')?.addEventListener('change', event => {
    const files = [...(event.currentTarget.files || [])].slice(0, 8);
    $('#performanceImagePreview').innerHTML = files.map((file,i)=>`<figure><img src="${URL.createObjectURL(file)}" alt="Selected task picture ${i+1}"><figcaption>${esc(file.name)}</figcaption></figure>`).join('');
  });

  document.addEventListener('click', event => {
    const btn = event.target.closest('[data-edit-performance-task]');
    if (btn) openPerformanceTaskModal(btn.dataset.editPerformanceTask);
  });

  async function savePerformanceCopy(task, form, schedule, files, rubricFile, removeImages, removeRubric) {
    let imagePaths = assignmentTaskImages(task);
    let rubricPath = task.rubric_path || null;
    const uploaded = [];
    try {
      if (files.length) {
        const fresh = await uploadTeacherFiles(task.id, files, 'task');
        uploaded.push(...fresh);
        await removeStoragePaths('mathside-assignment-images', imagePaths);
        imagePaths = fresh;
      } else if (removeImages) {
        await removeStoragePaths('mathside-assignment-images', imagePaths);
        imagePaths = [];
      }
      if (rubricFile) {
        const [freshRubric] = await uploadTeacherFiles(task.id, [rubricFile], 'rubric');
        uploaded.push(freshRubric);
        if (rubricPath) await removeStoragePaths('mathside-assignment-images', [rubricPath]);
        rubricPath = freshRubric;
      } else if (removeRubric && rubricPath) {
        await removeStoragePaths('mathside-assignment-images', [rubricPath]);
        rubricPath = null;
      }
      const nextMode = performanceMode();
      if (nextMode === 'class') {
        const groups = serializedPerformanceGroupsForSection(task.section_id, 'class', 1);
        if (groups.length !== 1 || !groups[0].leader_id) throw new Error('Choose a class representative for each selected class.');
      }
      const nextCreator = ['individual','class'].includes(nextMode) ? 'teacher' : performanceGroupingCreator();
      const nextGroupCount = nextMode === 'class' ? 1 : nextMode === 'group' ? performanceGroupCount() : null;
      const setupChanged = (task.collaboration_mode || 'individual') !== nextMode
        || (task.grouping_creator || 'teacher') !== nextCreator
        || Number(task.group_count || 0) !== Number(nextGroupCount || 0);
      const update = await db.from('mathside_assignments').update({
        title: String(form.get('title') || '').trim(), instructions: String(form.get('instructions') || '').trim(),
        work_type:'performance_task', max_points:Number(form.get('max_points') || 100),
        due_at:schedule.dueAt, reminder_hours_before:schedule.dueAt ? schedule.reminderHours : 0,
        status:schedule.status, publish_at:schedule.publishAt, allow_resubmission:form.get('allow_resubmission') === 'on',
        collaboration_mode:nextMode, grouping_creator:nextCreator, group_count:nextGroupCount,
        image_path:imagePaths[0] || null, image_paths:imagePaths, rubric_path:rubricPath
      }).eq('id', task.id);
      if (update.error) throw update.error;
      const freshTask = { ...task, collaboration_mode:nextMode, grouping_creator:nextCreator, group_count:nextGroupCount };
      if ((setupChanged || performanceGroupingDirty) && freshTask.collaboration_mode !== 'individual' && freshTask.grouping_creator === 'teacher') {
        await applyStoredPerformanceGrouping(freshTask);
      } else if (performanceLeaderDirty && freshTask.collaboration_mode !== 'individual' && freshTask.grouping_creator === 'teacher') {
        const leaders = leaderAssignmentsForSection(task.section_id, nextMode, nextGroupCount);
        const leaderUpdate = await db.rpc('mathside_set_performance_group_leaders', {
          p_assignment_id: task.id,
          p_leaders: leaders
        });
        if (leaderUpdate.error) throw leaderUpdate.error;
      }
    } catch (error) {
      if (uploaded.length) await removeStoragePaths('mathside-assignment-images', uploaded);
      throw error;
    }
  }

  async function createPerformanceForAddedClass(source, sectionId) {
    const insert = await db.from('mathside_assignments').insert({
      section_id: sectionId, teacher_id: state.user.id,
      title: source.title, instructions: source.instructions,
      work_type: 'performance_task', max_points: source.max_points,
      due_at: source.due_at, reminder_hours_before: source.reminder_hours_before || 0,
      status: source.status, publish_at: source.publish_at,
      allow_resubmission: Boolean(source.allow_resubmission),
      collaboration_mode: source.collaboration_mode || 'individual',
      grouping_creator: source.grouping_creator || 'teacher',
      group_count: source.group_count || null, image_paths: []
    }).select().single();
    if (insert.error) throw insert.error;
    const created = insert.data;
    let copied = [];
    try {
      const oldImages = assignmentTaskImages(source);
      const oldRubric = source.rubric_path || null;
      copied = await copyMathsideFilesForSection([...oldImages, oldRubric].filter(Boolean), created.id, 'performance');
      const newImages = copied.slice(0, oldImages.length);
      const newRubric = oldRubric ? copied[oldImages.length] : null;
      const update = await db.from('mathside_assignments').update({
        image_path: newImages[0] || null, image_paths: newImages, rubric_path: newRubric
      }).eq('id', created.id);
      if (update.error) throw update.error;
      await applyStoredPerformanceGrouping({ ...created, section_id: sectionId });
      return created;
    } catch (error) {
      const remove = await db.from('mathside_assignments').delete().eq('id', created.id);
      if (remove.error) console.warn('Incomplete new-class performance task cleanup', remove.error);
      // Keep Cloudflare attachments intact if a class copy fails.
      throw error;
    }
  }

  function readPerformanceSchedule(form) {
    const dueRaw = String(form.get('due_at') || '').trim();
    let dueAt = null;
    if (dueRaw) { const d = new Date(dueRaw); if (Number.isNaN(d.getTime())) throw new Error('Enter a valid performance task deadline.'); dueAt = d.toISOString(); }
    const reminderHours = Number(form.get('reminder_hours_before') || 0);
    if (![0,24,48,72].includes(reminderHours)) throw new Error('Choose a valid student reminder.');
    if (!dueAt && reminderHours > 0) throw new Error('Choose a deadline before turning on a student reminder.');
    let publishAt = null, status = 'published';
    if (String(form.get('publish_mode') || 'now') === 'schedule') {
      const raw = String(form.get('publish_at') || '').trim();
      if (!raw) throw new Error('Choose when Mathside should post this performance task.');
      const d = new Date(raw); if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now() + 30000) throw new Error('Scheduled posting must be a valid future date and time.');
      publishAt = d.toISOString(); status = 'draft';
    }
    if (dueAt && publishAt && new Date(dueAt) <= new Date(publishAt)) throw new Error('The performance task deadline must be after the scheduled posting time.');
    return { dueAt, reminderHours, publishAt, status };
  }

  $('#performanceTaskForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!requireSupabase()) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') || '').trim();
    const instructions = String(form.get('instructions') || '').trim();
    const maxPoints = Number(form.get('max_points') || 0);
    if (!title || !instructions) return toast('Add a title and instructions for the performance task.', 'orange');
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) return toast('Total points must be greater than zero.', 'orange');
    const sectionIds = selectedPerformanceSections();
    if (!sectionIds.length) return toast('Select at least one class for this performance task.', 'orange');
    const mode = performanceMode();
    const groupingCreator = ['individual','class'].includes(mode) ? 'teacher' : performanceGroupingCreator();
    const groupCount = mode === 'class' ? 1 : mode === 'group' ? performanceGroupCount() : null;
    if (mode === 'class') {
      for (const sectionId of sectionIds) {
        const groups = serializedPerformanceGroupsForSection(sectionId, 'class', 1);
        if (groups.length !== 1 || !groups[0].leader_id)
          return toast(`Choose a class representative for ${sectionById(sectionId)?.name || 'every class'} before posting.`, 'orange');
      }
    }
    if (mode === 'group' && !groupCount) return toast('Enter how many groups you want for each class.', 'orange');
    const taskImages = [...($('#performanceImages')?.files || [])];
    if (taskImages.length > 8) return toast('Upload up to 8 reference pictures.', 'orange');
    if (taskImages.some(file => !String(file.type || '').startsWith('image/'))) return toast('Reference pictures must be image files.', 'orange');
    const rubricFile = $('#performanceRubric')?.files?.[0] || null;
    let schedule;
    try { schedule = readPerformanceSchedule(form); }
    catch (error) { return toast(friendlyErrorMessage(error, 'Could not check this performance task.'), 'orange', 'Check performance task'); }

    const competencyPreflight = await window.MathsideCompetencies?.validateSelection?.('ctPerformanceCompetency');
    if (competencyPreflight?.ok === false) {
      return toast(competencyPreflight.message, 'orange', 'Competency tagging is unavailable');
    }
    const submitBtn = $('#performanceTaskSubmitBtn');
    if (!window.MathsideActionButton?.start(submitBtn, editingPerformanceTaskId ? 'Updating…' : 'Posting…')) return;

    if (editingPerformanceTaskId) {
      const copies = editingPerformanceTaskIds.map(id => assignmentById(id)).filter(Boolean);
      if (!copies.length) { window.MathsideActionButton?.reset(submitBtn); return toast('This performance task is no longer available. Refresh and try again.', 'orange'); }
      const targetIds = new Set(sectionIds);
      const retained = copies.filter(task => targetIds.has(task.section_id));
      const oldIds = new Set(copies.map(task => task.section_id));
      const newlyAssigned = sectionIds.filter(id => !oldIds.has(id));
      const removedCount = copies.length - retained.length;
      const newlyCreatedTaskIds = [];
      let competencyTagResult = {ok:true};
      try {
        await withLoading(`Saving performance task for ${sectionIds.length} class${sectionIds.length === 1 ? '' : 'es'}…`, 'Keeping submitted work, scores, and existing group records in their original classes.', async () => {
          for (const task of retained) await savePerformanceCopy(task, form, schedule, taskImages, rubricFile, $('#removePerformanceImages')?.checked, $('#removePerformanceRubric')?.checked);
          let source = retained[0] || copies[0];
          if (!retained.length && newlyAssigned.length) {
            await savePerformanceCopy(source, form, schedule, taskImages, rubricFile, $('#removePerformanceImages')?.checked, $('#removePerformanceRubric')?.checked);
          }
          if (newlyAssigned.length) {
            const fetched = await db.from('mathside_assignments').select('*').eq('id', source.id).single();
            if (fetched.error) throw fetched.error;
            for (const sectionId of newlyAssigned) {
              const taskCopy = await createPerformanceForAddedClass(fetched.data, sectionId);
              newlyCreatedTaskIds.push(taskCopy.id);
            }
          }
          await hideDeselectedClassCopies(copies, sectionIds);
          editingPerformanceTaskId = null; editingPerformanceTaskIds = [];
          competencyTagResult = await window.MathsideCompetencies?.linkPerformance([...retained.map(t=>t.id), ...newlyCreatedTaskIds]) || {ok:true};
          await refreshTeacher(); showTeacherView('performance');
        });
        await window.MathsideActionButton.done(submitBtn, 'Done');
        closeDialog('performanceTaskModal');
        toast(competencyTagResult.ok === false
          ? `Performance task saved, but its competency was not linked. ${competencyTagResult.message} Open Competencies > Manage activity assignments to retry.`
          : `Performance task saved for ${sectionIds.length} class${sectionIds.length === 1 ? '' : 'es'}.${newlyAssigned.length ? ` Added to ${newlyAssigned.length} new class${newlyAssigned.length === 1 ? '' : 'es'}.` : ''}${removedCount ? ` Removed from ${removedCount} class${removedCount === 1 ? '' : 'es'} (old submissions and scores kept).` : ''}`,
          competencyTagResult.ok === false ? 'orange' : 'success');
      } catch (error) { window.MathsideActionButton?.reset(submitBtn); console.error(error); toast(friendlyErrorMessage(error, 'Could not save the performance task.'), 'orange'); }
      return;
    }

    const created = [], uploaded = [];
    let competencyTagResult = {ok:true};
    try {
      await withLoading(`Creating performance task for ${sectionIds.length} class${sectionIds.length===1?'':'es'}…`, 'Saving the performance task, pictures, rubric, deadline, team settings, and notifications.', async () => {
        for (const sectionId of sectionIds) {
          const insert = await db.from('mathside_assignments').insert({
            section_id:sectionId, teacher_id:state.user.id, title, instructions, work_type:'performance_task', max_points:maxPoints,
            due_at:schedule.dueAt, reminder_hours_before:schedule.dueAt ? schedule.reminderHours : 0,
            status:'draft', publish_at:schedule.publishAt, allow_resubmission:form.get('allow_resubmission') === 'on', image_paths:[],
            collaboration_mode:mode, grouping_creator:groupingCreator, group_count:groupCount
          }).select().single();
          if (insert.error) throw insert.error;
          const task = insert.data; created.push(task);
          const imagePaths = taskImages.length ? await uploadTeacherFiles(task.id, taskImages, 'task') : [];
          uploaded.push(...imagePaths);
          let rubricPath = null;
          if (rubricFile) { [rubricPath] = await uploadTeacherFiles(task.id, [rubricFile], 'rubric'); uploaded.push(rubricPath); }
          const update = await db.from('mathside_assignments').update({ image_path:imagePaths[0] || null, image_paths:imagePaths, rubric_path:rubricPath, status:schedule.status, publish_at:schedule.publishAt }).eq('id', task.id);
          if (update.error) throw update.error;
          if (mode !== 'individual' && groupingCreator === 'teacher') await applyStoredPerformanceGrouping({ ...task, collaboration_mode:mode, grouping_creator:groupingCreator, group_count:groupCount });
        }
        competencyTagResult = await window.MathsideCompetencies?.linkPerformance(created.map(t=>t.id)) || {ok:true};
        await refreshTeacher(); showTeacherView('performance');
      });
      await window.MathsideActionButton.done(submitBtn, 'Done');
      closeDialog('performanceTaskModal');
      toast(competencyTagResult.ok === false
        ? `Performance task saved, but its competency was not linked. ${competencyTagResult.message} Open Competencies > Manage activity assignments to retry.`
        : (schedule.status === 'draft' ? `Performance task scheduled for ${formatDeadlineDate(schedule.publishAt)}.` : `Performance task posted to ${sectionIds.length} class${sectionIds.length===1?'':'es'}.`),
        competencyTagResult.ok === false ? 'orange' : 'success');
    } catch (error) {
      window.MathsideActionButton?.reset(submitBtn);
      console.error(error);
      if (uploaded.length) await removeStoragePaths('mathside-assignment-images', uploaded);
      const ids = created.map(x=>x.id); if (ids.length) try { await db.from('mathside_assignments').delete().in('id',ids); } catch {}
      toast(friendlyErrorMessage(error, 'Could not post the performance task.'), 'orange');
    }
  });

  function performanceTaskGroupState(group) {
    const a = group[0];
    const archived = group.every(item => item.status === 'archived');
    const scheduled = !archived && group.some(item => item.status === 'draft' && item.publish_at && new Date(item.publish_at).getTime() > Date.now());
    return archived ? 'archived' : scheduled ? 'scheduled' : 'posted';
  }

  function syncPerformanceTaskFilterUi() {
    const sectionSelect = $('#performanceTaskSectionFilter');
    if (sectionSelect) {
      const activeIds = new Set(activeSections().map(section => section.id));
      if (performanceTaskSectionFilter !== 'all' && !activeIds.has(performanceTaskSectionFilter)) performanceTaskSectionFilter = 'all';
      sectionSelect.innerHTML = `<option value="all">All sections</option>` + activeSections().map(section => `<option value="${esc(section.id)}">${esc(section.name)} · Grade ${esc(section.grade_level)}</option>`).join('');
      sectionSelect.value = performanceTaskSectionFilter;
    }
    if ($('#performanceTaskStatusFilter')) $('#performanceTaskStatusFilter').value = performanceTaskStatusFilter;
    if ($('#performanceTaskModeFilter')) $('#performanceTaskModeFilter').value = performanceTaskModeFilter;
    if ($('#performanceTaskSort')) $('#performanceTaskSort').value = performanceTaskSort;
    const activeCount = Number(performanceTaskSectionFilter !== 'all') + Number(performanceTaskStatusFilter !== 'all') + Number(performanceTaskModeFilter !== 'all') + Number(performanceTaskSort !== 'newest');
    const badge = $('#performanceTaskFilterBadge');
    if (badge) { badge.textContent = String(activeCount); badge.hidden = activeCount === 0; }
  }

  function renderPerformanceTasks() {
    const list = $('#performanceTaskList');
    if (!list) return;
    performanceTaskStatusFilter = ['all','posted','scheduled'].includes(performanceTaskStatusFilter) ? performanceTaskStatusFilter : 'all';
    performanceTaskModeFilter = ['all','individual','pair','group','class'].includes(performanceTaskModeFilter) ? performanceTaskModeFilter : 'all';
    performanceTaskSort = ['newest','name','name-desc','due'].includes(performanceTaskSort) ? performanceTaskSort : 'newest';
    syncPerformanceTaskFilterUi();
    let groups = performanceGroups().filter(group => {
      if (performanceTaskGroupState(group) === 'archived') return false;
      if (performanceTaskSectionFilter !== 'all' && !group.some(task => task.section_id === performanceTaskSectionFilter)) return false;
      if (performanceTaskStatusFilter !== 'all' && performanceTaskGroupState(group) !== performanceTaskStatusFilter) return false;
      const mode = group[0]?.collaboration_mode || 'individual';
      return performanceTaskModeFilter === 'all' || mode === performanceTaskModeFilter;
    });
    groups.sort((ga, gb) => {
      const a = ga[0], b = gb[0];
      const nameA = String(a?.title || ''), nameB = String(b?.title || '');
      if (performanceTaskSort === 'name') return nameA.localeCompare(nameB, undefined, { sensitivity:'base' });
      if (performanceTaskSort === 'name-desc') return nameB.localeCompare(nameA, undefined, { sensitivity:'base' });
      if (performanceTaskSort === 'due') {
        const ad = a?.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
        const bd = b?.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
        return ad - bd || nameA.localeCompare(nameB, undefined, { sensitivity:'base' });
      }
      return new Date(b?.created_at || b?.publish_at || 0) - new Date(a?.created_at || a?.publish_at || 0);
    });
    if (!groups.length) {
      const hasFilter = performanceTaskSectionFilter !== 'all' || performanceTaskStatusFilter !== 'all' || performanceTaskModeFilter !== 'all' || performanceTaskSort !== 'newest';
      list.innerHTML = `<div class="assignment-empty v9-empty"><span class="v9-empty-icon">▣</span><b>${hasFilter?'No performance tasks match these filters':'No performance tasks yet'}</b><p>${hasFilter?'Tap Filter and choose another section or status.':'Post a task with instructions, pictures, rubric, deadline, and assigned sections.'}</p></div>`;
      return;
    }
    list.innerHTML = groups.map(group => {
      const a = group[0], ids = group.map(x=>x.id), labels = groupSectionLabels(group);
      const scheduled = performanceTaskGroupState(group) === 'scheduled';
      const archived = performanceTaskGroupState(group) === 'archived';
      const images = assignmentTaskImages(a);
      const classList = labels.length > 1 ? `<div class="assignment-class-list">${labels.map(x=>`<span>${esc(x)}</span>`).join('')}</div>` : '';
      return `<article class="assignment-card assignment-group-card performance-task-card performance-group-card ${scheduled?'assignment-scheduled':''} ${archived?'assignment-archived':''}">
        <div class="assignment-thumb performance-thumb">${a.image_url?`<img src="${esc(a.image_url)}" alt="Performance task picture" data-assignment-storage-path="${esc(a.image_path||'')}">`:'▣'}</div>
        <div class="assignment-card-body"><div class="assignment-title-line"><h3>${esc(a.title)}</h3>${group.length>1?'<span class="shared-assignment-badge">Shared performance task</span>':''}${scheduled?'<span class="scheduled-badge">Scheduled</span>':''}${archived?'<span class="archived-badge">Archived</span>':''}</div><p>${esc(a.instructions || 'Performance task')}</p>${classList}<div class="assignment-meta"><span class="meta-chip">${labels.length===1?esc(labels[0]):`${labels.length} classes`}</span><span class="meta-chip">${Number(a.max_points||0)} pts</span><span class="meta-chip">${esc(collaborationLabel(a))}</span>${a.due_at?`<span class="meta-chip">Due ${esc(formatDeadlineDate(a.due_at))}</span>`:''}${images.length?`<span class="meta-chip">${images.length} picture${images.length===1?'':'s'}</span>`:''}${a.rubric_path?'<span class="meta-chip rubric-chip">Rubric attached</span>':''}${scheduled?`<span class="meta-chip scheduled-chip">Posts ${esc(formatDeadlineDate(a.publish_at))}</span>`:''}</div></div>
        <div class="assignment-card-actions"><button class="btn btn-light" data-preview-assignment="${a.id}">Preview</button>${archived?`<button class="btn btn-unarchive" data-unarchive-assignment-group="${esc(ids.join(','))}">Unarchive</button>`:`<button class="btn btn-light" data-edit-performance-task="${a.id}">Edit</button><button class="btn btn-archive" data-archive-assignment-group="${esc(ids.join(','))}">Archive</button>`}<button class="btn btn-danger-outline" data-delete-assignment-group="${esc(ids.join(','))}">Delete</button></div>
      </article>`;
    }).join('');
  }
  window.renderPerformanceTasks = renderPerformanceTasks;

  // ---------------------------------------------------------------
  // ARCHIVE CENTER — classes, activities and performance tasks
  // ---------------------------------------------------------------
  function archiveRecordTime(value, fallback) {
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) && time > 0 ? time : (fallback ? new Date(fallback).getTime() : 0);
  }

  function archiveDateLabel(value) {
    if (!value) return 'Archived';
    try { return `Archived ${formatDeadlineDate(value)}`; }
    catch (_) { return 'Archived'; }
  }

  function archivedWrittenGroups() {
    return groupedAssignmentsForDisplay().filter(group => group.length && !isPerformanceTask(group[0]) && group.every(item => item.status === 'archived'));
  }

  function archivedPerformanceGroups() {
    return performanceGroups().filter(group => group.length && group.every(item => item.status === 'archived'));
  }

  function syncArchiveFilterUi() {
    const category = $('#archiveCategoryFilter');
    const sort = $('#archiveSort');
    if (category) category.value = archiveCategoryFilter;
    if (sort) sort.value = archiveSort;
    const activeCount = Number(archiveCategoryFilter !== 'all') + Number(archiveSort !== 'newest');
    const badge = $('#archiveFilterBadge');
    if (badge) { badge.textContent = String(activeCount); badge.hidden = activeCount === 0; }
  }

  function archiveClassCard(section) {
    const students = studentsForSection(section.id).length;
    return `<article class="archive-record archive-record-class">
      <div class="archive-record-icon">${iconSvg('class','assignment-line-icon')}</div>
      <div class="archive-record-body"><div class="archive-record-title"><span class="archive-type-pill">Class</span><h3>${esc(section.name)}</h3></div><p>Grade ${esc(section.grade_level)} · ${students} student${students===1?'':'s'}</p><div class="assignment-meta"><span class="meta-chip">${esc(archiveDateLabel(section.archived_at))}</span></div></div>
      <div class="archive-record-actions"><button class="btn btn-light" type="button" data-view-class-students="${esc(section.id)}">View students</button><button class="btn btn-unarchive" type="button" data-unarchive-class="${esc(section.id)}">Unarchive</button><button class="btn btn-light" type="button" data-create-from-archive="${esc(section.id)}">Reuse students</button><button class="btn btn-danger-outline" type="button" data-delete-class="${esc(section.id)}">Delete</button></div>
    </article>`;
  }

  function archiveActivityCard(group) {
    const a = group[0];
    const ids = group.map(item => item.id);
    const labels = assignmentGroupSectionLabels(group);
    return `<article class="archive-record archive-record-activity">
      <div class="archive-record-icon">${iconSvg('assignment','assignment-line-icon')}</div>
      <div class="archive-record-body"><div class="archive-record-title"><span class="archive-type-pill">Activity</span><h3>${esc(a.title)}</h3></div><p>${esc(a.instructions || 'Mathematics activity')}</p><div class="assignment-meta"><span class="meta-chip">${labels.length===1?esc(labels[0]):`${labels.length} classes`}</span><span class="meta-chip">${esc(archiveDateLabel(a.archived_at))}</span></div></div>
      <div class="archive-record-actions"><button class="btn btn-light" data-preview-assignment="${esc(a.id)}">Preview</button><button class="btn btn-unarchive" data-unarchive-assignment-group="${esc(ids.join(','))}">Unarchive</button><button class="btn btn-danger-outline" data-delete-assignment-group="${esc(ids.join(','))}">Delete</button></div>
    </article>`;
  }

  function archivePerformanceCard(group) {
    const a = group[0];
    const ids = group.map(item => item.id);
    const labels = groupSectionLabels(group);
    return `<article class="archive-record archive-record-performance">
      <div class="archive-record-icon">▣</div>
      <div class="archive-record-body"><div class="archive-record-title"><span class="archive-type-pill">Performance Task</span><h3>${esc(a.title)}</h3></div><p>${esc(a.instructions || 'Performance task')}</p><div class="assignment-meta"><span class="meta-chip">${labels.length===1?esc(labels[0]):`${labels.length} classes`}</span><span class="meta-chip">${esc(collaborationLabel(a))}</span><span class="meta-chip">${esc(archiveDateLabel(a.archived_at))}</span></div></div>
      <div class="archive-record-actions"><button class="btn btn-light" data-preview-assignment="${esc(a.id)}">Preview</button><button class="btn btn-unarchive" data-unarchive-assignment-group="${esc(ids.join(','))}">Unarchive</button><button class="btn btn-danger-outline" data-delete-assignment-group="${esc(ids.join(','))}">Delete</button></div>
    </article>`;
  }

  function renderArchiveCenter() {
    const list = $('#archiveList');
    if (!list) return;
    archiveCategoryFilter = ['all','class','activity','performance'].includes(archiveCategoryFilter) ? archiveCategoryFilter : 'all';
    archiveSort = ['newest','oldest','name','name-desc'].includes(archiveSort) ? archiveSort : 'newest';
    syncArchiveFilterUi();

    const classes = state.sections.filter(section => Boolean(section.archived_at));
    const activities = archivedWrittenGroups();
    const performance = archivedPerformanceGroups();
    $('#archivedClassCount') && ($('#archivedClassCount').textContent = String(classes.length));
    $('#archivedActivityCount') && ($('#archivedActivityCount').textContent = String(activities.length));
    $('#archivedPerformanceCount') && ($('#archivedPerformanceCount').textContent = String(performance.length));

    let records = [
      ...classes.map(section => ({ category:'class', name:String(section.name||''), time:archiveRecordTime(section.archived_at, section.created_at), html:archiveClassCard(section) })),
      ...activities.map(group => ({ category:'activity', name:String(group[0]?.title||''), time:Math.max(...group.map(a=>archiveRecordTime(a.archived_at,a.created_at))), html:archiveActivityCard(group) })),
      ...performance.map(group => ({ category:'performance', name:String(group[0]?.title||''), time:Math.max(...group.map(a=>archiveRecordTime(a.archived_at,a.created_at))), html:archivePerformanceCard(group) }))
    ];
    if (archiveCategoryFilter !== 'all') records = records.filter(record => record.category === archiveCategoryFilter);
    records.sort((a,b) => {
      if (archiveSort === 'oldest') return a.time - b.time || a.name.localeCompare(b.name, undefined, {sensitivity:'base'});
      if (archiveSort === 'name') return a.name.localeCompare(b.name, undefined, {sensitivity:'base'});
      if (archiveSort === 'name-desc') return b.name.localeCompare(a.name, undefined, {sensitivity:'base'});
      return b.time - a.time || a.name.localeCompare(b.name, undefined, {sensitivity:'base'});
    });

    if (!records.length) {
      const filtered = archiveCategoryFilter !== 'all';
      list.innerHTML = `<div class="assignment-empty v9-empty archive-empty"><span class="v9-empty-icon">▤</span><b>${filtered?'No archived items in this category':'Archive is empty'}</b><p>${filtered?'Choose another category from Filter.':'Archived classes, activities, and performance tasks will appear here.'}</p></div>`;
      return;
    }
    list.innerHTML = records.map(record => record.html).join('');
  }
  window.renderArchiveCenter = renderArchiveCenter;

  function setCompactFilterPanel(buttonId, panelId, open) {
    const button = $(buttonId), panel = $(panelId);
    if (!button || !panel) return;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  $('#archiveFilterBtn')?.addEventListener('click', () => {
    const panel = $('#archiveFilterPanel');
    setCompactFilterPanel('#archiveFilterBtn', '#archiveFilterPanel', Boolean(panel?.hidden));
  });
  $('#archiveFilterClose')?.addEventListener('click', () => setCompactFilterPanel('#archiveFilterBtn', '#archiveFilterPanel', false));
  $('#archiveFilterDone')?.addEventListener('click', () => setCompactFilterPanel('#archiveFilterBtn', '#archiveFilterPanel', false));
  $('#archiveCategoryFilter')?.addEventListener('change', event => { archiveCategoryFilter = event.currentTarget.value || 'all'; renderArchiveCenter(); });
  $('#archiveSort')?.addEventListener('change', event => { archiveSort = event.currentTarget.value || 'newest'; renderArchiveCenter(); });
  $('#archiveClearFilters')?.addEventListener('click', () => { archiveCategoryFilter = 'all'; archiveSort = 'newest'; renderArchiveCenter(); });

  $('#activityFilterBtn')?.addEventListener('click', () => {
    const panel = $('#activityFilterPanel');
    setCompactFilterPanel('#activityFilterBtn', '#activityFilterPanel', Boolean(panel?.hidden));
  });
  $('#activityFilterClose')?.addEventListener('click', () => setCompactFilterPanel('#activityFilterBtn', '#activityFilterPanel', false));
  $('#activityFilterDone')?.addEventListener('click', () => setCompactFilterPanel('#activityFilterBtn', '#activityFilterPanel', false));
  $('#activitySectionFilter')?.addEventListener('change', event => { activitySectionFilter = event.currentTarget.value || 'all'; selectedAssignmentIds.clear(); renderAssignments(); });
  $('#activityStatusFilter')?.addEventListener('change', event => { activityStatusFilter = event.currentTarget.value || 'all'; selectedAssignmentIds.clear(); renderAssignments(); });
  $('#activitySort')?.addEventListener('change', event => { activitySort = event.currentTarget.value || 'newest'; selectedAssignmentIds.clear(); renderAssignments(); });
  $('#activityClearFilters')?.addEventListener('click', () => {
    activitySectionFilter = 'all'; activityStatusFilter = 'all'; activitySort = 'newest'; selectedAssignmentIds.clear(); renderAssignments();
  });

  $('#performanceTaskFilterBtn')?.addEventListener('click', () => {
    const panel = $('#performanceTaskFilterPanel');
    setCompactFilterPanel('#performanceTaskFilterBtn', '#performanceTaskFilterPanel', Boolean(panel?.hidden));
  });
  $('#performanceTaskFilterClose')?.addEventListener('click', () => setCompactFilterPanel('#performanceTaskFilterBtn', '#performanceTaskFilterPanel', false));
  $('#performanceTaskFilterDone')?.addEventListener('click', () => setCompactFilterPanel('#performanceTaskFilterBtn', '#performanceTaskFilterPanel', false));
  $('#performanceTaskSectionFilter')?.addEventListener('change', event => { performanceTaskSectionFilter = event.currentTarget.value || 'all'; renderPerformanceTasks(); });
  $('#performanceTaskStatusFilter')?.addEventListener('change', event => { performanceTaskStatusFilter = event.currentTarget.value || 'all'; renderPerformanceTasks(); });
  $('#performanceTaskModeFilter')?.addEventListener('change', event => { performanceTaskModeFilter = event.currentTarget.value || 'all'; renderPerformanceTasks(); });
  $('#performanceTaskSort')?.addEventListener('change', event => { performanceTaskSort = event.currentTarget.value || 'newest'; renderPerformanceTasks(); });
  $('#performanceTaskClearFilters')?.addEventListener('click', () => {
    performanceTaskSectionFilter = 'all'; performanceTaskStatusFilter = 'all'; performanceTaskModeFilter = 'all'; performanceTaskSort = 'newest'; renderPerformanceTasks();
  });

  async function getTeacherPerformanceGroups(assignmentId) {
    const result = await db.rpc('mathside_get_performance_groups_for_teacher', { p_assignment_id: assignmentId });
    if (result.error) throw result.error;
    return result.data || { groups: [], ungrouped: [] };
  }

  async function renderStudentCreatedTeamLeaderManager(linkedTasks) {
    const box = $('#performancePreviewTeamManager');
    if (!box) return;
    const relevant = (linkedTasks || []).filter(task =>
      (task.collaboration_mode || 'individual') !== 'individual'
    );
    if (!relevant.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '<div class="performance-team-manager-loading"><span class="loading-mini-spinner"></span><p>Loading student-created teams…</p></div>';
    try {
      const rows = await Promise.all(relevant.map(async task => ({
        task,
        data: await getTeacherPerformanceGroups(task.id)
      })));
      box.innerHTML = `<div class="performance-team-manager-head"><div><p class="eyebrow">TEAM LEADERS</p><h3>Edit group leaders</h3><p>You can change a group leader even after the Performance Task has been posted. Group members stay unchanged.</p></div></div>${rows.map(({task,data}) => {
        const section = sectionById(task.section_id);
        const groups = Array.isArray(data.groups) ? data.groups : [];
        const ungrouped = Array.isArray(data.ungrouped) ? data.ungrouped : [];
        const creatorLabel = (task.grouping_creator || 'teacher') === 'teacher' ? 'Teacher-created groups' : 'Student-created groups';
        return `<section class="performance-formed-team-section" data-team-manager-assignment="${esc(task.id)}"><div class="performance-formed-team-section-head"><div><b>${esc(section?.name || 'Class')}</b><small>Grade ${esc(section?.grade_level || '')} · ${esc(creatorLabel)}</small></div><span>${groups.length} team${groups.length===1?'':'s'} formed</span></div>${groups.length ? `<div class="performance-formed-team-grid">${groups.map(group => {
          const members = Array.isArray(group.members) ? group.members : [];
          return `<article class="performance-formed-team-card"><div class="performance-formed-team-title"><b>${esc(group.name || 'Team')}</b>${group.leader_id ? '<span>Leader selected</span>' : '<span class="needs-leader">Needs leader</span>'}</div><label class="performance-leader-picker"><span>Team leader</span><select data-student-team-leader-select data-assignment-id="${esc(task.id)}" data-group-id="${esc(group.id)}"><option value="">Choose leader</option>${members.map(member => `<option value="${esc(member.id)}" ${member.id===group.leader_id?'selected':''}>${esc(member.display_name || 'Student')}</option>`).join('')}</select></label><div class="performance-team-members">${members.map(member => `<span>${member.id===group.leader_id?'<strong>Leader</strong> ':''}${esc(member.display_name || 'Student')}</span>`).join('')}</div></article>`;
        }).join('')}</div>` : '<p class="muted performance-no-formed-teams">No teams have been formed in this class yet.</p>'}${ungrouped.length ? `<div class="performance-ungrouped-students"><b>Still without a team</b><span>${ungrouped.map(student => esc(student.display_name || 'Student')).join(', ')}</span></div>` : ''}</section>`;
      }).join('')}<div class="performance-team-manager-actions"><button type="button" class="btn btn-orange" data-save-student-team-leaders>Save team leaders</button></div>`;
    } catch (error) {
      console.error(error);
      box.innerHTML = `<div class="performance-team-manager-error"><b>Could not load the teams.</b><p>${esc(friendlyErrorMessage(error, 'Check your connection, then reopen this preview.'))}</p></div>`;
    }
  }

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-save-student-team-leaders]');
    if (!btn) return;
    const box = $('#performancePreviewTeamManager');
    const selects = $$('[data-student-team-leader-select]', box);
    if (!selects.length) return toast('There are no formed teams to update yet.', 'orange');
    if (selects.some(select => !select.value)) return toast('Choose a leader for every formed team before saving.', 'orange');
    const byAssignment = new Map();
    selects.forEach(select => {
      const assignmentId = select.dataset.assignmentId;
      if (!byAssignment.has(assignmentId)) byAssignment.set(assignmentId, []);
      byAssignment.get(assignmentId).push({ group_id: select.dataset.groupId, leader_id: select.value });
    });
    if (!window.MathsideActionButton?.start(btn, 'Saving…')) return;
    try {
      await withLoading('Saving team leaders…','Updating who can submit each team output.', async () => {
        for (const [assignmentId, leaders] of byAssignment.entries()) {
          const result = await db.rpc('mathside_set_performance_group_leaders', { p_assignment_id: assignmentId, p_leaders: leaders });
          if (result.error) throw result.error;
        }
      });
      await window.MathsideActionButton.done(btn, 'Done');
      toast('Team leaders saved. The selected leaders can now submit.', 'success');
      const activeTask = assignmentById(activePerformanceTaskId);
      const group = activeTask ? performanceGroupForId(activeTask.id) : [];
      await renderStudentCreatedTeamLeaderManager(group.length ? group : (activeTask ? [activeTask] : []));
    } catch (error) {
      window.MathsideActionButton?.reset(btn);
      console.error(error);
      toast(friendlyErrorMessage(error, 'Could not save the team leaders.'), 'orange');
    }
  });

  // ---------------------------------------------------------------
  // PREVIEW
  // ---------------------------------------------------------------
  openAssignmentPreview = async function(id) {
    const task = assignmentById(id);
    if (!task || !isPerformanceTask(task)) {
      const previewModal = $('#assignmentPreviewModal');
      const topEyebrow = $(':scope > .modal-box > .eyebrow', previewModal);
      const detailsHeading = $('.assignment-preview-details h3', previewModal);
      if (topEyebrow) topEyebrow.textContent = 'ACTIVITY PREVIEW';
      if (detailsHeading) detailsHeading.textContent = 'Activity information';
      const questionSection = $('.assignment-preview-questions', previewModal);
      if (questionSection) questionSection.hidden = false;
      const resources = $('#performancePreviewResources');
      if (resources) resources.hidden = true;
      if ($('#performancePreviewTeamManager')) { $('#performancePreviewTeamManager').hidden = true; $('#performancePreviewTeamManager').innerHTML = ''; }
      return originalOpenAssignmentPreview(id);
    }
    const group = performanceGroupForId(id); const linked = group.length ? group : [task];
    activePerformanceTaskId = id;
    const previewModal = $('#assignmentPreviewModal');
    const topEyebrow = $(':scope > .modal-box > .eyebrow', previewModal);
    const detailsHeading = $('.assignment-preview-details h3', previewModal);
    if (topEyebrow) topEyebrow.textContent = 'PERFORMANCE TASK PREVIEW';
    if (detailsHeading) detailsHeading.textContent = 'Performance task information';
    $('#assignmentPreviewTitle').textContent = task.title || 'Performance Task';
    $('#assignmentPreviewInstructions').textContent = task.instructions || 'No additional instructions were provided.';
    const scheduled = task.status === 'draft' && task.publish_at;
    const details = [
      ['Type','Performance Task'], ['Classes',groupSectionLabels(linked).join(', ') || 'No class selected'],
      ['Work setup',collaborationLabel(task)],
      ...((task.collaboration_mode || 'individual') !== 'individual' ? [['Team creation',(task.grouping_creator || 'teacher') === 'teacher' ? 'Teacher creates teams' : 'Students create teams']] : []),
      ['Posting',scheduled?`Scheduled for ${formatDeadlineDate(task.publish_at)}`:'Posted immediately'],
      ['Deadline',task.due_at?formatDeadlineDate(task.due_at):'No deadline'],
      ['Student reminder',task.due_at?reminderLabel(task.reminder_hours_before):'No reminder'],
      ['Total points',`${Number(task.max_points||0)} points`]
    ];
    $('#assignmentPreviewDetails').innerHTML = details.map(([l,v])=>`<article><span>${esc(l)}</span><b>${esc(v)}</b></article>`).join('');
    const qSection = $('.assignment-preview-questions', $('#assignmentPreviewModal')); if (qSection) qSection.hidden = true;
    const resources = $('#performancePreviewResources'); resources.hidden = false;
    const images = await signedLinks('mathside-assignment-images', assignmentTaskImages(task), 1800);
    $('#performancePreviewImages').innerHTML = images.length ? images.map((x,i)=>`<a href="${esc(x.url)}" target="_blank" rel="noopener"><img src="${esc(x.url)}" alt="Task picture ${i+1}"></a>`).join('') : '<p class="muted">No reference pictures attached.</p>';
    if (task.rubric_path) {
      const url = await signedUrl('mathside-assignment-images', task.rubric_path, 1800);
      $('#performancePreviewRubric').innerHTML = url ? `<a class="btn btn-light" href="${esc(url)}" target="_blank" rel="noopener">Open rubric</a>` : '<p class="muted">Rubric file is unavailable.</p>';
    } else $('#performancePreviewRubric').innerHTML = '<p class="muted">No rubric attached.</p>';
    await renderStudentCreatedTeamLeaderManager(linked);
    openDialog('assignmentPreviewModal');
  };
  $('#assignmentPreviewModal')?.addEventListener('close', () => {
    const q = $('.assignment-preview-questions', $('#assignmentPreviewModal')); if (q) q.hidden = false;
    if ($('#performancePreviewResources')) $('#performancePreviewResources').hidden = true;
    if ($('#performancePreviewTeamManager')) { $('#performancePreviewTeamManager').hidden = true; $('#performancePreviewTeamManager').innerHTML = ''; }
  });

  // ---------------------------------------------------------------
  // SUBMISSIONS: category > section > activity; newest by default
  // ---------------------------------------------------------------
  function typeSubmissionCount(type) { return state.submissions.filter(s => !s.is_class_mirror && workType(assignmentById(s.assignment_id)) === type).length; }
  function renderTypeTabs() {
    if ($('#writtenSubmissionCount')) $('#writtenSubmissionCount').textContent = String(typeSubmissionCount('written_work'));
    if ($('#performanceSubmissionCount')) $('#performanceSubmissionCount').textContent = String(typeSubmissionCount('performance_task'));
    $$('#submissionTypeTabs [data-submission-type]').forEach(btn => btn.classList.toggle('active', btn.dataset.submissionType === submissionWorkType));
  }

  renderSubmissionSectionTabs = function() {
    const tabs = $('#submissionSectionTabs'); if (!tabs) return;
    const relevant = state.submissions.filter(s => workType(assignmentById(s.assignment_id)) === submissionWorkType);
    const counts = new Map(state.sections.map(s => [s.id,0]));
    relevant.forEach(s => { const a = assignmentById(s.assignment_id); if (a?.section_id) counts.set(a.section_id, (counts.get(a.section_id)||0)+1); });
    if (submissionSectionId !== 'all' && !sectionById(submissionSectionId)) submissionSectionId = 'all';
    tabs.innerHTML = `<button type="button" class="submission-section-tab ${submissionSectionId==='all'?'active':''}" data-submission-section="all"><b>All</b><span>${relevant.length}</span></button>` + state.sections.filter(s=>!s.archived_at).map(section => `<button type="button" class="submission-section-tab ${submissionSectionId===section.id?'active':''}" data-submission-section="${section.id}"><b>${esc(section.name)}</b><small>Grade ${esc(section.grade_level)}</small><span>${counts.get(section.id)||0}</span></button>`).join('');
  };

  function renderSubmissionActivityFilter() {
    const select = $('#submissionActivityFilter');
    if (!select) return;
    const label = $('#submissionActivityFilterLabel');
    const isPerformance = submissionWorkType === 'performance_task';
    if (label) label.textContent = isPerformance ? 'Performance task' : 'Activity';

    const eligible = state.assignments
      .filter(a => workType(a) === submissionWorkType)
      .filter(a => submissionSectionId === 'all' || a.section_id === submissionSectionId)
      .filter(a => !a.archived_at)
      .sort((a,b) => {
        const ad = new Date(a.due_at || a.publish_at || a.created_at || 0).getTime();
        const bd = new Date(b.due_at || b.publish_at || b.created_at || 0).getTime();
        if (bd !== ad) return bd - ad;
        return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity:'base' });
      });

    if (submissionAssignmentFilter !== 'all' && !eligible.some(a => a.id === submissionAssignmentFilter)) {
      submissionAssignmentFilter = 'all';
    }

    const allLabel = isPerformance ? 'All performance tasks' : 'All activities';
    select.innerHTML = `<option value="all">${allLabel}</option>` + eligible.map(a => {
      const section = sectionById(a.section_id);
      const suffix = submissionSectionId === 'all' && section ? ` · ${section.name}` : '';
      return `<option value="${esc(a.id)}">${esc(a.title || (isPerformance ? 'Performance Task' : 'Activity'))}${esc(suffix)}</option>`;
    }).join('');
    select.value = submissionAssignmentFilter;
  }

  function sortSubmissionRows(rows) {
    return [...rows].sort((a,b) => {
      const nameA = String(studentById(a.student_id)?.display_name || '');
      const nameB = String(studentById(b.student_id)?.display_name || '');
      if (submissionSort === 'name') return nameA.localeCompare(nameB, undefined, { sensitivity:'base' });
      if (submissionSort === 'name-desc') return nameB.localeCompare(nameA, undefined, { sensitivity:'base' });
      return new Date(b.submitted_at||0)-new Date(a.submitted_at||0);
    });
  }

  function isLateSubmission(s, a) {
    if (!s?.submitted_at || !a?.due_at) return false;
    const submittedAt = new Date(s.submitted_at).getTime();
    const dueAt = new Date(a.due_at).getTime();
    return Number.isFinite(submittedAt) && Number.isFinite(dueAt) && submittedAt > dueAt;
  }

  function submissionCard(s) {
    const a = assignmentById(s.assignment_id), student = studentById(s.student_id), section = sectionById(a?.section_id), total = totalPoints(a?.id), graded = s.status === 'graded';
    const shown = isPerformanceTask(a)
      ? (graded && s.teacher_score != null ? Number(s.teacher_score) : null)
      : Number(s.teacher_score ?? s.auto_score ?? 0);
    const genderClass = student?.gender === 'Male' ? 'submission-male' : student?.gender === 'Female' ? 'submission-female' : 'submission-other';
    const late = isLateSubmission(s, a);
    const mode = isPerformanceTask(a) ? (a?.collaboration_mode || 'individual') : 'individual';
    const teamPill = mode === 'class' ? '<span class="submission-team-pill">Class submission</span>' : mode === 'pair' ? '<span class="submission-team-pill">Pair submission</span>' : mode === 'group' ? '<span class="submission-team-pill">Group submission</span>' : '';
    const submitterPrefix = mode === 'class' ? 'Class representative: ' : mode === 'individual' ? '' : 'Leader: ';
    return `<article class="submission-card ${genderClass}"><div class="submission-status-icon">${graded?iconSvg('check','assignment-line-icon'):iconSvg('inbox','assignment-line-icon')}</div><div class="submission-card-body"><div class="submission-student-row"><button type="button" class="submission-student-name" data-track-student-from-submissions="${student?.id||''}" data-track-section="${section?.id||''}">${submitterPrefix}${esc(student?.display_name||'Student')}</button><span class="gender-pill">${esc(student?.gender||'Not specified')}</span><span class="submission-review-pill ${graded?'is-checked':'is-new'}">${graded?'Checked':'New'}</span>${teamPill}${late?'<span class="submission-late-pill">Late</span>':''}</div><h3 class="submission-assignment-title">${esc(a?.title || (isPerformanceTask(a)?'Performance Task':'Activity'))}</h3><p class="submission-class-label">${esc(sectionLabel(section))}</p><div class="submission-meta-grid"><span><small>Status</small><b>${graded?'Checked':'New'}</b></span><span><small>Score</small><b>${shown===null?'Pending':`${shown}/${total}`}</b></span><span><small>Timing</small><b>${late?'Late':'On time'}</b></span><span><small>Submitted</small><b>${esc(formatStudentDate(s.submitted_at)||'')}</b></span></div></div><button class="btn btn-orange submission-review-btn" data-review-submission="${s.id}">${graded?'Review again':'Review'}</button></article>`;
  }

  renderSubmissions = function() {
    const list = $('#submissionList'); if (!list) return;
    submissionSort = ['newest','name','name-desc'].includes(submissionSort) ? submissionSort : 'newest';
    submissionReviewFilter = ['all','new','checked'].includes(submissionReviewFilter) ? submissionReviewFilter : 'new';
    submissionGroupMode = submissionGroupMode === 'combined' ? 'combined' : 'section';
    renderTypeTabs(); renderSubmissionSectionTabs(); renderSubmissionActivityFilter();
    if ($('#submissionSort')) $('#submissionSort').value = submissionSort;
    if ($('#submissionGroupMode')) $('#submissionGroupMode').value = submissionGroupMode;

    const scopedRows = state.submissions.filter(s => {
      const assignment = assignmentById(s.assignment_id);
      return workType(assignment) === submissionWorkType
        && !s.is_class_mirror
        && (submissionSectionId === 'all' || assignment?.section_id === submissionSectionId)
        && (submissionAssignmentFilter === 'all' || s.assignment_id === submissionAssignmentFilter);
    });
    const statusCounts = {
      all: scopedRows.length,
      new: scopedRows.filter(s => s.status !== 'graded').length,
      checked: scopedRows.filter(s => s.status === 'graded').length
    };
    $$('#submissionReviewTabs [data-submission-review-filter]').forEach(btn => {
      const key = btn.dataset.submissionReviewFilter || 'all';
      btn.classList.toggle('active', key === submissionReviewFilter);
      const count = btn.querySelector('[data-review-count]');
      if (count) count.textContent = String(statusCounts[key] || 0);
    });

    let rows = scopedRows.filter(s => submissionReviewFilter === 'all' || (submissionReviewFilter === 'checked' ? s.status === 'graded' : s.status !== 'graded'));
    rows = sortSubmissionRows(rows);
    const uniqueStudents = new Set(rows.map(s=>s.student_id)).size;
    const selectedSection = submissionSectionId === 'all' ? null : sectionById(submissionSectionId);
    const selectedAssignment = submissionAssignmentFilter === 'all' ? null : assignmentById(submissionAssignmentFilter);
    const typeLabel = submissionWorkType === 'performance_task' ? 'Performance Tasks' : 'Activities';
    const activeFilterCount = Number(submissionSectionId !== 'all') + Number(submissionAssignmentFilter !== 'all') + Number(submissionReviewFilter !== 'all') + Number(submissionGroupMode !== 'section') + Number(submissionSort !== 'newest');
    const filterBadge = $('#submissionFilterBadge');
    if (filterBadge) { filterBadge.textContent = String(activeFilterCount); filterBadge.hidden = activeFilterCount === 0; }
    $('#submissionSectionSummary').innerHTML = `<span><b>${rows.length}</b> shown</span><span><b>${uniqueStudents}</b> learner${uniqueStudents===1?'':'s'}</span><span><b>${typeLabel}</b></span>${selectedSection?`<span>${esc(selectedSection.name)} · Grade ${esc(selectedSection.grade_level)}</span>`:''}${selectedAssignment?`<span><b>${esc(selectedAssignment.title || 'Selected activity')}</b></span>`:''}`;
    if (!rows.length) {
      const emptyLabel = submissionReviewFilter === 'new' ? 'new submissions' : submissionReviewFilter === 'checked' ? 'checked submissions' : `${typeLabel.toLowerCase()} submissions`;
      list.innerHTML = `<div class="assignment-empty v9-empty"><b>No ${emptyLabel}</b><p>Try another activity, review-status, or section filter.</p></div>`;
      return;
    }

    if (submissionGroupMode === 'combined') {
      list.innerHTML = `<section class="submission-combined-list">${rows.map(submissionCard).join('')}</section>`;
      return;
    }

    const sectionMap = new Map();
    rows.forEach(sub => {
      const assignment = assignmentById(sub.assignment_id); if (!assignment) return;
      if (!sectionMap.has(assignment.section_id)) sectionMap.set(assignment.section_id, []);
      sectionMap.get(assignment.section_id).push(sub);
    });
    const sectionIds = [...sectionMap.keys()].sort((a,b)=>sectionLabel(sectionById(a)).localeCompare(sectionLabel(sectionById(b)),undefined,{sensitivity:'base'}));
    list.innerHTML = sectionIds.map(sectionId => {
      const section = sectionById(sectionId);
      const sectionRows = sortSubmissionRows(sectionMap.get(sectionId));
      return `<section class="submission-section-group"><div class="submission-section-group-title"><span>${iconSvg('class','btn-icon')}</span><div><p>SECTION</p><h2>${esc(section?.name||'Class')}</h2><small>Grade ${esc(section?.grade_level||'')} · ${sectionRows.length} submission${sectionRows.length===1?'':'s'}</small></div></div><div class="submission-activity-list submission-section-flat-list">${sectionRows.map(submissionCard).join('')}</div></section>`;
    }).join('');
  };

  $('#submissionTypeTabs')?.addEventListener('click', event => {
    const btn = event.target.closest('[data-submission-type]'); if (!btn) return;
    submissionWorkType = btn.dataset.submissionType || 'written_work';
    renderSubmissions();
  });

  $('#submissionFilterBtn')?.addEventListener('click', () => {
    const panel = $('#submissionFilterPanel');
    setCompactFilterPanel('#submissionFilterBtn', '#submissionFilterPanel', Boolean(panel?.hidden));
  });
  $('#submissionFilterClose')?.addEventListener('click', () => setCompactFilterPanel('#submissionFilterBtn', '#submissionFilterPanel', false));
  $('#submissionFilterDone')?.addEventListener('click', () => setCompactFilterPanel('#submissionFilterBtn', '#submissionFilterPanel', false));
  $('#submissionActivityFilter')?.addEventListener('change', event => {
    submissionAssignmentFilter = event.currentTarget.value || 'all';
    renderSubmissions();
  });
  $('#submissionClearFilters')?.addEventListener('click', () => {
    submissionSectionId = 'all'; submissionAssignmentFilter = 'all'; submissionReviewFilter = 'new'; submissionGroupMode = 'section'; submissionSort = 'newest';
    renderSubmissions();
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    setCompactFilterPanel('#submissionFilterBtn', '#submissionFilterPanel', false);
    setCompactFilterPanel('#activityFilterBtn', '#activityFilterPanel', false);
    setCompactFilterPanel('#performanceTaskFilterBtn', '#performanceTaskFilterPanel', false);
  });

  // ---------------------------------------------------------------
  // PERFORMANCE TASK TEAMWORK
  // ---------------------------------------------------------------
  async function getPerformanceTeamInfo(assignmentId, studentId = null) {
    const args = { p_assignment_id: assignmentId, p_student_id: studentId || null };
    const result = await db.rpc('mathside_get_performance_team', args);
    if (result.error) throw result.error;
    return result.data || { mode:'individual', group:null, members:[], is_leader:false };
  }

  async function getPerformanceParticipationRatings(assignmentId, groupId) {
    if (!groupId) return [];
    const result = await db.rpc('mathside_get_participation_ratings', { p_assignment_id:assignmentId, p_group_id:groupId });
    if (result.error) throw result.error;
    return Array.isArray(result.data) ? result.data : [];
  }

  function collaborationLabel(a) {
    const mode = a?.collaboration_mode || 'individual';
    return mode === 'class' ? 'Whole-class task' : mode === 'pair' ? 'Pair task' : mode === 'group' ? 'Group task' : 'Individual task';
  }

  function renderTeamMembers(team) {
    const members = Array.isArray(team?.members) ? team.members : [];
    return members.map(member => `<li><span>${esc(member.display_name || 'Student')}</span>${member.id === team?.leader_id ? '<b>Leader</b>' : ''}</li>`).join('');
  }

  async function renderStudentTeamBuilder(a) {
    const box = $('#performanceStudentTeamBuilder');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<p class="muted">Loading classmates…</p>';
    const result = await db.rpc('mathside_get_available_groupmates', { p_assignment_id:a.id });
    if (result.error) throw result.error;
    const data = result.data || {};
    const peers = Array.isArray(data.students) ? data.students : [];
    const maxMembers = Number(data.max_members || (a.collaboration_mode === 'pair' ? 2 : 4));
    const need = a.collaboration_mode === 'pair' ? 1 : Math.max(1, maxMembers - 1);
    box.innerHTML = `<div class="performance-team-builder-head"><p class="eyebrow">CREATE YOUR ${a.collaboration_mode === 'pair' ? 'PAIR' : 'GROUP'}</p><h3>Choose your teammate${a.collaboration_mode === 'pair' ? '' : 's'}</h3><p>Select ${a.collaboration_mode === 'pair' ? 'one classmate' : `up to ${need} classmates`} to form your team. Your teacher will choose the team leader after the team is created.</p></div>${peers.length ? `<div class="performance-peer-list">${peers.map(peer => `<label><input type="checkbox" name="performance_peer" value="${esc(peer.id)}"><span>${esc(peer.display_name)}</span></label>`).join('')}</div><button type="button" class="btn btn-orange" data-create-performance-team data-max-members="${maxMembers}">Create team</button>` : '<p class="muted">No classmates are currently available to form a team.</p>'}`;
  }

  async function renderLeaderParticipationRatings(a, team) {
    const box = $('#performanceParticipationRatings');
    if (!box) return;
    const members = (team?.members || []).filter(member => member.id !== team.leader_id);
    if (!members.length) { box.hidden = true; box.innerHTML = ''; return; }
    let existing = [];
    try { existing = await getPerformanceParticipationRatings(a.id, team.group?.id); } catch (_) {}
    const byMember = new Map(existing.map(row => [row.member_id, Number(row.rating || 0)]));
    box.hidden = false;
    box.innerHTML = `<div class="performance-rating-head"><p class="eyebrow">${a.collaboration_mode === 'class' ? 'CLASS PARTICIPATION' : 'MEMBER PARTICIPATION'}</p><h3>Rate each member from 1 to 5</h3><p>Only you and your teacher can see these ratings. Ratings affect the final score once the teacher grades the project. Deduction: 5 = 0 pts, 4 = 2 pts, 3 = 3 pts, 2 = 4 pts, 1 = 5 pts.</p>${a.collaboration_mode === 'class' ? '<input class="performance-class-member-search" type="search" placeholder="Search classmates" aria-label="Search classmates for participation ratings">' : ''}</div><div class="performance-rating-list ${a.collaboration_mode === 'class' ? 'class-participation-list' : ''}">${members.map(member => `<label data-rating-name="${esc(String(member.display_name || '').toLowerCase())}"><span>${esc(member.display_name)}</span><select data-participation-member="${esc(member.id)}" required><option value="">Choose</option>${[1,2,3,4,5].map(n=>`<option value="${n}" ${byMember.get(member.id)===n?'selected':''}>${n}</option>`).join('')}</select></label>`).join('')}</div>${a.collaboration_mode === 'class' ? '<div class="class-rating-actions"><button type="button" class="btn btn-orange" data-save-class-participation>Save participation ratings</button><small>Ratings may be saved separately from the class project. All classmates must receive a rating.</small></div>' : ''}`;
  }

  async function saveLeaderParticipationRatings(a, team) {
    if ((a.collaboration_mode || 'individual') === 'individual' || !team?.is_leader || !team?.group?.id) return;
    const selects = $$('[data-participation-member]', $('#performanceParticipationRatings'));
    const ratings = selects.map(select => ({ member_id:select.dataset.participationMember, rating:Number(select.value || 0) }));
    if (ratings.some(item => item.rating < 1 || item.rating > 5)) throw new Error('Rate every team member from 1 to 5 before saving.');
    const result = await db.rpc('mathside_save_participation_ratings', { p_assignment_id:a.id, p_group_id:team.group.id, p_ratings:ratings });
    if (result.error) throw result.error;
  }

  document.addEventListener('input', event => {
    const search = event.target.closest('.performance-class-member-search');
    if (!search) return;
    const query = String(search.value || '').toLocaleLowerCase().trim();
    $$('.class-participation-list [data-rating-name]').forEach(label => {
      label.hidden = !String(label.dataset.ratingName || '').includes(query);
    });
  });

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-save-class-participation]');
    if (!btn) return;
    const a = assignmentById(activePerformanceTaskId);
    if (!a || a.collaboration_mode !== 'class') return;
    if (a.status === 'archived') return toast('Archived class ratings cannot be edited.', 'orange');
    if (!window.MathsideActionButton?.start(btn, 'Saving ratings…')) return;
    try {
      const team = await getPerformanceTeamInfo(a.id);
      if (!team?.is_leader) throw new Error('Only the teacher-selected class representative can rate classmates.');
      await saveLeaderParticipationRatings(a, team);
      await window.MathsideActionButton?.done(btn, 'Saved');
      toast('Class participation ratings saved privately for your teacher.', 'success');
    } catch (error) {
      window.MathsideActionButton?.reset(btn);
      toast(friendlyErrorMessage(error, 'Could not save participation ratings.'), 'orange');
    }
  });

  document.addEventListener('change', event => {
    const input = event.target.closest('input[name="performance_peer"]');
    if (!input) return;
    const a = assignmentById(activePerformanceTaskId);
    const checked = $$('input[name="performance_peer"]:checked', $('#performanceStudentTeamBuilder'));
    const max = Number($('#performanceStudentTeamBuilder [data-create-performance-team]')?.dataset.maxMembers || 2) - 1;
    if (a?.collaboration_mode === 'pair' && checked.length > 1) checked.slice(0,-1).forEach(x => { x.checked = false; });
    else if (checked.length > max) { input.checked = false; toast(`Choose up to ${max} teammate${max===1?'':'s'}.`, 'orange'); }
  });

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-create-performance-team]');
    if (!btn) return;
    const a = assignmentById(activePerformanceTaskId); if (!a) return;
    const memberIds = $$('input[name="performance_peer"]:checked', $('#performanceStudentTeamBuilder')).map(input => input.value);
    if (a.collaboration_mode === 'pair' && memberIds.length !== 1) return toast('Choose one classmate for your pair.', 'orange');
    if (a.collaboration_mode === 'group' && memberIds.length < 1) return toast('Choose at least one classmate for your group.', 'orange');
    try {
      await withLoading('Creating your team…','Saving your selected teammates.', async () => {
        const result = await db.rpc('mathside_create_student_performance_team', { p_assignment_id:a.id, p_member_ids:memberIds });
        if (result.error) throw result.error;
      });
      toast('Your team is ready. Your teacher will choose the leader.', 'success');
      await openStudentPerformanceTask(a.id);
    } catch (error) { toast(friendlyErrorMessage(error, 'Could not create the team.'), 'orange'); }
  });

  function performanceClassResourceLinks(submission) {
    if (!submission) return '';
    const links = [
      ['Video documentation', submission.class_video_url],
      ['Open digital class project', submission.class_project_url]
    ].filter(([, url]) => typeof url === 'string' && /^https:\/\/[^\s/]+/i.test(url));
    return links.map(([label, url]) => `<a class="btn btn-light" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`).join('');
  }

  async function loadClassScoresForReview(assignmentId, canAdjust) {
    const box = $('#reviewClassScoring');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<p class="muted">Loading class score record…</p>';
    const result = await db.rpc('mathside_get_class_scores', {p_assignment_id: assignmentId});
    if (result.error) {
      box.innerHTML = `<p class="muted">Class scores unavailable: ${esc(friendlyErrorMessage(result.error, 'Run the Class Mode SQL migration.'))}</p>`;
      return;
    }
    const payload = result.data || {};
    const base = payload.base_score;
    const maxPoints = Number(payload.max_points || 0);
    const members = Array.isArray(payload.students) ? payload.students : [];
    box.innerHTML = `<h3>Class Score Record</h3><p class="muted">${base == null ? 'Save the common class grade above first. Then reopen the review to adjust individual scores.' : `Common grade: ${Number(base)}/${maxPoints}. Participation ratings adjust member scores automatically; teacher adjustments are optional.`}</p><div class="class-grade-controls">${members.map(member => {
      const override = member.override != null;
      const score = member.score == null ? '' : Number(member.score);
      const rating = Number(member.rating || 0);
      const deduction = {5:0,4:2,3:3,2:4,1:5}[rating];
      const automatic = base == null || deduction == null ? '' : Math.max(0, Number(base) - deduction);
      const explanation = member.representative ? 'Class representative' : override ? 'Teacher adjustment' : rating ? `Participation ${rating}/5` : 'Not rated yet';
      return `<label class="class-grade-person"><span>${esc(member.display_name || 'Learner')}${member.representative ? ' <small>(Representative)</small>' : ''}<small>${esc(explanation)}</small></span><input aria-label="Grade for ${esc(member.display_name || 'Learner')}" data-class-student-id="${esc(member.id)}" data-automatic-score="${automatic}" type="number" min="0" max="${maxPoints}" step="0.01" value="${score}" ${member.representative || !canAdjust ? 'disabled' : ''}></label>`;
    }).join('')}</div>${canAdjust && base != null ? '<div class="class-grade-actions"><button class="btn btn-orange" type="button" data-save-class-scores>Save individual adjustments</button><small>Enter the participation-based score to remove an adjustment; leave a score blank if the member is not rated.</small></div>' : ''}`;
    box.dataset.classAssignmentId = assignmentId;
    box.dataset.classBaseScore = base == null ? '' : String(base);
    box.dataset.classMaxPoints = String(maxPoints);
  }

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-save-class-scores]');
    if (!btn) return;
    const box = $('#reviewClassScoring');
    if (!box || !box.dataset.classAssignmentId) return;
    const base = Number(box.dataset.classBaseScore);
    const max = Number(box.dataset.classMaxPoints);
    const scores = [];
    for (const input of $$('[data-class-student-id]', box)) {
      const value = input.value.trim();
      if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max))
        return toast(`Scores must be from 0 to ${max}, or blank for unrated learners.`, 'orange');
      const numeric = value === '' ? null : Number(value);
      const automatic = input.dataset.automaticScore === '' ? null : Number(input.dataset.automaticScore);
      scores.push({student_id: input.dataset.classStudentId, score: numeric === automatic ? null : numeric});
    }
    if (!window.MathsideActionButton?.start(btn,'Saving…')) return;
    try {
      const result = await db.rpc('mathside_set_class_scores', { p_assignment_id: box.dataset.classAssignmentId, p_scores: scores });
      if (result.error) throw result.error;
      await refreshTeacher();
      await loadClassScoresForReview(box.dataset.classAssignmentId, true);
      await window.MathsideActionButton?.done(btn,'Saved');
      toast('Individual class scores updated in the students’ records.', 'success');
    } catch (error) {
      window.MathsideActionButton?.reset(btn);
      toast(friendlyErrorMessage(error, 'Could not save the class scores.'), 'orange');
    }
  });

  // ---------------------------------------------------------------
  // REVIEW PERFORMANCE TASK
  // ---------------------------------------------------------------
  openSubmissionReview = async function(submissionId) {
    const submission = state.submissions.find(s=>s.id===submissionId), a = assignmentById(submission?.assignment_id);
    if (!submission || !isPerformanceTask(a)) {
      if ($('#reviewPerformanceTeamInfo')) { $('#reviewPerformanceTeamInfo').hidden = true; $('#reviewPerformanceTeamInfo').innerHTML = ''; }
      if ($('#reviewClassScoring')) { $('#reviewClassScoring').hidden = true; $('#reviewClassScoring').innerHTML = ''; }
      return originalOpenSubmissionReview(submissionId);
    }
    activeSubmissionId = submissionId;
    const student = studentById(submission.student_id), total = totalPoints(a.id);
    await withLoading('Opening performance task…','Loading the student output pictures.', async () => {
      $('#reviewSubmissionTitle').textContent = a.title;
      if ($('#reviewSubmissionStudentName')) $('#reviewSubmissionStudentName').textContent = student?.display_name || 'Student';
      const lateSubmission = isLateSubmission(submission, a);
      $('#reviewSubmissionMeta').textContent = `${sectionLabel(sectionById(a.section_id))} · Performance Task · Submitted ${formatStudentDate(submission.submitted_at)||''}${lateSubmission ? ' · LATE SUBMISSION' : ''}`;
      $('#reviewSubmissionAnswers').innerHTML = `<article class="answer-question review-answer"><p class="eyebrow">TASK INSTRUCTIONS</p><p>${esc(a.instructions||'No additional instructions.')}</p></article>`;
      const teamBox = $('#reviewPerformanceTeamInfo');
      if (teamBox) { teamBox.hidden = true; teamBox.innerHTML = ''; }
      const classGrades = $('#reviewClassScoring');
      if (classGrades) { classGrades.hidden = true; classGrades.innerHTML = ''; }
      if ((a.collaboration_mode || 'individual') !== 'individual' && teamBox) {
        try {
          const team = await getPerformanceTeamInfo(a.id, submission.student_id);
          const ratings = team?.group?.id ? await getPerformanceParticipationRatings(a.id, team.group.id) : [];
          const ratingMap = new Map(ratings.map(row => [row.member_id, Number(row.rating || 0)]));
          teamBox.hidden = false;
          teamBox.innerHTML = a.collaboration_mode === 'class'
            ? `<p class="eyebrow">CLASS SUBMISSION</p><h3>${esc(sectionById(a.section_id)?.name || 'Whole class')}</h3><p>Representative: <b>${esc(student?.display_name || 'Student')}</b> · One submission for the class</p><p class="muted">Private 1–5 ratings are used for classmates' participation deductions. Only the teacher and the representative can view these.</p><div class="review-team-member-list class-review-member-list">${(team?.members || []).map(member => `<div><span>${esc(member.display_name || 'Student')}${member.id === team.leader_id ? ' · Representative' : ''}</span><b>${member.id === team.leader_id ? '—' : (ratingMap.get(member.id) ? `${ratingMap.get(member.id)}/5` : 'Not rated')}</b></div>`).join('')}</div>`
            : `<p class="eyebrow">PRIVATE TEAM INFORMATION</p><h3>${esc(team?.group?.name || collaborationLabel(a))}</h3><p class="muted">Participation ratings are visible only to the teacher and team leader.</p><div class="review-team-member-list">${(team.members || []).map(member => `<div><span>${esc(member.display_name || 'Student')}${member.id===team.leader_id?' · Leader':''}</span><b>${member.id===team.leader_id?'—':(ratingMap.get(member.id) ? `${ratingMap.get(member.id)}/5` : 'Not rated')}</b></div>`).join('')}</div>`;
        } catch (error) { console.warn('Could not load private team details', error); }
      }
      $('#manualReviewSummary').hidden = true;
      $('#teacherScoreInput').readOnly = false;
      $('#teacherScoreInput').max = String(total);
      $('#teacherScoreInput').value = submission.teacher_score != null ? String(submission.teacher_score) : '';
      $('#teacherScoreInput').placeholder = `Enter a score from 0 to ${total}`;
      $('#teacherFeedbackInput').value = submission.feedback || '';
      if ($('#teacherFeedbackPreset')) $('#teacherFeedbackPreset').value = '';
      const links = await signedLinks('mathside-submission-proofs', submissionOutputPaths(submission), 1800);
      const wrap = $('#reviewProofWrap');
      if ($('#reviewProofLabel')) $('#reviewProofLabel').textContent = 'PERFORMANCE TASK OUTPUT';
      $('#reviewProofLinks').innerHTML = links.map((x,i)=>`<a class="btn btn-light" href="${esc(x.url)}" target="_blank" rel="noopener">Open output picture ${i+1}</a>`).join('') + performanceClassResourceLinks(submission);
      wrap.hidden = !links.length && !(a.collaboration_mode === 'class' && (submission.class_video_url || submission.class_project_url));
      if (a.collaboration_mode === 'class') await loadClassScoresForReview(a.id, submission.status === 'graded');
      const allowAgainBtn = $('#allowResubmissionBtn');
      if (allowAgainBtn) {
        allowAgainBtn.hidden = !a.allow_resubmission;
        allowAgainBtn.disabled = Boolean(submission.resubmit_allowed);
        allowAgainBtn.textContent = submission.resubmit_allowed ? 'Resubmission already allowed' : 'Allow student to submit again';
      }
      openDialog('reviewSubmissionModal');
    });
  };

  // ---------------------------------------------------------------
  // STUDENT PERFORMANCE TASKS
  // ---------------------------------------------------------------
  function performanceStatus(a) {
    const sub = submissionFor(a.id);
    if (!sub && studentHasRecordedSubmission(a.id)) return { label:'Submitted · Record saved', cls:'submitted' };
    if (sub) {
      const late = isLateSubmission(sub, a);
      if (late) return { label: sub.status === 'graded' ? 'Graded · Late' : 'Submitted Late', cls:'late' };
      return { label: sub.status === 'graded' ? 'Graded' : 'Submitted', cls: sub.status === 'graded' ? 'graded' : 'submitted' };
    }
    if (a.status === 'archived') return { label:'Archived', cls:'archived' };
    if (a.due_at && new Date(a.due_at).getTime() < Date.now()) return { label:'Missed', cls:'missed' };
    return { label:'To do', cls:'not-started' };
  }

  function renderStudentPerformanceTasks() {
    const list = $('#studentPerformanceList'); if (!list) return;
    const tasks = performanceTasks().filter(a => a.status === 'published' || a.status === 'archived').sort((a,b)=>(a.due_at?new Date(a.due_at).getTime():Infinity)-(b.due_at?new Date(b.due_at).getTime():Infinity));
    if (!tasks.length) { list.innerHTML = '<div class="v8-empty"><b>No performance tasks yet.</b>Your teacher’s performance tasks will appear here once posted.</div>'; return; }
    list.innerHTML = tasks.map(a => {
      const sub = submissionFor(a.id), history=studentProgressFor(a.id), due = a.due_at ? `Due ${formatDeadlineDate(a.due_at)}` : 'No due date';
      const archived=a.status==='archived';
      const st=archived && history?.graded ? {label:'Graded · Archived',cls:'archived'}
        : archived && history?.submitted ? {label:'Submitted · Archived',cls:'archived'}
        : performanceStatus(a);
      const canNewAttempt = !sub || Boolean(sub.resubmit_allowed);
      const primary = archived ? '<span class="v8-history-tag">Saved record</span>'
        : sub ? `<button type="button" class="v8-view-button" data-preview-response="${esc(sub.id)}">View</button>`
        : studentHasRecordedSubmission(a.id) ? '<span class="v8-history-tag">Record saved</span>'
        : `<button type="button" class="v8-view-button" data-submit-performance="${esc(a.id)}">Open</button>`;
      const retry = sub && canNewAttempt && a.status !== 'archived' ? `<button type="button" class="v8-resubmit" data-submit-performance="${esc(a.id)}">Submit new attempt</button>` : '';
      return `<article class="v8-activity-row performance-student-row ${a.status==='archived'?'is-archived':''}"><span class="v8-task-icon orange">▣</span><div class="v8-task-title"><b>${esc(a.title)}</b><small>${esc(sectionLabel(sectionById(a.section_id)))} · ${Number(a.max_points||0)} pts</small></div><span class="v8-due"><span>${esc(due)}</span></span><span class="v8-status ${st.cls}">${st.label}</span>${primary}${retry}</article>`;
    }).join('');
  }
  window.renderStudentPerformanceTasks = renderStudentPerformanceTasks;

  showStudentPanel = function(panel='overview') {
    const allowed = new Set(['overview','activities','performance','grades','todo','calendar','feedback','account']);
    activeStudentPanel = allowed.has(panel) ? panel : 'overview';
    $$('[data-student-panel-view]').forEach(view => { const active = view.dataset.studentPanelView === activeStudentPanel; view.hidden = !active; view.classList.toggle('active', active); });
    $$('[data-student-panel]').forEach(btn => btn.classList.toggle('active', btn.dataset.studentPanel === activeStudentPanel));
    if (activeStudentPanel === 'activities') renderStudentAssignments();
    if (activeStudentPanel === 'performance') renderStudentPerformanceTasks();
    if (activeStudentPanel === 'grades') renderStudentGrades();
    if (activeStudentPanel === 'account') renderStudentAccount();
    if (activeStudentPanel === 'overview' && state.profile?.role === 'student') window.MathsideCompetencies?.renderStudent?.();
    window.MathsideV10?.renderStudentPanel?.(activeStudentPanel);
    window.MathsideStudent?.syncPanel();
  };

  async function openStudentPerformanceTask(id) {
    const a = assignmentById(id); if (!a || !isPerformanceTask(a)) return;
    activePerformanceTaskId = id;
    $('#performanceStudentTitle').textContent = a.title;
    $('#performanceStudentInstructions').textContent = a.instructions || '';
    $('#performanceStudentMeta').innerHTML = `<span class="meta-chip">${esc(sectionLabel(sectionById(a.section_id)))}</span><span class="meta-chip">${Number(a.max_points||0)} pts</span><span class="meta-chip">${esc(collaborationLabel(a))}</span>${a.due_at?`<span class="meta-chip">Due ${esc(formatDeadlineDate(a.due_at))}</span>`:''}`;
    const pictures = await signedLinks('mathside-assignment-images', assignmentTaskImages(a), 1800);
    $('#performanceStudentPictures').innerHTML = pictures.map((x,i)=>`<a href="${esc(x.url)}" target="_blank" rel="noopener"><img src="${esc(x.url)}" alt="Performance task picture ${i+1}"></a>`).join('');
    if (a.rubric_path) {
      const url = await signedUrl('mathside-assignment-images', a.rubric_path, 1800);
      $('#performanceStudentRubric').innerHTML = url ? `<p class="eyebrow">RUBRIC</p><a class="btn btn-light" href="${esc(url)}" target="_blank" rel="noopener">Open rubric</a>` : '';
    } else $('#performanceStudentRubric').innerHTML = '<p class="muted">No rubric file was attached.</p>';

    const teamPanel = $('#performanceTeamPanel');
    const teamBuilder = $('#performanceStudentTeamBuilder');
    const form = $('#performanceSubmitForm');
    const upload = form?.querySelector('.performance-output-upload');
    const ratingsBox = $('#performanceParticipationRatings');
    const classLinks = $('#performanceClassLinks');
    if (classLinks) classLinks.hidden = a.collaboration_mode !== 'class';
    if ($('#performanceClassVideoUrl')) $('#performanceClassVideoUrl').value = submissionFor(a.id)?.class_video_url || '';
    if ($('#performanceClassProjectUrl')) $('#performanceClassProjectUrl').value = submissionFor(a.id)?.class_project_url || '';
    if (teamPanel) { teamPanel.hidden = true; teamPanel.innerHTML = ''; }
    if (teamBuilder) { teamBuilder.hidden = true; teamBuilder.innerHTML = ''; }
    if (ratingsBox) { ratingsBox.hidden = true; ratingsBox.innerHTML = ''; }
    if (form) form.hidden = false;
    if (upload) upload.hidden = false;

    let team = null;
    const mode = a.collaboration_mode || 'individual';
    if (mode !== 'individual') {
      try { team = await getPerformanceTeamInfo(a.id); }
      catch (error) { return toast(friendlyErrorMessage(error, 'Could not load your team.'), 'orange'); }
      if (!team?.group) {
        if ((a.grouping_creator || 'teacher') === 'students') {
          if (form) form.hidden = true;
          await renderStudentTeamBuilder(a);
        } else {
          if (form) form.hidden = true;
          if (teamPanel) {
            teamPanel.hidden = false;
            teamPanel.innerHTML = '<p class="eyebrow">TEAM SETUP</p><h3>Your team is not ready yet.</h3><p class="muted">Your teacher is still preparing the pairings or groups. You can still view the task instructions and resources.</p>';
          }
        }
      } else {
        if (teamPanel) {
          teamPanel.hidden = false;
          const leaderMessage = !team.leader_id
            ? '<p class="team-member-note waiting-leader-note">Your teacher has not chosen the class representative or team leader yet. You can still view this task and its resources.</p>'
            : team.is_leader
              ? `<p class="team-leader-note">${mode === 'class' ? 'You are the class representative. Submit one project for the entire class.' : 'You are the leader. Only you can submit the team output.'}</p>`
              : `<p class="team-member-note">${mode === 'class' ? 'Your class representative will submit for everyone. Your grade and task status will update automatically.' : 'Your team leader will submit the final output. You can still view this task and its resources.'}</p>`;
          teamPanel.innerHTML = `<p class="eyebrow">${mode === 'class' ? 'YOUR CLASS PROJECT' : 'YOUR TEAM'}</p><h3>${esc(team.group.name || collaborationLabel(a))}</h3><ul class="performance-team-member-list">${renderTeamMembers(team)}</ul>${leaderMessage}`;
        }
        if (!team.is_leader && form) form.hidden = true;
        if (team.is_leader) await renderLeaderParticipationRatings(a, team);
      }
    }

    const existing = submissionFor(a.id), oldPaths = submissionOutputPaths(existing);
    $('#performanceOutputImages').value = '';
    const submitBtn = $('#performanceSubmitForm button[type="submit"]');
    const allowed = a.status !== 'archived' && (!existing || existing.resubmit_allowed) && (mode === 'individual' || Boolean(team?.is_leader));
    if (submitBtn) {
      submitBtn.disabled = !allowed;
      submitBtn.textContent = a.status === 'archived' ? 'Archived' : existing && !existing.resubmit_allowed ? 'Waiting for teacher approval' : 'Submit performance task';
    }
    $('#performanceOutputHint').textContent = a.status === 'archived' ? 'This performance task is archived. You can view it, but you cannot upload a new output.' : existing && !existing.resubmit_allowed ? `You already submitted ${oldPaths.length} picture${oldPaths.length===1?'':'s'}. Ask your teacher to allow another attempt.` : existing ? `You already submitted ${oldPaths.length} picture${oldPaths.length===1?'':'s'}. Upload a new set for your approved attempt.` : 'Upload one or more clear pictures of your output.';
    openDialog('performanceSubmitModal');
  }


  document.addEventListener('click', event => {
    const btn = event.target.closest('[data-submit-performance]');
    if (btn) { event.preventDefault(); openStudentPerformanceTask(btn.dataset.submitPerformance); }
  }, true);

  document.addEventListener('click', event => {
    const btn = event.target.closest('[data-answer-assignment]'); if (!btn) return;
    const a = assignmentById(btn.dataset.answerAssignment); if (!isPerformanceTask(a)) return;
    event.preventDefault(); event.stopImmediatePropagation(); openStudentPerformanceTask(a.id);
  }, true);

  $('#performanceSubmitForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!requireSupabase() || state.profile?.role !== 'student') return;
    const a = assignmentById(activePerformanceTaskId); if (!a) return;
    const existing = submissionFor(a.id);
    if (a.status === 'archived') return toast('This performance task has been archived.', 'orange');
    if (existing && !existing.resubmit_allowed) return toast('Your teacher must allow another attempt before you can resubmit.', 'orange');
    const files = [...($('#performanceOutputImages')?.files || [])];
    const classVideoUrl = a.collaboration_mode === 'class' ? String($('#performanceClassVideoUrl')?.value || '').trim() : '';
    const classProjectUrl = a.collaboration_mode === 'class' ? String($('#performanceClassProjectUrl')?.value || '').trim() : '';
    if ([classVideoUrl,classProjectUrl].some(link => link && (!/^https:\/\/[^\s/]+/i.test(link) || link.length > 2048))) return toast('Video and project links must be valid HTTPS URLs.', 'orange');
    if (!files.length) return toast('Upload at least one picture of your output.', 'orange');
    if (files.length > 10) return toast('Choose up to 10 output pictures.', 'orange');
    if (files.some(f => !String(f.type||'').startsWith('image/') && !isHeicImage(f))) return toast('Performance task outputs must be image files.', 'orange');

    const submitBtn = event.currentTarget.querySelector('button[type="submit"]');
    if (!window.MathsideActionButton?.start(submitBtn, 'Submitting…')) return;
    const oldPaths = submissionOutputPaths(existing), newPaths = [];
    let submittedToServer = false;
    let classLinksWarning = false;
    try {
      let team = null;
      if ((a.collaboration_mode || 'individual') !== 'individual') {
        team = await getPerformanceTeamInfo(a.id);
        if (!team?.is_leader) throw new Error(a.collaboration_mode === 'class' ? 'Only the class representative selected by your teacher may submit this project.' : 'Only your team leader can submit this performance task.');
        await saveLeaderParticipationRatings(a, team);
      }

      await withLoading('Submitting performance task…','Uploading your output pictures and saving your submission.', async () => {
        for (let i=0; i<files.length; i+=1) {
          const f = await compressImageForUpload(files[i], { maxDimension: 1600, targetBytes: 450 * 1024, hardLimitBytes: 500 * 1024, quality: 0.80, minQuality: 0.50, minLongEdge: 900 });
          const path = await window.MathsideR2.uploadProof(db, {
            assignmentId: a.id,
            userId: state.user.id,
            file: f
          });
          newPaths.push(path);
        }
        const { error } = await db.rpc('mathside_submit_work', { p_assignment_id:a.id, p_answers:[], p_proof_paths:newPaths });
        if (error) throw error;
        submittedToServer = true;
        if (a.collaboration_mode === 'class') {
          const linksSaved = await db.rpc('mathside_save_class_submission_links', { p_assignment_id:a.id, p_video_url:classVideoUrl || null, p_project_url:classProjectUrl || null });
          if (linksSaved.error) {
            classLinksWarning = true;
            console.warn('Class project submitted, optional links could not be saved:', linksSaved.error);
          }
        }
        // Preserve earlier submission images and their Cloudflare objects.
        await refreshStudent();
        showStudentPanel('performance');
      });
      await window.MathsideActionButton.done(submitBtn, 'Done');
      closeDialog('performanceSubmitModal');
      toast(classLinksWarning ? 'Class project submitted. Optional links were not saved; contact your teacher or ask to resubmit after the database upgrade.' : 'Performance task submitted.', classLinksWarning ? 'orange' : 'success');
    } catch (error) {
      window.MathsideActionButton?.reset(submitBtn);
      console.error(error); // Preserve uploaded R2 files even if the submission RPC fails.
      if (submittedToServer) { try { await refreshStudent(); } catch (_) {} }
      toast(submittedToServer ? 'Your project was submitted, but refreshing the page failed. Reopen Mathside to check your submission.' : friendlyErrorMessage(error, 'Could not submit the performance task.'), 'orange');
    }
  });


  openStudentResponsePreview = async function(submissionId) {
    const submission = state.submissions.find(s=>s.id===submissionId), a = assignmentById(submission?.assignment_id);
    if (!submission || !isPerformanceTask(a)) return originalOpenStudentResponsePreview(submissionId);
    const total = totalPoints(a.id), graded = submission.status === 'graded' && submission.teacher_score != null, score = graded ? Number(submission.teacher_score) : null;
    $('#studentResponseTitle').textContent = a.title;
    const responseWasLate = isLateSubmission(submission, a);
    $('#studentResponseMeta').textContent = `${sectionLabel(sectionById(a.section_id))} · Performance Task · Submitted ${formatStudentDate(submission.submitted_at)||''}${responseWasLate ? ' · LATE SUBMISSION' : ''} · Attempt ${Number(submission.attempt_count||1)}`;
    $('#studentResponseScore').innerHTML = `<div><span>${graded?'Teacher score':'Status'}</span><b>${graded?`${score}<small>/ ${total}</small>`:'Awaiting review'}</b></div><span class="student-status ${graded?'status-graded':'status-submitted'}">${graded?'Graded':'Submitted'}</span>`;
    $('#studentResponseAnswers').innerHTML = `<article class="answer-question student-preview-answer"><p class="eyebrow">PERFORMANCE TASK</p><p>${esc(a.instructions||'')}</p></article>`;
    const links = await signedLinks('mathside-submission-proofs', submissionOutputPaths(submission), 1800);
    $('#studentResponseProofLabel').textContent = 'MY OUTPUT PICTURES';
    $('#studentResponseProofLinks').innerHTML = links.map((x,i)=>`<a class="btn btn-light" href="${esc(x.url)}" target="_blank" rel="noopener">Open output picture ${i+1}</a>`).join('') + performanceClassResourceLinks(submission);
    $('#studentResponseProofWrap').hidden = !links.length && !(a.collaboration_mode === 'class' && (submission.class_video_url || submission.class_project_url));
    if (a.collaboration_mode === 'class') $('#studentResponseProofLabel').textContent = 'CLASS PROJECT & DOCUMENTATION';
    const feedback = $('#studentResponseFeedback');
    if (submission.feedback) { feedback.innerHTML = `<p class="eyebrow">TEACHER FEEDBACK</p><p>${esc(submission.feedback)}</p>`; feedback.hidden = false; }
    else feedback.hidden = true;
    openDialog('studentResponseModal');
  };

  // Initial correction after the script loads.
  submissionSort = 'newest';
  if ($('#submissionSort')) $('#submissionSort').value = 'newest';
  setTimeout(() => {
    if (state.profile?.role === 'teacher') renderTeacher();
    if (state.profile?.role === 'student') renderStudentPerformanceTasks();
  }, 0);

  window.MathsidePerformanceTasks = { renderPerformanceTasks, renderStudentPerformanceTasks, openPerformanceTaskModal, renderArchiveCenter };
})();
