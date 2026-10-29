const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const objId = 'a2345678-1234-4abc-8abc-123456789abc';
const userId = 'b2345678-1234-4abc-8abc-123456789abc';
const assignmentId = 'c2345678-1234-4abc-8abc-123456789abc';
const objectKey = `assignments/${assignmentId}/${userId}/${objId}.png`;
const path = `${userId}/${assignmentId}/r2-${objId}.png`;
const calls = [];
const fetched = [];
const context = {
  window: {}, Response,
  fetch: async (url, opts) => { fetched.push([url, opts]); return { ok: true }; },
};
vm.createContext(context);
vm.runInContext(readFileSync('js/r2-storage.js', 'utf8'), context);
const client = {
  functions: {
    invoke: async (name, args) => {
      calls.push([name, args.body]);
      if (name === 'r2-upload-url') return { data: { uploadUrl:'https://r2.example/test', objectKey } };
      if (args.body.action === 'confirm') return { data: { confirmed:true } };
      if (args.body.action === 'read') return { data: { url:'https://r2.example/download' } };
      throw Error('Wrong test path');
    }
  }
};
(async () => {
  const file = { name:'solution.png', type:'image/png', size:10 };
  const actual = await context.window.MathsideR2.uploadProof(client, { assignmentId, userId, file });
  assert.equal(actual, path);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0][1].method, 'PUT');
  assert.equal(fetched[0][1].headers['Content-Type'], 'image/png');
  assert.equal(calls[1][0], 'r2-files');
  assert.equal(calls[1][1].action, 'confirm');
  assert.equal(calls[1][1].proofPath, path);
  assert.equal(context.window.MathsideR2.isR2ProofPath(path), true);
  assert.equal(context.window.MathsideR2.isR2ProofPath(`${userId}/${assignmentId}/legacy.png`), false);
  assert.equal(await context.window.MathsideR2.signedProofUrl(client, path), 'https://r2.example/download');
  assert.equal(calls[2][1].action, 'read');
  console.log('PASS: upload -> R2 PUT -> metadata confirmation -> private download URL');
})().catch(err => { console.error(err); process.exitCode = 1; });
