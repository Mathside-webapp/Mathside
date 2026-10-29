/* Called after 'npx cap add android', before 'npx cap sync android'. */
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'firebase', 'google-services.json');
const dest = path.join(root, 'android', 'app', 'google-services.json');
const capacitor = JSON.parse(readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
if (!existsSync(input)) throw new Error('Missing firebase/google-services.json; download from Firebase Console for this Android app.');
if (!existsSync(path.dirname(dest))) throw new Error('Android project missing: run npx cap add android first.');
const firebase = JSON.parse(readFileSync(input, 'utf8'));
const clients = (firebase.client || []).map(x => x?.client_info?.android_client_info?.package_name);
if (!clients.includes(capacitor.appId)) {
  throw new Error(`Firebase package mismatch: expected ${capacitor.appId}, found ${clients.join(', ')}`);
}
const appGradle = readFileSync(path.join(root,'android','app','build.gradle'), 'utf8');
const projectGradle = readFileSync(path.join(root,'android','build.gradle'), 'utf8');
if (!appGradle.includes('com.google.gms.google-services') || !projectGradle.includes('com.google.gms:google-services')) {
  throw new Error('Generated Capacitor Android template is missing the Firebase Google Services Gradle plugin; inspect the generated Gradle files.');
}
copyFileSync(input, dest);
console.log('Installed Firebase Android config for ' + capacitor.appId + ' into android/app/google-services.json');
