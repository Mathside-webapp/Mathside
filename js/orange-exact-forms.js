/* Mathside orange UI enhancement.
 * Purely presentational: keep original checkbox names, form IDs and save handlers. */
(() => {
  'use strict';
  const groups = [
    ['assignmentSectionChecklist','assignmentClassSearch','assignmentClassHint'],
    ['performanceSectionChecklist','performanceClassSearch','performanceClassHint']
  ];
  function enhance(list){
    if(!list) return;
    list.querySelectorAll('label.class-check-option').forEach(label => {
      if(!label.classList.contains('orange-enhanced-class')){
        label.classList.add('orange-enhanced-class');
        const input=label.querySelector('input[type="checkbox"]');
        const text=label.querySelector('span');
        const small=text?.querySelector('small');
        if(input && text && small){
          const grade=(small.textContent || '').match(/\d{1,2}/)?.[0] || '';
          text.classList.add('orange-class-main');
          const badge=document.createElement('span');
          badge.className='orange-grade-badge grade-'+grade;
          badge.textContent=grade || '•';
          badge.setAttribute('aria-hidden','true');
          label.insertBefore(badge,text);
          let count=null;
          try {
            if(typeof studentsForSection==='function') count=studentsForSection(input.value).length;
          } catch(_) { /* list still renders if student roster isn't loaded */ }
          if(Number.isInteger(count)) {
            const counter=document.createElement('span');
            counter.className='orange-student-count';
            counter.textContent=count+' student'+(count===1?'':'s');
            label.appendChild(counter);
          }
        }
      }
    });
  }
  function refresh(list,search,hint){
    if(!list) return;
    enhance(list);
    const q=(search?.value||'').trim().toLocaleLowerCase();
    let visible=0;
    const labels=Array.from(list.querySelectorAll('label.class-check-option'));
    labels.forEach(label => {
      const hay=(label.querySelector('.orange-class-main')?.textContent||label.textContent||'').toLocaleLowerCase();
      const matches=!q||hay.includes(q);
      label.classList.toggle('orange-class-row-filtered',!matches);
      if(matches) visible++;
    });
    let empty=list.querySelector('.orange-class-empty-search');
    if(!empty&&labels.length){
      empty=document.createElement('p');
      empty.className='orange-class-empty-search';
      empty.textContent='No matching classes. Try another name or grade.';
      list.appendChild(empty);
    }
    if(empty) empty.hidden=!q || visible>0;
    if(hint){
      const selected=list.querySelectorAll('input[type="checkbox"]:checked').length;
      hint.textContent=selected===0?'Select one or more':selected+' class'+(selected===1?'':'es')+' selected';
    }
  }
  function attach(listId,searchId,hintId){
    const list=document.getElementById(listId);
    const search=document.getElementById(searchId);
    const hint=document.getElementById(hintId);
    if(!list) return;
    const update=()=>refresh(list,search,hint);
    if(search) search.addEventListener('input',update);
    list.addEventListener('change',update);
    const observer=new MutationObserver(update);
    observer.observe(list,{childList:true});
    // Ensure first enhancement runs even when a user opens a dialog after the initial load.
    update();
    const modal=list.closest('dialog');
    if(modal) modal.addEventListener('click',update,{capture:false});
  }
  function init(){groups.forEach(args=>attach(...args));}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
