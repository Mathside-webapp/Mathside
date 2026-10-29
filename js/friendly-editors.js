/* Progressive disclosure without changing submission or validation handlers. */
(() => {
  document.querySelectorAll('.friendly-editor').forEach(dialog => {
    const form = dialog.querySelector('form');
    const panels = [...dialog.querySelectorAll('.editor-options')];
    const schedule = panels.find(panel => panel.querySelector('[name="publish_mode"]'));
    function refreshSummary() {
      if (!schedule) return;
      const mode = form.elements.publish_mode.value;
      const due = form.elements.due_at.value;
      const date = due ? new Date(due).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
      schedule.querySelector('summary small').textContent = `${mode === 'schedule' ? 'Scheduled posting' : 'Post now'} · ${due ? `Due ${date}` : 'No deadline'}`;
    }
    form.addEventListener('change', refreshSummary);
    // Reveal invalid fields before the browser attempts to focus them.
    form.addEventListener('invalid', event => {
      const panel = event.target.closest('details');
      if (panel) panel.open = true;
    }, true);
    new MutationObserver(() => {
      if (!dialog.open) return;
      panels.forEach(panel => {
        panel.open = [...panel.querySelectorAll('input,select')].some(input => {
          if (input.type === 'checkbox') return input.checked;
          if (input.type === 'file') return input.files.length > 0;
          if (input.name === 'publish_mode') return input.value === 'schedule';
          if (input.name === 'reminder_hours_before') return input.value !== '0';
          return input.type === 'datetime-local' && Boolean(input.value);
        }) || [...panel.querySelectorAll('img, #performanceRubricExisting, #removePerformanceImagesWrap, #removePerformanceRubricWrap')].some(el => !el.hidden);
      });
      refreshSummary();
    }).observe(dialog, { attributes:true, attributeFilter:['open'] });
  });
})();
