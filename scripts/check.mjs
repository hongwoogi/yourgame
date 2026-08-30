import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
if (!html.includes('lang="ko"') || !html.includes('app.js') || !html.includes('styles.css')) {
  throw new Error('The Korean entry page and its assets must be present.');
}
for (const asset of ['app.js', 'styles.css', 'admin.js', 'admin.css']) {
  if (!(await readFile(path.join(root, 'public', asset), 'utf8')).trim()) {
    throw new Error(`Required browser asset is empty: ${asset}`);
  }
}
const adminHtml = await readFile(path.join(root, 'server', 'admin-page.html'), 'utf8');
if (!adminHtml.includes('lang="ko"') || !adminHtml.includes('/admin.js') || !adminHtml.includes('/admin.css')) {
  throw new Error('The protected administrator page and its assets must be present.');
}
if ((await readdir(path.join(root, 'public'))).some(name => /^admin(?:-page)?\.html$/i.test(name))) {
  throw new Error('Administrator HTML must not be deployed as a public static file.');
}
console.log(`Checked ${sourceFiles.length} JavaScript files and deployment configuration.`);
if (process.argv.includes('--test')) {
  const tests = (await readdir(path.join(root, 'tests')))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(root, 'tests', name));
  if (!tests.length) throw new Error('Deployment requires the server and health tests.');
  const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
