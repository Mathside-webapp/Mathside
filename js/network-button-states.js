/* Mathside 2026 | Supabase / R2 network action button feedback.
 * Presentation-only. It never changes requests, SQL, auth, data or upload semantics.
 * Observe real network requests, lock the initiating button while they are active,
 * and restore the original content, ARIA state and disabled state afterward.
 */
(() => {
  'use strict';
  const ACTIVE_HOSTS = /(?:^|\.)(?:supabase\.co|supabase\.in|r2\.cloudflarestorage\.com)$/i;
  const buttons = new WeakMap();
  const active = new Set();
  const idleDelay = 900;
  const noRequestDelay = 1450;
  let latest = null;
  let nextId = 0;

  function isRemoteUrl(value) {
    try { return ACTIVE_HOSTS.test(new URL(value, location.href).hostname); }
    catch (_) { return false; }
  }

  function actionLabel(button) {
    const id = String(button?.id || '').toLowerCase();
    const text = String(button?.getAttribute('aria-label') || button?.textContent || button?.value || '').trim().toLowerCase();
    const form = button?.form?.id?.toLowerCase() || '';
    const original = `${id} ${text} ${form}`;
    if (/sign.?out|log.?out/.test(original)) return 'Signing out…';
    if (/log.?in|sign.?in|authsubmit/.test(original)) return 'Logging in…';
    if (/sign.?up|register|create account/.test(original)) return 'Creating account…';
    if (/reset.*password|password.*reset/.test(original)) return 'Resetting…';
    if (/delete|remove|clear submission/.test(original)) return 'Deleting…';
    if (/archive/.test(original) && !/unarchive|restore/.test(original)) return 'Archiving…';
    if (/restore|unarchive/.test(original)) return 'Restoring…';
    if (/upload|file|picture|photo|proof/.test(original) && /upload|attach/.test(original)) return 'Uploading…';
    if (/submit|send/.test(original)) return 'Submitting…';
    if (/download|export|excel|report/.test(original)) return 'Preparing…';
    if (/import/.test(original)) return 'Importing…';
    if (/post|publish/.test(original)) return 'Posting…';
    if (/approve|reject/.test(original)) return 'Updating…';
    if (/grade|save|update|edit|apply|assign|link|rate|rating|feedback/.test(original)) return 'Saving…';
    if (/create|add|enroll|join|generate/.test(original)) return 'Creating…';
    return 'Loading…';
  }

  const knownRemoteAction = /(?:login|signin|signout|logout|authsubmit|submit|post|publish|save|update|delete|remove|clear|archive|restore|upload|export|download|import|reset|confirm|grade|sync|approve|reject|assign|link|apply|generate|create|enroll|rating|feedback)/i;
  function likelyRemote(btn) {
    const descriptor = [btn.id, btn.name, btn.getAttribute('aria-label'), btn.textContent, btn.value, btn.form?.id].filter(Boolean).join(' ');
    // Modal launchers, Math Keyboard and local editors must remain rapid-fire.
    if (/^(postAssignmentBtn|postPerformanceTaskBtn|createClassBtn|dashboardCreateClass|rosterAddStudentsBtn|bulkRemoveStudentsBtn|bulkDeleteStudentsBtn|bulkResetPasswordsBtn|importAssignmentExcelBtn|importStudentsFileBtn)$/i.test(btn.id)) return false;
    if (/keyboard|clear filters|clear search|add question|add row|show password|hide password|choose file|toggle/i.test(descriptor)) return false;
    return knownRemoteAction.test(descriptor);
  }

  function candidateFor(btn) {
    const old = buttons.get(btn);
    if (old && !old.finished) return old;
    const action = {
      id: ++nextId, button: btn, form: null, startedAt: Date.now(),
      seen: false, inFlight: 0, finished: false, visual: false,
      timer: null, noRequestTimer: null, label: actionLabel(btn),
      originalDisabled: btn.disabled, originalAriaBusy: btn.getAttribute('aria-busy'),
      originalAriaDisabled: btn.getAttribute('aria-disabled'),
      originalAriaLabel: btn.getAttribute('aria-label'),
      originalMinWidth: btn.style?.minWidth ?? '', originalValue: btn.value,
      inputButton: btn.matches('input[type="submit"],input[type="button"]')
    };
    buttons.set(btn, action);
    active.add(action);
    latest = action;
    if (likelyRemote(btn)) lock(action, false);
    action.noRequestTimer = setTimeout(() => {
      if (!action.finished && !action.seen) finish(action);
    }, noRequestDelay);
    return action;
  }

  function lock(action, visible) {
    const btn = action.button;
    if (action.finished || !btn?.isConnected) { finish(action); return; }
    // Existing MathsideActionButton has its own complete request lifecycle.
    if (btn.dataset.mathsideBusy === '1') { handoff(btn); return; }
    btn.dataset.mathsideAsyncLock = String(action.id);
    if (visible && !action.visual) {
      action.visual = true;
      const current = getComputedStyle(btn);
      btn.style.setProperty('--mathside-loader-color', current.color);
      if (!action.inputButton) {
        // Existing icons, child nodes and event listeners are left untouched.
        btn.dataset.mathsideLoadingLabel = action.label;
        const w = Math.ceil(btn.getBoundingClientRect().width);
        if (w > 0 && w < 88) btn.dataset.mathsideCompactLoading = '1';
        if (w > 0 && !btn.style.minWidth) btn.style.minWidth = `${w}px`;
      } else {
        btn.value = action.label;
      }
      btn.classList.add('mathside-network-busy');
      btn.setAttribute('aria-busy', 'true');
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-label', action.label);
      btn.disabled = true;
    }
  }

  function finish(action, keepManual = false) {
    if (!action || action.finished) return;
    action.finished = true;
    clearTimeout(action.timer);
    clearTimeout(action.noRequestTimer);
    active.delete(action);
    if (latest === action) latest = null;
    if (action.form && action.form._mathsideNetworkAction === action) {
      delete action.form._mathsideNetworkAction;
    }
    const btn = action.button;
    if (buttons.get(btn) === action) buttons.delete(btn);
    if (!btn) return;
    if (btn.dataset.mathsideAsyncLock === String(action.id)) delete btn.dataset.mathsideAsyncLock;
    btn.classList.remove('mathside-network-busy');
    btn.style?.removeProperty('--mathside-loader-color');
    if (!action.inputButton) {
      delete btn.dataset.mathsideLoadingLabel;
      delete btn.dataset.mathsideCompactLoading;
      if (btn.style) btn.style.minWidth = action.originalMinWidth;
    } else if (action.visual) {
      btn.value = action.originalValue;
    }
    // Do not interfere with first-party manually managed busy buttons.
    if (!keepManual && btn.dataset.mathsideBusy !== '1' && action.visual) {
      btn.disabled = action.originalDisabled;
      if (action.originalAriaBusy === null) btn.removeAttribute('aria-busy');
      else btn.setAttribute('aria-busy', action.originalAriaBusy);
      if (action.originalAriaDisabled === null) btn.removeAttribute('aria-disabled');
      else btn.setAttribute('aria-disabled', action.originalAriaDisabled);
      if (action.originalAriaLabel === null) btn.removeAttribute('aria-label');
      else btn.setAttribute('aria-label', action.originalAriaLabel);
    }
  }

  function handoff(button) {
    const action = buttons.get(button);
    if (!action || action.finished) return;
    // Return the control to its initial state before MathsideActionButton takes over.
    finish(action, false);
  }

  function beginRequest(url) {
    if (!isRemoteUrl(url)) return () => {};
    const action = latest;
    if (!action || action.finished ||
        (!action.seen && Date.now() - action.startedAt > 2500)) return () => {};
    if (action.button.dataset.mathsideBusy === '1') {
      handoff(action.button);
      return () => {};
    }
    clearTimeout(action.noRequestTimer);
    clearTimeout(action.timer);
    action.seen = true;
    action.inFlight++;
    lock(action, true);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      if (action.finished) return;
      action.inFlight = Math.max(0, action.inFlight - 1);
      if (action.inFlight === 0) action.timer = setTimeout(() => finish(action), idleDelay);
    };
  }

  function eventButton(event) {
    const el = event.target;
    const btn = el?.closest?.('button, input[type="submit"], input[type="button"]');
    return btn && !btn.matches('[data-mathside-no-loading]') ? btn : null;
  }

  document.addEventListener('click', event => {
    const btn = eventButton(event);
    if (!btn) return;
    const old = buttons.get(btn);
    if (old && !old.finished) {
      if (btn.dataset.mathsideAsyncLock === String(old.id)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // Purely local controls are not locked while waiting to see if they fetch.
      finish(old);
    }
    if (btn.disabled || btn.dataset.mathsideBusy === '1') return;
    candidateFor(btn);
  }, true);

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form._mathsideNetworkAction && !form._mathsideNetworkAction.finished) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    let btn = event.submitter;
    if (!btn) btn = form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
    if (!btn || btn.disabled && !buttons.has(btn)) return;
    const action = buttons.get(btn) && !buttons.get(btn).finished ? buttons.get(btn) : candidateFor(btn);
    action.form = form;
    form._mathsideNetworkAction = action;
  }, true);

  if (typeof window.fetch === 'function') {
    const baseFetch = window.fetch;
    window.fetch = function(...args) {
      const target = args[0]?.url ?? args[0];
      const complete = beginRequest(String(target));
      try {
        return Promise.resolve(baseFetch.apply(this, args)).finally(complete);
      } catch (error) {
        complete();
        throw error;
      }
    };
  }

  if (window.XMLHttpRequest) {
    const proto = XMLHttpRequest.prototype;
    const rawOpen = proto.open;
    const rawSend = proto.send;
    const xhrUrls = new WeakMap();
    proto.open = function(method, url, ...rest) {
      xhrUrls.set(this, String(url));
      return rawOpen.call(this, method, url, ...rest);
    };
    proto.send = function(...args) {
      const complete = beginRequest(xhrUrls.get(this) || '');
      this.addEventListener('loadend', complete, { once: true });
      try { return rawSend.apply(this, args); }
      catch (error) { complete(); throw error; }
    };
  }

  window.MathsideNetworkButtons = Object.freeze({ handoff });
})();
