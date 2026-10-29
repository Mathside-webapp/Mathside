/* Presentation enhancements. Classroom data and actions remain in app.js. */
document.addEventListener('click',event=>{
 if(event.target.closest('[data-v9-new-assignment]')) document.getElementById('postAssignmentBtn').click();
});
document.getElementById('teacherMenuBtn').addEventListener('click',()=>{
 if(innerWidth>780){
  document.getElementById('teacherApp').classList.toggle('v9-sidebar-collapsed');
  closeTeacherSidebar();
  document.getElementById('teacherMenuBtn').setAttribute('aria-expanded',String(!document.getElementById('teacherApp').classList.contains('v9-sidebar-collapsed')));
 }
});
const publicLinks=[...document.querySelectorAll('#mainNav a')];
document.getElementById('menuToggle').addEventListener('click',()=>document.getElementById('menuToggle').setAttribute('aria-expanded',String(document.getElementById('mainNav').classList.contains('mobile-open'))));
const sectionObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)publicLinks.forEach(a=>a.classList.toggle('v9-current',a.hash==='#'+entry.target.id));},{rootMargin:'-15% 0px -60% 0px'});
document.querySelectorAll('#publicSite main>section').forEach(s=>sectionObserver.observe(s));
