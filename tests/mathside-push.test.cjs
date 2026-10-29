const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync('js/mathside-push.js', 'utf8');
function instance(native = true, granted = true) {
  const handlers = {};
  const calls = [];
  const buttons = [
    { disabled: false, attributes: {}, callbacks: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; },
      addEventListener(key, cb) { this.callbacks[key] = cb; } }
  ];
  const plugin = {
    addListener: async (event, fn) => { handlers[event] = fn; },
    checkPermissions: async () => { calls.push('check'); return { receive: granted ? 'granted' : 'prompt' }; },
    requestPermissions: async () => { calls.push('request'); return { receive: granted ? 'granted' : 'denied' }; },
    register: async () => { calls.push('register'); await handlers.registration({ value: 'push-device-token-000000000000' }); }
  };
  const window = {
    console: { warn: () => {} },
    Capacitor: native ? { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { PushNotifications: plugin } } : undefined,
    document: { documentElement: { classList: { add: () => {} } }, querySelectorAll: () => buttons, getElementById: () => null },
    setTimeout: () => {}
  };
  vm.runInNewContext(code, { window });
  return { push: window.MathsidePush, calls, handlers, buttons };
}

test('browser stays unchanged and never registers', async () => {
  const {push, calls} = instance(false);
  const db = { rpc: async () => { throw Error('Never call Supabase'); } };
  assert.equal(await push.signIn(db, 'user-1'), false);
  assert.deepEqual(calls, []);
});
test('Android login MUST NOT show permission prompt or start Firebase', async () => {
  const {push, calls, buttons} = instance();
  assert.equal(await push.signIn({rpc:async()=>({error:null})}, 'user-1'), true);
  assert.deepEqual(calls, []);
  assert.equal(typeof buttons[0].callbacks.click, 'function');
});
test('explicit dashboard click registers token and explicit sign-out unregisters device', async () => {
  const {push, calls, buttons} = instance();
  const records=[];
  const db={rpc: async (fn,args)=>{records.push({fn,args}); return {error:null};}};
  await push.signIn(db,'user-1');
  await buttons[0].callbacks.click();
  assert.deepEqual(calls,['check','register']);
  assert.equal(records[0].fn,'mathside_register_push_device');
  assert.equal(records[0].args.p_platform,'android');
  assert.equal(buttons[0].disabled,false);
  await push.signOut();
  assert.equal(records.at(-1).fn,'mathside_unregister_push_device');
  assert.equal(records.at(-1).args.p_token,records[0].args.p_token);
});
test('permission denial never interrupts login, never registers', async () => {
  const {push,calls,buttons}=instance(true,false);
  assert.equal(await push.signIn({rpc:async()=>({error:null})},'user-1'),true);
  assert.deepEqual(calls,[]);
  await buttons[0].callbacks.click();
  assert.deepEqual(calls,['check','request']);
  assert.equal(push.permissionDenied(),true);
  assert.equal(buttons[0].disabled,false);
});
