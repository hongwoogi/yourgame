import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkGameArchive, checkArchiveRetention } from './game-archive.mjs';
import { publishedGames } from '../server/published-games.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFiles = [];
async function collect(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(relative);
    else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) sourceFiles.push(relative);
  }
}
for (const directory of ['api', 'server', 'public', 'scripts']) await collect(directory);
for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
    process.exit(1);
  }
}
for (const file of ['package.json', 'vercel.json']) JSON.parse(await readFile(path.join(root, file), 'utf8'));
const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
if (!html.includes('lang="en"') || !html.includes('app.js') || !html.includes('styles.css') || !html.includes('data-language-select')) {
  throw new Error('The English-first entry page, language selector and assets must be present.');
}
for (const asset of ['app.js', 'styles.css', 'admin.js', 'admin.css', 'language-control.css', 'flags/en.svg', 'flags/ko.svg',
  'i18n.js', 'error-messages.js', 'public-messages.js', 'admin-messages.js', 'profile-policy.js', 'release-time.js']) {
  if (!(await readFile(path.join(root, 'public', asset), 'utf8')).trim()) {
    throw new Error(`Required browser asset is empty: ${asset}`);
  }
}
const adminHtml = await readFile(path.join(root, 'server', 'admin-page.html'), 'utf8');
if (!adminHtml.includes('lang="en"') || !adminHtml.includes('/admin.js') || !adminHtml.includes('/admin.css') || !adminHtml.includes('data-language-select')) {
  throw new Error('The English-first protected administrator page, language selector and assets must be present.');
}
if ((await readdir(path.join(root, 'public'))).some(name => /^(?:admin(?:-page)?|master)\.html$/i.test(name))) {
  throw new Error('Administrator HTML must not be deployed as a public static file.');
}
// Registering the real catalogs checks language-key and interpolation parity
// without a browser or network. Also catch misspelled static translation keys.
const { i18n } = await import('../public/i18n.js');
await import('../public/public-messages.js');
await import('../public/admin-messages.js');
for (const [file, source] of [['public/index.html', html], ['server/admin-page.html', adminHtml]]) {
  for (const match of source.matchAll(/\bdata-i18n(?:-(?:placeholder|aria-label|aria-description|title|content|alt))?="([^"]+)"/g)) {
    if (i18n.t(match[1]) === '[' + match[1] + ']') throw new Error(`Missing translation ${match[1]} in ${file}.`);
  }
}
const archive = await checkGameArchive({ registeredGames: publishedGames });
await checkArchiveRetention();
console.log(`Checked ${sourceFiles.length} JavaScript files, deployment configuration, and ${archive.archivedVersions} archived game versions.`);
if (process.argv.includes('--test')) {
  const tests = (await readdir(path.join(root, 'tests')))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(root, 'tests', name));
  if (!tests.length) throw new Error('Deployment requires the server and health tests.');
  // Concurrent native libsql test processes intermittently terminate with
  // 0xC0000005 on Windows even after their assertions pass. Serialize files on
  // that host; tests' own multi-client/process concurrency remains unchanged.
  const scheduling = process.platform === 'win32' ? ['--test-concurrency=1'] : [];
  const result = spawnSync(process.execPath, ['--test', ...scheduling, ...tests], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
