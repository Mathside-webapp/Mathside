const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync('js/mathside-push.js','utf8');
function instance(native=true, granted=true) {
  const handlers = {};
  const calls = [];
  const plugin = {
    addListener: async (event, fn) => { handlers[event]=fn; },
    checkPermissions: async () => ({receive:granted?'granted':'prompt'}),
    requestPermissions: async () => ({receive:granted?'granted':'denied'}),
    register: async () => { calls.push('register'); handlers.registration({value:'push-device-token-000000000000'}); }
  };
  const window = {
    console: { warn:()=>{} },
    Capacitor: native ? { isNativePlatform:()=>true, getPlatform:()=> 'android', Plugins:{PushNotifications:plugin}} : undefined,
    document: { documentElement:{classList:{add:()=>{}}}, querySelectorAll:()=>[], getElementById:()=>null },
    setTimeout:()=>{}
  };
  vm.runInNewContext(code, {window});
  return {push:window.MathsidePush, calls, handlers};
}

const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('browser stays unchanged and never registers', async () => {
  const {push,calls}=instance(false);
  const db={rpc: async()=>{throw Error('Never call Supabase')}};
  assert.equal(await push.signIn(db,'user-1'),false);
  assert.deepEqual(calls,[]);
});
test('Android registration saves token only for logged-in user and disables on sign-out', async () => {
  const {push,calls}=instance();
  const records=[];
  const db={rpc:async (fn,args)=>{ records.push({fn,args});return {error:null};}};
  assert.equal(await push.signIn(db,'user-1'),true);
  await tick();
  assert.equal(calls[0],'register');
  assert.equal(records[0].fn,'mathside_register_push_device');
  assert.equal(records[0].args.p_platform,'android');
  await push.signOut();
  assert.equal(records.at(-1).fn,'mathside_unregister_push_device');
  assert.equal(records.at(-1).args.p_token,records[0].args.p_token);
});
test('denied permission prevents registration without interrupting login', async () => {
  const {push,calls}=instance(true,false);
  assert.equal(await push.signIn({rpc:async()=>({error:null})},'user-1'),false);
  assert.deepEqual(calls,[]);
  assert.equal(push.permissionDenied(),true);
});
