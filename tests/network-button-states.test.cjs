const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('js/network-button-states.js','utf8');
const delay = ms => new Promise(r=>setTimeout(r,ms));

function setup(fetchBehavior = () => Promise.resolve({ ok: true })) {
  const listeners = new Map();
  const document = {
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  class HTMLFormElement {}
  function button(opts={}) {
    const classes = new Set();
    const attributes = new Map();
    const properties = new Map();
    const result = {
      id: opts.id || '', value: opts.value || '', textContent: opts.text || 'Save',
      name: '', disabled: false, dataset: {}, isConnected: true,
      form: null, style: {
        minWidth:'', setProperty(k,v){properties.set(k,v);},
        removeProperty(k){properties.delete(k);} },
      classList: {add(k){classes.add(k)}, remove(...ks){ks.forEach(k=>classes.delete(k))},contains(k){return classes.has(k)}},
      getAttribute(k){return attributes.has(k) ? attributes.get(k) : null;},
      setAttribute(k,v){attributes.set(k,String(v));},
      removeAttribute(k){attributes.delete(k);},
      matches(s){return s.includes('input') ? !!opts.input : false;},
      closest(){return this;},
      getBoundingClientRect(){return {width:110};}
    };
    return result;
  }
  const window = {
    fetch: async (...args)=>fetchBehavior(...args),
    XMLHttpRequest: null
  };
  const context={window,document,HTMLFormElement,URL,location:{href:'http://127.0.0.1:5500'},
    getComputedStyle(){return{color:'rgb(255, 255, 255)'};},setTimeout,clearTimeout,console,Date};
  vm.runInNewContext(code,context);
  function click(button) {
    const event={target:button,blocked:false,
      preventDefault(){this.blocked=true}, stopImmediatePropagation(){this.blocked=true}};
    listeners.get('click')(event);
    return event;
  }
  function submit(form, btn) {
    const event={target:form,submitter:btn,blocked:false,
      preventDefault(){this.blocked=true}, stopImmediatePropagation(){this.blocked=true}};
    listeners.get('submit')(event);
    return event;
  }
  return {window,button,click,submit,HTMLFormElement};
}

test('click action gets label, blocks duplicate, restores after request success', async()=>{
  let done;
  const pending = new Promise(resolve=>{done=resolve;});
  const {window, button, click} = setup(()=>pending);
  const btn=button({id:'authSubmit',text:'Log in'});
  assert.equal(click(btn).blocked,false);
  const req=window.fetch('https://demo.supabase.co/auth/v1/token');
  assert.equal(btn.dataset.mathsideLoadingLabel,'Logging in…');
  assert.equal(btn.disabled,true);
  assert.equal(btn.getAttribute('aria-busy'),'true');
  assert.equal(click(btn).blocked,true);
  done({ok:true}); await req; await delay(950);
  assert.equal(btn.disabled,false);
  assert.equal(btn.dataset.mathsideLoadingLabel,undefined);
  assert.equal(btn.getAttribute('aria-busy'),null);
  assert.equal(click(btn).blocked,false);
});

test('failed network request releases button and preserves original markup', async()=>{
  const {window,button,click} = setup(()=>Promise.reject(Error('offline')));
  const btn=button({id:'saveGrade',text:'Save grade'});
  click(btn);
  await assert.rejects(window.fetch('https://demo.supabase.co/rest/v1/mathside_submissions'));
  await delay(950);
  assert.equal(btn.disabled,false);
  assert.equal(btn.textContent,'Save grade');
});

test('form submit locks Enter-key duplicate while a Supabase action runs', async()=>{
  let complete;
  const pending = new Promise(resolve=>{complete=resolve});
  const {window,button,submit,HTMLFormElement} = setup(()=>pending);
  const btn=button({text:'Submit assignment'});
  const form = new HTMLFormElement();
  form.querySelector=()=>btn;
  assert.equal(submit(form,btn).blocked,false);
  const req=window.fetch('https://demo.supabase.co/rest/v1/mathside_assignments');
  assert.equal(submit(form,btn).blocked,true);
  complete({ok:true}); await req; await delay(950);
  assert.equal(submit(form,btn).blocked,false);
});

test('existing action manager can take over from the network detector', async()=>{
  const {window,button,click} = setup();
  const btn=button({text:'Post performance task'});
  click(btn);
  window.MathsideNetworkButtons.handoff(btn);
  assert.equal(btn.dataset.mathsideAsyncLock,undefined);
  assert.equal(btn.disabled,false);
  assert.equal(btn.classList.contains('mathside-network-busy'),false);
});

test('local action is released without ever making a request', async()=>{
  const {button,click} = setup();
  const btn=button({text:'Settings'});
  click(btn);
  await delay(1500);
  assert.equal(click(btn).blocked,false);
});


test('repeated local keyboard clicks do not get blocked', async()=>{
  const {button,click} = setup();
  const btn=button({id:'mathKeyboardClearBtn',text:'Clear'});
  assert.equal(click(btn).blocked,false);
  assert.equal(click(btn).blocked,false);
  assert.equal(btn.disabled,false);
});
