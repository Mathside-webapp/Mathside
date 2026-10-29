/* Mathside Competency Tracker: teacher-private library and accessible dashboard. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let names=[],links=[],ready=false,lastLoadError=null;
  const client = () => typeof db !== 'undefined' ? db : null;
  const me = () => typeof state !== 'undefined' ? state.user?.id : null;
  const teacher = () => typeof state !== 'undefined' && state.profile?.role === 'teacher';
  const message = s => { if(typeof toast === 'function') toast(s,'orange'); else alert(s); };
  async function query(table,cols='*') {const {data,error}=await client().from(table).select(cols);if(error)throw error;return data||[];}
  async function load(){if(!client()||!me())return false;try{names=await query('mathside_ct_competencies');links=await query('mathside_ct_links');ready=true;lastLoadError=null;populate();return true;}catch(e){console.warn('Competency Tracker setup needed',e);ready=false;lastLoadError=e;return false;}}
  function populate(){for(const id of ['ctAssignmentCompetency','ctPerformanceCompetency','ctBulkSelect']){const el=$(id);if(!el)continue;const value=el.value;el.innerHTML=`<option value="">${id==='ctBulkSelect'?'Select competency for checked activities':'No competency selected'}</option>`+names.map(n=>`<option value="${esc(n.id)}">${esc(n.name)}</option>`).join('');el.value=value;}}
  async function add(name){name=name.trim().replace(/\s+/g,' ');if(!name||name.length>180)return null;let found=names.find(n=>n.name.toLowerCase()===name.toLowerCase());if(found)return found.id;const {data,error}=await client().from('mathside_ct_competencies').insert({name,teacher_id:me()}).select().single();if(error)throw error;names.push(data);populate();renderLibrary();return data.id;}
  function explainError(e) {
    const code=String(e?.code||'');
    const raw=String(e?.message||'Unknown database error').trim();
    const details=String(e?.details||'').trim();
    const hint=String(e?.hint||'').trim();
    let action='';
    if(code==='PGRST202'&&/mathside_ct_delete_competency/i.test(raw))
      action='Run SQL 28 (safe competency deletion) in your Supabase project, then reopen Competencies.';
    else if(code==='PGRST202'||/Could not find the function.*mathside_ct_assign_competency/i.test(raw))
      action='Run the included SQL 26 (secure competency tagging) in your Mathside Supabase project, then reload this page.';
    else if(code==='42P01'||code==='PGRST205'||/relation .* does not exist|could not find the table/i.test(raw))
      action='Run SQL 23 (Competency Tracker setup) before SQL 26.';
    else if(code==='42501'||code==='PGRST301'||/row.level security|permission denied|not authorized/i.test(raw))
      action='Access was denied. Confirm that this account owns the activity and competency, and that SQL 26 was installed.';
    else if(code==='23503')
      action='The referenced activity or competency could not be found. Refresh and select it again.';
    else if(code==='23505')
      action='This link already exists. Refresh and retry.';
    else if(code==='P0001'&&/teacher|own|permitted|authenticated/i.test(raw))
      action='Sign in as the teacher who created the activity and selected competency.';
    const detailLine=[raw,details,hint].filter(Boolean).join(' — ').slice(0,650);
    return [action,detailLine+(code?' [Supabase '+code+']':'')].filter(Boolean).join(' ');
  }
  function selectedId(fieldId){return String($(fieldId)?.value||'').trim();}
  async function validateSelection(fieldId){
    const competencyId=selectedId(fieldId);
    if(!competencyId)return {ok:true}; // Untagged activities remain fully supported.
    if(!teacher()||!me()||!client())return {ok:false,message:'Sign in as a teacher to save competency tags.'};
    if(!(await load()))return {ok:false,message:explainError(lastLoadError)};
    const exists=names.some(n=>n.id===competencyId && n.teacher_id===me());
    if(!exists)return {ok:false,message:'This competency is not in your private library. Choose a competency from your own account.'};
    return {ok:true};
  }
  async function loadForm(id){
    if(!teacher())return;
    await load();
    const select=$('ctAssignmentCompetency');
    if(select)select.value=links.find(l=>l.assignment_id===id)?.competency_id||'';
  }
  async function writeLinks(ids,competencyId){
    const deduped=[...new Set((ids||[]).filter(Boolean))];
    if(!deduped.length)return {ok:true};
    if(!teacher()||!client()||!me())return {ok:false,message:'You must be signed in as a teacher to tag an activity.'};
    // Unassigned competency is valid. A newly created untagged activity should not
    // generate any empty link row. Explicit clearing of an existing link is allowed.
    if(!competencyId&&!deduped.some(id=>links.some(l=>l.assignment_id===id&&l.competency_id)))return {ok:true};
    try {
      if(!(await load()))throw lastLoadError||new Error('Competency database not available.');
      if(competencyId&&!names.some(c=>c.id===competencyId&&c.teacher_id===me()))
        throw new Error('The selected competency is not in your private teacher library.');
      const {data,error}=await client().rpc('mathside_ct_assign_competency', {
        p_assignment_ids:deduped,
        p_competency_id:competencyId||null
      });
      if(error)throw error;
      if(Number(data)!==deduped.length)throw new Error('Tagging returned an unexpected activity count. Please check the activity links.');
      if(!(await load()))throw lastLoadError||new Error('Saved the tag, but could not reload competency data.');
      return {ok:true};
    }catch(e){
      console.error('[Mathside CT v11] Competency tagging failed. Existing activities were not removed:', {
        code:e?.code, message:e?.message, details:e?.details, hint:e?.hint, activityIds:deduped
      });
      return {ok:false,message:explainError(e),code:e?.code||'',assignmentIds:deduped};
    }
  }
  async function linkAssignments(ids){return writeLinks(ids,selectedId('ctAssignmentCompetency'));}
  async function linkPerformance(ids){return writeLinks(ids,selectedId('ctPerformanceCompetency'));}
  // Teacher-only library controls. Competency removal does not touch any
  // activity, grade, submission, class record, or archived score table.
  function renderLibrary(){
    const root=$('ctLibraryList'),count=$('ctLibraryCount');
    if(!root)return;
    const myNames=names.filter(c=>c.teacher_id===me());
    const heroCompetencyCount=$('ctHeroCompetencyCount');
    const heroTaggedCount=$('ctHeroTaggedCount');
    if(heroCompetencyCount)heroCompetencyCount.textContent=ready?String(myNames.length):'—';
    if(heroTaggedCount)heroTaggedCount.textContent=ready?String(links.filter(l=>l.competency_id && myNames.some(c=>c.id===l.competency_id)).length):'—';
    if(count)count.textContent=ready?`${myNames.length} competenc${myNames.length===1?'y':'ies'}`:'Unavailable';
    if(!ready){root.innerHTML='<p class="ct-library-empty">Competencies are unavailable until the database is ready.</p>';return;}
    if(!myNames.length){root.innerHTML='<p class="ct-library-empty">Your private library is empty. Select Add Competency to create your first learning competency.</p>';return;}
    root.innerHTML=myNames.map(c=>{
      const used=links.filter(l=>l.competency_id===c.id).length;
      return `<div class="ct-library-row"><div class="ct-library-info"><strong>${esc(c.name)}</strong><small>${used} tagged activit${used===1?'y':'ies'} (including archived)</small></div><button type="button" class="ct-library-delete" data-delete-competency="${esc(c.id)}" aria-label="Delete competency ${esc(c.name)}" title="Remove competency without deleting student scores"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg><span>Delete</span></button></div>`;
    }).join('');
  }
  async function deleteCompetency(id){
    if(!teacher()||!me()||!client())throw new Error('Sign in with your teacher account first.');
    if(!(await load()))throw lastLoadError||new Error('Competency database is unavailable.');
    const mine=names.find(c=>c.id===id&&c.teacher_id===me());
    if(!mine)throw new Error('This competency is not part of your private library.');
    const {data,error}=await client().rpc('mathside_ct_delete_competency',{p_competency_id:id});
    if(error)throw error;
    // Refresh both selectors and the student/class dashboards. Previous grades
    // and archived evidence are never edited by this code path.
    if(!(await load()))throw lastLoadError||new Error('Competency deleted, but the library could not refresh. Please reload.');
    renderLibrary();renderManager();await dashboard();
    return data;
  }
  async function manager(){if(!teacher())return;const status=$('ctDashboardStatus');if(status)status.textContent='Loading competency records...';try{if(!(await load())){if(status)status.textContent='Competency database unavailable. Run the supplied Supabase SQL migration, then refresh. The dashboard layout remains available.';dashboardFilters();renderDashboard();$('ctTeacherList').textContent='Competency assignments unavailable until Supabase setup is complete.';renderLibrary();return;}renderFilters();renderManager();renderLibrary();await dashboard();}catch(e){console.error('Competency dashboard:',e);if(status)status.textContent='Could not load competency data. Check the browser console and Supabase permissions.';}}
  function renderFilters(){const sections=state.sections||[];const grade=$('ctGradeFilter'),sec=$('ctSectionFilter'),stu=$('ctStudentFilter');const oldGrade=grade.value,oldSec=sec.value,oldStu=stu.value;grade.innerHTML='<option value="">All grades</option>'+[...new Set(sections.map(s=>String(s.grade_level||'')).filter(Boolean))].sort().map(g=>`<option value="${esc(g)}">Grade ${esc(g)}</option>`).join('');grade.value=oldGrade;const eligible=sections.filter(s=>!grade.value||String(s.grade_level)===grade.value);sec.innerHTML='<option value="">All sections</option>'+eligible.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');sec.value=oldSec;if(!sec.value)sec.value='';const students=state.students||[];const memberships=state.members||[];const eligibleStudents=students.filter(st=>{if(sec.value)return memberships.some(m=>m.student_id===st.id&&m.section_id===sec.value);return !grade.value||String(st.grade_level)===grade.value;});stu.innerHTML='<option value="">All students</option>'+eligibleStudents.map(st=>`<option value="${esc(st.id)}">${esc(st.display_name)}</option>`).join('');stu.value=oldStu;if(!stu.value)stu.value='';}
  function renderManager(){const list=$('ctTeacherList');const text=$('ctFilter').value.toLowerCase(), archived=$('ctShowArchived').checked;const grade=$('ctGradeFilter').value,section=$('ctSectionFilter').value,student=$('ctStudentFilter').value;const memberships=state.members||[];const studentSections=student?new Set(memberships.filter(m=>m.student_id===student).map(m=>m.section_id)):null;const rows=(state.assignments||[]).filter(a=>(archived||a.status!=='archived')&&String(a.title||'').toLowerCase().includes(text)&&(!grade||String(state.sections?.find(s=>s.id===a.section_id)?.grade_level)===grade)&&(!section||a.section_id===section)&&(!studentSections||studentSections.has(a.section_id)));list.innerHTML=rows.length?rows.map(a=>{const selected=links.find(l=>l.assignment_id===a.id)?.competency_id||'';return `<div class="ct-activity"><input type="checkbox" class="ct-check" value="${esc(a.id)}" aria-label="Select ${esc(a.title)}"><div class="ct-activity-text"><strong>${esc(a.title)}</strong><small>${a.status==='archived'?'Archived · scores retained where available':'Active'} · ${esc(state.sections?.find(s=>s.id===a.section_id)?.name||'Class')}</small></div><select class="ct-row-select" data-id="${esc(a.id)}" aria-label="Competency for ${esc(a.title)}"><option value="">No competency</option>${names.map(n=>`<option value="${esc(n.id)}" ${selected===n.id?'selected':''}>${esc(n.name)}</option>`).join('')}</select></div>`}).join(''):'<p>No activities found. Try another search.</p>';}
  async function setLinks(pairs){
    const unique=new Map(pairs);
    // Each competency is assigned in a separate security-validated transaction.
    // Already-saved activity scores are never changed by this operation.
    for(const [assignmentId,competencyId] of unique){
      const result=await writeLinks([assignmentId],competencyId||null);
      if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code||''});
    }
    if(!(await load()))throw lastLoadError||new Error('Could not refresh competency data.');
    renderManager();
  }
  // Student CT V20: ONE read-only, student-scoped query instead of independent
  // queries that could fail on restricted RLS and hide the entire panel.
  let studentRequestSerial = 0;
  const suggestedLevel = percent => percent == null ? 'Not yet assessed'
    : percent >= 85 ? 'Mastered' : percent >= 60 ? 'Developing'
    : percent >= 40 ? 'Beginning' : 'Needs support';
  function studentErrorView(text,sqlNeeded=false){
    const root=$('ctStudentContent');if(!root)return;
    root.innerHTML=`<div class="v20-ct-state v20-ct-error"><span class="v20-ct-state-icon" aria-hidden="true">!</span><h3>We couldn’t load your competency progress</h3><p>${esc(text)}</p>${sqlNeeded?'<small>Teacher setup: Run <strong>supabase/sql/30-student-competency-progress-repair.sql</strong> in Supabase SQL Editor.</small>':''}<button type="button" class="v20-ct-retry">Try again</button></div>`;
    root.querySelector('.v20-ct-retry')?.addEventListener('click',student);
  }
  // Resilient student path: no service-role key, no other student's data.
  // These SELECTs follow the existing student's RLS policies from SQL 23.
  // Scores and archived grades are read from this student's loaded workspace.
  async function fallbackStudentProgress(){
    const userId=me();
    const assignments=Array.isArray(state?.assignments)?state.assignments:[];
    const memberships=Array.isArray(state?.members)?state.members:[];
    const enrolled=new Set(memberships.filter(m=>m.student_id===userId).map(m=>m.section_id));
    const allowed=new Map(assignments.filter(a=>enrolled.has(a.section_id)&&['published','archived'].includes(a.status)).map(a=>[a.id,a]));
    const [linkResult,competencyResult]=await Promise.all([
      client().from('mathside_ct_links').select('assignment_id,competency_id,teacher_id'),
      client().from('mathside_ct_competencies').select('id,name,teacher_id')
    ]);
    if(linkResult.error)throw linkResult.error;
    if(competencyResult.error)throw competencyResult.error;
    const dictionary=new Map((competencyResult.data||[]).map(c=>[c.id,c]));
    const questions=Array.isArray(state?.questions)?state.questions:[];
    const submissions=Array.isArray(state?.submissions)?state.submissions:[];
    const archived=Array.isArray(state?.archivedScores)?state.archivedScores:[];
    const groups=new Map();
    for(const link of linkResult.data||[]){
      const activity=allowed.get(link.assignment_id);
      const comp=dictionary.get(link.competency_id);
      if(!activity || !comp || comp.teacher_id!==activity.teacher_id || link.teacher_id!==activity.teacher_id)continue;
      if(!groups.has(comp.id))groups.set(comp.id,{id:comp.id,name:comp.name,earned:0,possible:0,total_activities:0,assessed_activities:0,history:[],teacher_level:null,teacher_reason:null});
      const item=groups.get(comp.id);
      const possibleQuestions=questions.filter(q=>q.assignment_id===activity.id).reduce((n,q)=>n+Number(q.max_points||0),0);
      const max=activity.work_type==='performance_task'
        ?Number(activity.max_points||0)||possibleQuestions
        :possibleQuestions||Number(activity.max_points||0);
      const live=submissions.find(sub=>sub.assignment_id===activity.id&&sub.student_id===userId&&sub.status==='graded');
      const snapshot=archived.find(row=>row.assignment_id===activity.id&&row.student_id===userId);
      const score=live?(live.teacher_score??live.auto_score):snapshot?.score;
      const validScore=score!==null&&score!==undefined&&Number.isFinite(Number(score));
      const validMax=Number.isFinite(max)&&max>0;
      item.total_activities++;
      if(validScore&&validMax){item.assessed_activities++;item.earned+=Number(score);item.possible+=max;}
      item.history.push({assignment_id:activity.id,title:activity.title,score:validScore?Number(score):null,max:validMax?max:null,archived:activity.status==='archived'});
    }
    // Teachers' review decisions can be read by the student via SQL 23 RLS.
    // A denied review query must NOT hide assessment scores.
    if(groups.size){
      const {data,error}=await client().from('mathside_ct_reviews').select('competency_id,level,reason,reviewed_at').eq('student_id',userId).order('reviewed_at',{ascending:false});
      if(!error){
        for(const review of data||[]){const item=groups.get(review.competency_id);if(item&&!item.teacher_level){item.teacher_level=review.level;item.teacher_reason=review.reason;}}
      }
    }
    return [...groups.values()].map(item=>({...item,
      percent:item.possible>0?Math.round(Math.min(100,Math.max(0,item.earned*100/item.possible))):null,
      history:item.history.sort((a,b)=>a.title.localeCompare(b.title))
    })).sort((a,b)=>a.name.localeCompare(b.name));
  }
  async function student(){
    const root=$('ctStudentContent');if(!root)return;
    const request=++studentRequestSerial;
    root.innerHTML='<div class="v20-ct-state"><span class="v20-ct-spinner" aria-hidden="true"></span><h3>Preparing your learning progress…</h3><p>Reading your competencies and recorded assessment results.</p></div>';
    if(!client() || !me()){
      studentErrorView('Please sign in to your student account to view progress.');return;
    }
    try {
      let data=[], rpcIssue=null, fallbackIssue=null;
      try {
        const result=await client().rpc('mathside_ct_my_progress');
        if(result.error)throw result.error;
        if(!Array.isArray(result.data))throw Object.assign(new Error('Supabase returned an unexpected competency response.'),{code:'CT_RESPONSE'});
        data=result.data;
      }catch(error){rpcIssue=error;console.warn('[Mathside CT] Primary student query failed:',error);}
      if(request!==studentRequestSerial)return;
      // A second, RLS-limited read uses records already loaded in the student
      // workspace. It also lets the panel work when the RPC migration is absent.
      // If the RPC returned an empty result, cross-check for genuine linked work.
      if(rpcIssue || !data.length){
        try {
          const alternate=await fallbackStudentProgress();
          if(rpcIssue || alternate.length)data=alternate;
        }catch(error){fallbackIssue=error;console.warn('[Mathside CT] Alternate read failed:',error);}
      }
      if(request!==studentRequestSerial)return;
      if(rpcIssue && fallbackIssue){
        const code=String(rpcIssue.code||'');
        const fallbackCode=String(fallbackIssue.code||'');
        const description='Your learning records could not be loaded. The secure query reported: '
          +String(rpcIssue.message||rpcIssue).slice(0,230)+(code?' ['+code+']':'')
          +'. Alternate read: '+String(fallbackIssue.message||fallbackIssue).slice(0,160)
          +(fallbackCode?' ['+fallbackCode+']':'')+'.';
        studentErrorView(description,true);return;
      }
      if(rpcIssue && !data.length){
        studentErrorView('The secure progress function is unavailable and no linked competencies were returned. '+String(rpcIssue.message||'').slice(0,230)+' ['+String(rpcIssue.code||'CT_RPC')+']. Ask your teacher to run SQL 30 and check that activities are linked.',true);return;
      }
      const items=data.map(item=>({
        id:String(item.id||''), name:String(item.name||'Competency'),
        percent:item.percent===null||item.percent===undefined?null:Math.max(0,Math.min(100,Number(item.percent))),
        teacherLevel:item.teacher_level||null, teacherReason:item.teacher_reason||null,
        total:Number(item.total_activities||0), assessed:Number(item.assessed_activities||0),
        history:Array.isArray(item.history)?item.history:[]
      }));
      if(!items.length){
        root.innerHTML='<div class="v20-ct-state v20-ct-welcome"><span class="v20-ct-state-icon" aria-hidden="true">◎</span><h3>Your competencies will appear on your Dashboard</h3><p>Your teacher hasn’t linked any of your assigned activities to a competency yet. Once they do, you’ll see milestones here—even before a score is recorded.</p><button type="button" class="v20-ct-retry">Refresh progress</button></div>';
        root.querySelector('.v20-ct-retry')?.addEventListener('click',student);return;
      }
      const mastered=items.filter(c=>(c.teacherLevel||suggestedLevel(c.percent)).toLowerCase()==='mastered').length;
      const assessed=items.filter(c=>c.percent!==null && Number.isFinite(c.percent));
      const avg=assessed.length?Math.round(assessed.reduce((t,c)=>t+c.percent,0)/assessed.length):null;
      root.innerHTML=`
        <div class="v20-ct-overview">
          <div class="v20-ct-stat"><span>Total competencies</span><strong>${items.length}</strong><small>Your learning milestones</small></div>
          <div class="v20-ct-stat"><span>Mastered</span><strong>${mastered}</strong><small>Skills you have demonstrated</small></div>
          <div class="v20-ct-stat"><span>Average progress</span><strong>${avg===null?'—':avg+'%'}</strong><small>${assessed.length} assessed competenc${assessed.length===1?'y':'ies'}</small></div>
        </div>
        <section class="v20-ct-journey" aria-labelledby="v20CtJourneyTitle">
          <div class="v20-ct-journey-head"><div><span class="v20-ct-overline">YOUR LEARNING PATH</span><h2 id="v20CtJourneyTitle">One skill at a time.</h2><p>Tap a circle to see your score and assessment history.</p></div><button type="button" class="v20-ct-retry v20-ct-refresh">↻ Refresh</button></div>
          <div class="ct-line-scroll" aria-label="Competency milestones"><div class="ct-line">${items.map((c,i)=>`<button type="button" class="ct-node ${c.percent===null?'ct-unassessed':(c.teacherLevel||suggestedLevel(c.percent)).toLowerCase()==='mastered'?'ct-mastered':'ct-progress'}" data-index="${i}" aria-label="${esc(c.name)}, ${c.percent===null?'not assessed':c.percent+' percent'}"><span class="ct-circle">${c.percent===null?'–':(c.teacherLevel||suggestedLevel(c.percent)).toLowerCase()==='mastered'?'✓':Math.round(c.percent)+'%'}</span><span class="ct-node-name">${esc(c.name)}</span></button>`).join('')}</div></div>
          <div class="v20-ct-legend"><span><i class="is-mastered"></i> Mastered</span><span><i class="is-developing"></i> In progress</span><span><i class="is-unassessed"></i> Not assessed</span></div>
        </section>
        <section class="ct-detail v20-ct-detail" id="ctDetail" aria-live="polite"></section>`;
      function select(i){
        const c=items[i];if(!c)return;
        root.querySelectorAll('.ct-node').forEach((node,j)=>{node.classList.toggle('ct-selected',i===j);node.setAttribute('aria-pressed',String(i===j));});
        const level=c.teacherLevel||suggestedLevel(c.percent);
        const levelDescription=c.teacherLevel?'Teacher-reviewed proficiency':'Suggested from recorded scores';
        const details=c.history.map(a=>{
          const sc=a.score===null||a.score===undefined?null:Number(a.score),max=a.max===null||a.max===undefined?null:Number(a.max);
          return `<div class="ct-history"><div><strong>${esc(a.title||'Activity')}</strong><small>${a.archived?'Archived · Score preserved':'Assigned activity'}</small></div><b>${sc===null?'Not graded':max>0?`${esc(sc)}/${esc(max)}`:`${esc(sc)} pts · maximum unavailable`}</b></div>`;
        }).join('');
        $('ctDetail').innerHTML=`<div class="v20-ct-detail-top"><div><span class="v20-ct-overline">COMPETENCY ${i+1} OF ${items.length}</span><h3>${esc(c.name)}</h3><span class="v20-ct-level">${esc(level)}</span></div><div class="v20-ct-score"><strong>${c.percent===null?'—':Math.round(c.percent)+'%'}</strong><small>Calculated progress</small></div></div>
          <div class="v20-ct-progress-track" role="progressbar" aria-label="Calculated proficiency" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent===null?0:Math.round(c.percent)}"><span style="width:${c.percent===null?0:c.percent}%"></span></div>
          <p class="v20-ct-explainer">${esc(levelDescription)}${c.teacherReason?' · '+esc(c.teacherReason):''}. ${c.assessed} of ${c.total} linked activit${c.total===1?'y':'ies'} assessed. Your teacher’s archived activity scores remain included when recorded.</p>
          <div class="v20-ct-history-title"><h4>Assessment history</h4><span>${c.history.length} activit${c.history.length===1?'y':'ies'}</span></div>
          <div class="v20-ct-history">${details||'<p class="v20-ct-no-history">No scored assessment evidence yet.</p>'}</div>`;
      }
      root.querySelectorAll('.ct-node').forEach(n=>n.addEventListener('click',()=>{select(Number(n.dataset.index));$('ctDetail')?.classList.add('v22-detail-open');}));
      root.querySelector('.v20-ct-refresh')?.addEventListener('click',student);
      select(0);
    }catch(error){
      if(request!==studentRequestSerial)return;
      console.error('[Mathside CT student] Unexpected error:',error);
      studentErrorView('Unexpected error: '+String(error?.message||error).slice(0,250)+'. Ask your teacher to run SQL 30 and share the error code if this continues.');
    }
  }

  const round = x => Math.round(x*10)/10;
  function dashboardFilters(){
    const grade=$('ctDashboardGrade'), section=$('ctDashboardSection'), student=$('ctDashboardStudent');
    if(!grade||!section||!student)return;
    const old=[grade.value,section.value,student.value];
    const sections=state.sections||[],members=state.members||[],students=state.students||[];
    const grades=[...new Set(sections.map(s=>String(s.grade_level||'')).filter(Boolean))].sort();
    grade.innerHTML='<option value="">All grades</option>'+grades.map(g=>`<option value="${esc(g)}">Grade ${esc(g)}</option>`).join('');
    if(grades.includes(old[0]))grade.value=old[0];
    const allowedSections=sections.filter(s=>!grade.value||String(s.grade_level)===grade.value);
    section.innerHTML='<option value="">All sections</option>'+allowedSections.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    if(allowedSections.some(s=>String(s.id)===old[1]))section.value=old[1];
    const allowedIds=new Set(members.filter(m=>allowedSections.some(s=>s.id===m.section_id)&&(!section.value||m.section_id===section.value)).map(m=>m.student_id));
    const eligible=students.filter(s=>allowedIds.has(s.id));
    student.innerHTML='<option value="">All students</option>'+eligible.map(s=>`<option value="${esc(s.id)}">${esc(s.display_name)}</option>`).join('');
    if(eligible.some(s=>s.id===old[2]))student.value=old[2];
  }
  // Student picker only controls the INDIVIDUAL detail card. Aggregate grade
  // and section summaries always include every eligible student.
  function dashboardSearchCandidates(){
    const selectedIds=new Set([...($('ctDashboardStudent')?.options||[])].map(x=>x.value).filter(Boolean));
    return (state.students||[]).filter(s=>selectedIds.has(String(s.id))).sort((a,b)=>
      String(a.display_name||'').localeCompare(String(b.display_name||''),undefined,{sensitivity:'base'}));
  }
  function dashboardStudentSectionName(id){
    const selectedSections=new Set([...($('ctDashboardSection')?.options||[])].map(x=>x.value).filter(Boolean));
    const selected=$('ctDashboardSection')?.value;
    const memberships=(state.members||[]).filter(m=>m.student_id===id && selectedSections.has(String(m.section_id)) && (!selected||m.section_id===selected));
    const sectionNames=memberships.map(m=>(state.sections||[]).find(s=>s.id===m.section_id)?.name).filter(Boolean);
    return [...new Set(sectionNames)].join(', ')||'Section not specified';
  }
  function clearDashboardStudentSearch({focus=false}={}){
    const field=$('ctDashboardStudentSearch'), select=$('ctDashboardStudent'), close=$('ctDashboardStudentClear');
    if(select)select.value='';
    if(field){field.value='';field.setAttribute('aria-expanded','false');if(focus)field.focus();}
    if(close)close.hidden=true;
    const list=$('ctDashboardStudentMatches');if(list){list.hidden=true;list.innerHTML='';}
  }
  function renderDashboardStudentMatches(){
    const input=$('ctDashboardStudentSearch'),list=$('ctDashboardStudentMatches');
    if(!input||!list)return;
    const term=input.value.trim().toLocaleLowerCase();
    if(!term){list.innerHTML='';list.hidden=true;input.setAttribute('aria-expanded','false');return;}
    const matches=dashboardSearchCandidates().filter(s=>String(s.display_name||'').toLocaleLowerCase().includes(term));
    list.innerHTML=matches.length?matches.slice(0,12).map(s=>`<button type="button" class="ct-student-match" data-ct-student-id="${esc(s.id)}"><span>${esc(s.display_name||'Unnamed student')}</span><small>${esc(dashboardStudentSectionName(s.id))}</small></button>`).join('')+(matches.length>12?`<p class="ct-student-match-more">Showing 12 of ${matches.length} matches. Keep typing to narrow the search.</p>`:''):'<p class="ct-student-match-empty">No students match that name in the selected grade and section.</p>';
    list.hidden=false;
    input.setAttribute('aria-expanded','true');
  }
  function selectDashboardStudent(id){
    const record=dashboardSearchCandidates().find(s=>String(s.id)===String(id));
    if(!record)return;
    $('ctDashboardStudent').value=String(record.id);
    $('ctDashboardStudentSearch').value=String(record.display_name||'Unnamed student');
    $('ctDashboardStudentClear').hidden=false;
    $('ctDashboardStudentMatches').hidden=true;
    $('ctDashboardStudentSearch').setAttribute('aria-expanded','false');
    renderDashboard();
  }
  function getDashboardRows(){
    const sections=state.sections||[],members=state.members||[],students=state.students||[];
    const grade=$('ctDashboardGrade')?.value||'', section=$('ctDashboardSection')?.value||'';
    const allowed=sections.filter(s=>(!grade||String(s.grade_level)===grade)&&(!section||s.id===section));
    const sectionIds=new Set(allowed.map(s=>s.id));
    const studentIds=new Set(members.filter(m=>sectionIds.has(m.section_id)).map(m=>m.student_id));
    const visibleStudents=students.filter(s=>studentIds.has(s.id));
    const visibleIds=new Set(visibleStudents.map(s=>s.id));
    const assignments=(state.assignments||[]).filter(a=>sectionIds.has(a.section_id));
    const assignmentById=new Map(assignments.map(a=>[a.id,a]));
    const linked=links.filter(l=>l.competency_id&&assignmentById.has(l.assignment_id));
    const comps=[...new Set(linked.map(l=>l.competency_id))].map(id=>({id,name:names.find(n=>n.id===id)?.name||'Competency'})).sort((a,b)=>a.name.localeCompare(b.name));
    const maxByAssignment=new Map();
    for(const q of state.questions||[])maxByAssignment.set(q.assignment_id,(maxByAssignment.get(q.assignment_id)||0)+Number(q.max_points||0));
    const evidence=new Map();
    for(const s of state.submissions||[]){
      if(!visibleIds.has(s.student_id)||!assignmentById.has(s.assignment_id))continue;
      const score=s.teacher_score??(s.status==='graded'?s.auto_score:null);
      if(score!=null&&Number.isFinite(Number(score)))evidence.set(s.student_id+'|'+s.assignment_id,Number(score));
    }
    for(const s of state.archivedScores||[]){
      if(!visibleIds.has(s.student_id)||!assignmentById.has(s.assignment_id))continue;
      if(s.score!=null&&Number.isFinite(Number(s.score)))evidence.set(s.student_id+'|'+s.assignment_id,Number(s.score));
    }
    const byComp=new Map();for(const l of linked){if(!byComp.has(l.competency_id))byComp.set(l.competency_id,[]);byComp.get(l.competency_id).push(l.assignment_id);}
    const results=visibleStudents.map(s=>{
      const scores=comps.map(c=>{
        let earned=0,possible=0,count=0;
        for(const aid of byComp.get(c.id)||[]){const key=s.id+'|'+aid,max=maxByAssignment.get(aid)||0;
          if(evidence.has(key)&&max>0){earned+=evidence.get(key);possible+=max;count++;}}
        return {id:c.id,percent:possible>0?Math.max(0,Math.min(100,round(earned/possible*100))):null,count};
      });
      const assessed=scores.filter(x=>x.percent!==null);
      return {id:s.id,name:s.display_name,section:members.filter(m=>m.student_id===s.id&&sectionIds.has(m.section_id)).map(m=>sections.find(x=>x.id===m.section_id)?.name).filter(Boolean).join(', '),scores,overall:assessed.length?round(assessed.reduce((a,x)=>a+x.percent,0)/assessed.length):null};
    });
    return {comps,results};
  }
  function renderDashboard(){
    const root=$('ctDashboardContent');if(!root)return;
    const {comps,results}=getDashboardRows();
    const assessed=results.filter(r=>r.overall!==null);
    const avg=assessed.length?round(assessed.reduce((a,r)=>a+r.overall,0)/assessed.length):null;
    const mastery=assessed.filter(r=>r.overall>=85).length;
    const summary=comps.map((c,i)=>{
      const scores=results.map(r=>r.scores[i].percent).filter(x=>x!==null);
      return {name:c.name,count:scores.length,mean:scores.length?round(scores.reduce((a,b)=>a+b,0)/scores.length):null,mastered:scores.filter(x=>x>=85).length};
    });
    const id=$('ctDashboardStudent')?.value||'';
    const selected=results.find(r=>String(r.id)===String(id));
    const studentContent=selected?
      `<div class="ct-student-single-head"><div><span class="ct-student-overline">SELECTED STUDENT</span><h4>${esc(selected.name)}</h4><p>${esc(selected.section||'Section not specified')}</p></div><div class="ct-student-overall"><strong>${selected.overall===null?'—':selected.overall+'%'}</strong><small>${selected.overall===null?'Not assessed':'Overall CT'}</small></div></div>
       <div class="ct-mini-line">${selected.scores.map((s,i)=>`<div class="ct-mini-node" title="${esc(comps[i].name)}"><span class="${s.percent===null?'empty':s.percent>=85?'mastered':'developing'}">${s.percent===null?'–':s.percent>=85?'✓':Math.round(s.percent)+'%'}</span><small>${esc(comps[i].name)}</small></div>`).join('')}</div>
       ${!selected.scores.length?'<p class="ct-empty">No competencies are linked to this student’s activities.</p>':`<div class="ct-student-competency-list">${selected.scores.map((s,i)=>`<div class="ct-student-competency-item"><span>${esc(comps[i].name)}</span><strong>${s.percent===null?'Not assessed':s.percent+'%'}</strong></div>`).join('')}</div>`}`
      :`<div class="ct-single-student-empty"><span class="ct-single-student-icon" aria-hidden="true">⌕</span><strong>${results.length?'Find a student to view their progress':'No students in this selection'}</strong><p>${results.length?'Use the Search student field above. One student’s competency tracker will appear here at a time.':'Choose a different grade or section to find students.'}</p></div>`;
    root.innerHTML=`<div class="ct-summary-cards"><div><strong>${results.length}</strong><span>Students in selected classes</span></div><div><strong>${avg===null?'—':avg+'%'}</strong><span>Average overall CT</span></div><div><strong>${mastery}/${assessed.length}</strong><span>Students at 85%+ overall</span></div><div><strong>${comps.length}</strong><span>Linked competencies</span></div></div>
      <div class="ct-dashboard-grid"><section class="ct-dashboard-panel"><h3>Combined competency tracker</h3><p class="muted">All students in the selected grade and section are included, even when you select one student to view.</p>
        ${summary.length?summary.map(c=>`<div class="ct-summary-row"><div><strong>${esc(c.name)}</strong><small>${c.count} of ${results.length} assessed · ${c.count?round(c.mastered/c.count*100)+'% mastered':'No evidence'}</small></div><b>${c.mean===null?'—':c.mean+'%'}</b><div class="ct-bar"><span style="width:${c.mean??0}%"></span></div></div>`).join(''):'<p class="ct-empty">No competencies linked to activities in this selection.</p>'}</section>
      <section class="ct-dashboard-panel"><h3>Individual student CT</h3><p class="muted">Search and select a student above to see only that learner’s competency progress.</p>${studentContent}</section></div>
      <p class="ct-dashboard-footnote">Overall CT is the average of each student's assessed competency percentages. Students without valid scored evidence are shown as Not assessed, not 0%. Archived scores are included when available. This is a score-based suggestion; teacher review decisions are not yet reflected in these figures.</p>`;
    if($('ctDashboardStatus'))$('ctDashboardStatus').textContent=`Showing ${results.length} students and ${comps.length} competencies in the combined summary${selected?'; viewing '+selected.name+' individually':''}.`;
  }
  async function dashboard(){if(!teacher())return;dashboardFilters();const chosen=$('ctDashboardStudent').value;if(chosen){const student=(state.students||[]).find(s=>s.id===chosen);if(student){$('ctDashboardStudentSearch').value=student.display_name||'';$('ctDashboardStudentClear').hidden=false;}}renderDashboard();}

  document.addEventListener('DOMContentLoaded',()=>{
    $('ctTeacherOpen')?.addEventListener('click',manager);
    $('ctDashboardGrade')?.addEventListener('change',()=>{ $('ctDashboardSection').value='';clearDashboardStudentSearch();dashboardFilters();renderDashboard(); });
    $('ctDashboardSection')?.addEventListener('change',()=>{ clearDashboardStudentSearch();dashboardFilters();renderDashboard(); });
    const studentSearch=$('ctDashboardStudentSearch');
    studentSearch?.addEventListener('input',()=>{
      if($('ctDashboardStudent').value){$('ctDashboardStudent').value='';renderDashboard();}
      $('ctDashboardStudentClear').hidden=studentSearch.value.length===0;
      renderDashboardStudentMatches();
    });
    studentSearch?.addEventListener('focus',renderDashboardStudentMatches);
    studentSearch?.addEventListener('keydown',event=>{
      if(event.key==='Escape'){
        $('ctDashboardStudentMatches').hidden=true;
        studentSearch.setAttribute('aria-expanded','false');
      }else if(event.key==='Enter'){
        const first=$('ctDashboardStudentMatches')?.querySelector('[data-ct-student-id]');
        if(first){event.preventDefault();selectDashboardStudent(first.dataset.ctStudentId);}
      }
    });
    $('ctDashboardStudentMatches')?.addEventListener('click',event=>{
      const option=event.target.closest('[data-ct-student-id]');
      if(option)selectDashboardStudent(option.dataset.ctStudentId);
    });
    $('ctDashboardStudentClear')?.addEventListener('click',()=>{
      clearDashboardStudentSearch({focus:true});renderDashboard();
    });
    document.addEventListener('click',event=>{
      if(!event.target.closest('#ctStudentSearchGroup')){
        const list=$('ctDashboardStudentMatches');if(list)list.hidden=true;
        studentSearch?.setAttribute('aria-expanded','false');
      }
    });
    $('ctClose')?.addEventListener('click',()=>{
      // This button closes the expandable manager inside Competencies.
      // 'overview' is NOT a teacher view: navigating there hides all panels.
      const details=$('ctClose')?.closest('details.ct-manage-details');
      if(details){
        details.open=false;
        const heading=details.querySelector('summary');
        if(heading)heading.focus({preventScroll:true});
      } else if(typeof showTeacherView==='function') {
        showTeacherView('competencies');
      }
    });
    $('ctGradeFilter')?.addEventListener('change',()=>{renderFilters();renderManager()});
    $('ctSectionFilter')?.addEventListener('change',()=>{renderFilters();renderManager()});
    $('ctStudentFilter')?.addEventListener('change',renderManager);
    const createOverlay=$('ctCreateOverlay'),createName=$('ctCreateName'),createError=$('ctCreateError'),createSubmit=$('ctCreateSubmit');
    let createTarget=null,creatorTrigger=null;
    const closeCreator=()=>{
      if(!createOverlay)return;
      if(typeof createOverlay.close==='function'&&createOverlay.open)createOverlay.close();
      else {createOverlay.removeAttribute('open');createOverlay.classList.remove('ct-create-fallback-open');}
      createTarget=null;createError.hidden=true;
      try{creatorTrigger?.focus();}catch(_){}
      creatorTrigger=null;
    };
    const openCreator=target=>{
      createTarget=target;creatorTrigger=document.activeElement;createName.value='';createError.hidden=true;
      try {
        // The most recently opened native <dialog> is always above the
        // still-open Create Activity/Performance Task dialog (the top layer).
        if(createOverlay.open)createOverlay.close();
        createOverlay.classList.remove('ct-create-fallback-open');
        document.body.appendChild(createOverlay);
        if(typeof createOverlay.showModal!=='function')throw new Error('Use a current version of Chrome, Edge, or Firefox for nested dialogs.');
        createOverlay.showModal();
        createName.focus();
      }catch(error){
        console.error('Could not open competency creator above activity form:',error);
        createTarget=null;
        message('Cannot open competency creator. Update your browser and try again.');
      }
    };
    // Reuse the same Supabase-backed creator in the CT dashboard, its library,
    // Create Activity, and Create Performance Task. Null means library-only:
    // no activity is created or modified.
    $('ctDashboardAddCompetency')?.addEventListener('click',()=>openCreator(null));
    $('ctLibraryAddCompetency')?.addEventListener('click',()=>openCreator(null));
    $('ctNewCompetency')?.addEventListener('click',()=>openCreator('ctAssignmentCompetency'));
    $('ctNewPerformanceCompetency')?.addEventListener('click',()=>openCreator('ctPerformanceCompetency'));
    $('ctCreateClose')?.addEventListener('click',closeCreator);
    $('ctCreateCancel')?.addEventListener('click',closeCreator);
    createOverlay?.addEventListener('click',e=>{if(e.target===createOverlay)closeCreator();});
    createOverlay?.addEventListener('cancel',e=>{e.preventDefault();closeCreator();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&createOverlay?.open){e.preventDefault();closeCreator();}});
    $('ctCreateForm')?.addEventListener('submit',async e=>{
      e.preventDefault();const name=createName.value.trim().replace(/\s+/g,' ');
      if(!name)return;
      createSubmit.disabled=true;createSubmit.textContent='Saving...';createError.hidden=true;
      try {
        if(!ready&&!(await load()))throw lastLoadError||Error('Run SQL 23 (Competency Tracker setup) in Supabase first.');
        const targetId=createTarget; // Remember the origin before closeCreator resets it.
        const wasExisting=names.some(n=>n.teacher_id===me()&&n.name.trim().toLowerCase()===name.toLowerCase());
        const id=await add(name); // Database insert uses the currently authenticated teacher ID.
        if(!id)throw Error('Enter a competency name with 1 to 180 characters.');
        const target=targetId?$(targetId):null;
        if(target) target.value=id;
        else {
          // Library creation does not create an activity. Show the newly saved
          // name immediately and update both the header count and dashboard.
          renderLibrary();
          renderManager();
          renderDashboard();
          const libraryDetails=$('ctLibraryDetails');
          if(libraryDetails) libraryDetails.open=true;
        }
        closeCreator();
        message(target?'Competency selected: '+name:(wasExisting?'Competency already in your library: ':'Competency added to your library: ')+name);
      }catch(err){createError.textContent=explainError(err);createError.hidden=false;}
      finally{createSubmit.disabled=false;createSubmit.textContent='Add Competency';}
    });
    // Native confirmation dialog, with an explicit promise to preserve grades.
    const deleteDlg=$('ctDeleteDialog'),deleteConfirm=$('ctDeleteConfirm'),deleteError=$('ctDeleteError');
    let pendingDeletion=null,deleteBusy=false;
    const closeDelete=()=>{
      if(deleteBusy)return;
      if(deleteDlg?.open)deleteDlg.close();
      pendingDeletion=null;
      if(deleteError)deleteError.hidden=true;
    };
    $('ctLibraryList')?.addEventListener('click',event=>{
      const button=event.target.closest('[data-delete-competency]');
      if(!button||deleteBusy)return;
      const id=button.dataset.deleteCompetency;
      const item=names.find(n=>n.id===id&&n.teacher_id===me());
      if(!item)return;
      pendingDeletion=id;
      const used=links.filter(l=>l.competency_id===id).length;
      $('ctDeleteDescription').textContent=`Delete “${item.name}” from your private library? This will remove the competency and its ${used} activity tag${used===1?'':'s'} (including archived activities), plus its CT review decisions.`;
      deleteError.hidden=true;
      document.body.appendChild(deleteDlg);
      if(!deleteDlg.open)deleteDlg.showModal();
    });
    $('ctDeleteCancel')?.addEventListener('click',closeDelete);
    deleteDlg?.addEventListener('cancel',event=>{if(deleteBusy)event.preventDefault();else pendingDeletion=null;});
    deleteConfirm?.addEventListener('click',async()=>{
      if(!pendingDeletion||deleteBusy)return;
      deleteBusy=true;
      const id=pendingDeletion;
      deleteConfirm.disabled=true;
      $('ctDeleteCancel').disabled=true;
      deleteConfirm.textContent='Deleting…';
      deleteError.hidden=true;
      try {
        const result=await deleteCompetency(id);
        if(deleteDlg.open)deleteDlg.close();
        pendingDeletion=null;
        message(`Competency deleted. ${Number(result?.unlinked_activities||0)} activity tag(s) removed. Student scores and archived records were kept.`);
      }catch(error){
        console.error('[Mathside CT v12] Competency deletion failed:',error);
        deleteError.textContent=explainError(error);
        deleteError.hidden=false;
      }finally{
        deleteBusy=false;
        deleteConfirm.disabled=false;
        $('ctDeleteCancel').disabled=false;
        deleteConfirm.textContent='Delete competency';
      }
    });
    $('ctFilter')?.addEventListener('input',renderManager);$('ctShowArchived')?.addEventListener('change',renderManager);
    $('ctTeacherList')?.addEventListener('change',async e=>{if(!e.target.matches('.ct-row-select'))return;try{await setLinks([[e.target.dataset.id,e.target.value]]);}catch(err){message(explainError(err));}});
    $('ctBulkApply')?.addEventListener('click',async()=>{const id=$('ctBulkSelect').value;const selected=[...document.querySelectorAll('.ct-check:checked')].map(c=>[c.value,id]);if(!selected.length)return message('Select at least one activity.');if(!id)return message('Select a competency first.');try{await setLinks(selected);message(`Competency linked to ${selected.length} activities.`);}catch(e){message(explainError(e));}});
  });
  window.MathsideCompetencies={version:'21.0',loadForm,linkAssignments,linkPerformance,validateSelection,renderStudent:student,loadPerformance:async(ids)=>{await load();const el=$('ctPerformanceCompetency');if(el)el.value=links.find(l=>ids.includes(l.assignment_id))?.competency_id||'';},refreshManager:manager};
})();
