import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
if (!existsSync(res)) throw new Error('Android project not yet generated; run npx cap add android first.');
for (const density of ['mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi']) {
  const dst = path.join(res, `mipmap-${density}`);
  mkdirSync(dst, { recursive: true });
  for (const icon of ['ic_launcher','ic_launcher_round','ic_launcher_foreground']) {
    const f = path.join(root, 'resources', 'android', `${icon}_${density}.png`);
    if (!existsSync(f)) throw new Error(`Missing Mathside app branding PNG: ${f}`);
    copyFileSync(f, path.join(dst, `${icon}.png`));
  }
}
const anydpi = path.join(res,'mipmap-anydpi-v26');
mkdirSync(anydpi,{ recursive:true });
const iconXml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/mathside_icon_bg"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>\n`;
writeFileSync(path.join(anydpi,'ic_launcher.xml'), iconXml);
writeFileSync(path.join(anydpi,'ic_launcher_round.xml'), iconXml);
const values = path.join(res,'values');
mkdirSync(values,{ recursive:true });
writeFileSync(path.join(values,'mathside_icon_colors.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="mathside_icon_bg">#FF7300</color></resources>\n`);
console.log('Mathside orange e^x Android app icon installed.');
