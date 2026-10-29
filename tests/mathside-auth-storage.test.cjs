const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('js/mathside-auth-storage.js', 'utf8');
function boot(native, persistent = new Map(), temp = new Map()) {
  const preferences = {
    get: async ({key})=>({value:persistent.has(key)?persistent.get(key):null}),
    set: async ({key,value})=>{persistent.set(key,value)},
    remove: async ({key})=>{persistent.delete(key)}
  };
  const window = {
    Capacitor: native ? {isNativePlatform:()=>true,Plugins:{Preferences:preferences}}:null,
    console:{warn:()=>{}},
    localStorage:{getItem:k=>temp.get(k)??null,setItem:(k,v)=>temp.set(k,v),removeItem:k=>temp.delete(k)}
  };
  vm.runInNewContext(code, {window});
  return {storage:window.MathsideAuthStorage.storage, isNative:window.MathsideAuthStorage.isNative, persistent,temp};
}
test('browser uses normal localStorage without native plugin',async()=>{
  const x=boot(false);
  assert.equal(x.isNative(),false);
  await x.storage.setItem('sb-project-auth-token','session-1');
  assert.equal(await x.storage.getItem('sb-project-auth-token'),'session-1');
  await x.storage.removeItem('sb-project-auth-token');
  assert.equal(await x.storage.getItem('sb-project-auth-token'),null);
});
test('Android keeps session after WebView localStorage reset and app restart',async()=>{
  const persistent=new Map();
  const first=boot(true,persistent,new Map());
  assert.equal(first.isNative(),true);
  await first.storage.setItem('sb-project-auth-token','session-1');
  const restarted=boot(true,persistent,new Map());
  assert.equal(await restarted.storage.getItem('sb-project-auth-token'),'session-1');
});
test('Android migrates existing WebView Supabase session',async()=>{
  const persistent=new Map();const temp=new Map([['sb-project-auth-token','legacy-session']]);
  const x=boot(true,persistent,temp);
  assert.equal(await x.storage.getItem('sb-project-auth-token'),'legacy-session');
  assert.equal(persistent.get('sb-project-auth-token'),'legacy-session');
});
test('explicit logout deletes native AND web session; will not auto login',async()=>{
  const persistent=new Map();const temp=new Map();
  const x=boot(true,persistent,temp);
  await x.storage.setItem('sb-project-auth-token','session-2');
  await x.storage.removeItem('sb-project-auth-token');
  const restarted=boot(true,persistent,temp);
  assert.equal(await restarted.storage.getItem('sb-project-auth-token'),null);
});
