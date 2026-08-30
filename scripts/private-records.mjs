import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVATE_ROOT = fileURLToPath(new URL('../.local/', import.meta.url));
const invalid = () => Object.assign(new Error('INVALID_PRIVATE_FILE'), { workerCode: 'INVALID_PRIVATE_FILE' });
const within = (base, target) => {
  const relative = path.relative(base, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

export async function preparePrivateFile(file, { privateRoot = PRIVATE_ROOT } = {}) {
  const base = path.resolve(privateRoot);
  const target = path.resolve(file);
  if (target === base || !within(base, target)) throw invalid();
  await mkdir(base, { recursive: true });
  const canonicalBase = await realpath(base);
  // A redirected .local root must not turn private records into public assets.
  if (path.relative(base, canonicalBase) !== '') throw invalid();
  const parent = path.dirname(target);
  let ancestor = parent;
  while (true) {
    try {
      const actual = await realpath(ancestor);
      if (!within(canonicalBase, actual)) throw invalid();
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || ancestor === base) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await mkdir(parent, { recursive: true });
  if (!within(canonicalBase, await realpath(parent))) throw invalid();
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !within(canonicalBase, await realpath(target))) throw invalid();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

export async function resolvePrivateFile(file, { privateRoot = PRIVATE_ROOT } = {}) {
  const base = path.resolve(privateRoot);
  const canonicalBase = await realpath(base);
  if (path.relative(base, canonicalBase) !== '') throw invalid();
  const absolute = path.resolve(file);
  if (!within(base, absolute)) throw invalid();
  const target = await realpath(absolute);
  if (target === canonicalBase || !within(canonicalBase, target)) throw invalid();
  return target;
}
