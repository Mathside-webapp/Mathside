import { existsSync, readFileSync, rmSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'www');
if (!existsSync(path.join(root, 'index.html'))) {
  throw new Error('Missing index.html at repository root. Upload the entire Mathside folder.');
}
rmSync(web, { recursive: true, force: true });
mkdirSync(web, { recursive: true });
cpSync(path.join(root, 'index.html'), path.join(web, 'index.html'));
for (const folder of ['js','css','assets','downloads']) {
  if (!existsSync(path.join(root, folder))) throw new Error(`Missing Mathside source folder: ${folder}`);
  cpSync(path.join(root, folder), path.join(web, folder), { recursive: true });
}

// Two supported configuration methods:
// 1. copy your working, frontend-safe js/config.js into the project
// 2. add the URL and publishable key as GitHub Actions repository secrets.
// Never embed a service_role key or R2 secret in this file.
const url = (process.env.MATHSIDE_SUPABASE_URL || '').trim();
const key = (process.env.MATHSIDE_SUPABASE_PUBLISHABLE_KEY || '').trim();
if (url || key) {
  if (!url || !key) throw new Error('Set BOTH MATHSIDE_SUPABASE_URL and MATHSIDE_SUPABASE_PUBLISHABLE_KEY.');
  if (!/^https:\/\/[^\s]+\.supabase\.co\/?$/.test(url)) {
    throw new Error('MATHSIDE_SUPABASE_URL must be a valid https://*.supabase.co URL.');
  }
  writeFileSync(path.join(web, 'js', 'config.js'),
    `window.MATHSIDE_CONFIG = ${JSON.stringify({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key }, null, 2)};\n`);
  console.log('Using Supabase publishable configuration from GitHub Actions secrets.');
} else {
  const configPath = path.join(root, 'js', 'config.js');
  if (!existsSync(configPath)) throw new Error('Missing js/config.js: restore the working public frontend configuration.');
  const config = readFileSync(configPath, 'utf8');
  const missing = /SUPABASE_URL\s*:\s*['\"]\s*['\"]/.test(config) ||
     /SUPABASE_PUBLISHABLE_KEY\s*:\s*['\"]\s*['\"]/.test(config) ||
     /YOUR_SUPABASE_PROJECT_URL|YOUR_SUPABASE_PUBLISHABLE_KEY/.test(config);
  if (missing) {
    const message = 'Supabase configuration is blank. Copy your working frontend-safe js/config.js OR configure both GitHub Actions secrets (MATHSIDE_SUPABASE_URL and MATHSIDE_SUPABASE_PUBLISHABLE_KEY).';
    if (process.env.CI === 'true') throw new Error(message);
    console.warn('WARNING: '+message);
  } else {
    console.log('Using existing js/config.js frontend configuration.');
  }
}
for (const required of ['js/network-button-states.js','css/network-button-states.css','js/r2-storage.js','js/v10-features.js','js/v15-performance-tasks.js']) {
  if (!existsSync(path.join(web,required))) throw new Error(`Missing required website file: ${required}`);
}
console.log('Mathside web bundle ready in www/. (Includes Cloudflare R2 and loading buttons.)');
