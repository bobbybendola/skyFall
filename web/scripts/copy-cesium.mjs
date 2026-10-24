// Copies Cesium's static runtime files (web workers, assets, widget CSS) to
// public/cesium so Vite serves them at /cesium. Runs before dev and build.
// The copy is git-ignored.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(web, 'node_modules', 'cesium', 'Build', 'Cesium');
const dst = join(web, 'public', 'cesium');
if (!existsSync(src)) {
  console.error('cesium is not installed (run npm install in web/)');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const dir of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) {
  const from = join(src, dir);
  if (existsSync(from)) cpSync(from, join(dst, dir), { recursive: true });
}
console.log('cesium assets -> public/cesium');
