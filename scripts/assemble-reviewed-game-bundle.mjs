import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGameBundle } from '../public/game-bundle.js';
import { preparePrivateFile, resolvePrivateFile } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = bytes => {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('INVALID_ASSET');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const assetRecord = async (id, relative, file) => {
  const bytes = await readFile(file); const dimensions = png(bytes);
  return { id, path: relative.replaceAll('\\', '/'), mediaType: 'image/png', bytes: bytes.length,
    sha256: sha(bytes), ...dimensions };
};

export async function assembleReviewedGameBundle({ stageBundleFile, baselineBundleFile, baselineAssetsDirectory,
  generatedAssetsDirectory, outputBundleFile, outputManifestFile }) {
  const stage = validateGameBundle(JSON.parse(await readFile(await resolvePrivateFile(path.resolve(root, stageBundleFile)), 'utf8')));
  const baseline = validateGameBundle(JSON.parse(await readFile(path.resolve(root, baselineBundleFile), 'utf8')));
  if (stage.schemaVersion !== 1 || baseline.schemaVersion !== 2
    || stage.config.cards.map(card => card.id).join('\n') !== baseline.config.cards.map(card => card.id).join('\n')) {
    throw new Error('INCOMPATIBLE_ASSET_BASELINE');
  }
  const sourceRoot = path.resolve(root, baselineAssetsDirectory);
  const assetRoot = await resolvePrivateFile(path.resolve(root, generatedAssetsDirectory));
  await mkdir(path.join(assetRoot, 'cards'), { recursive: true });
  for (const asset of baseline.assets) {
    const relative = asset.path.replace(/^assets\//, '');
    const source = path.join(sourceRoot, relative);
    const target = path.join(assetRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    try { await copyFile(source, target, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(source)) !== sha(await readFile(target))) throw error; }
  }
  const generated = [
    { id: 'board-forest-stone', source: path.join(assetRoot, 'hex-forest-stone.png'), relative: 'assets/board/forest-stone.png' },
    { id: 'founder-portrait', source: path.join(assetRoot, 'founder-portrait.png'), relative: 'assets/founder/portrait.png' },
  ];
  for (const item of generated) {
    const target = path.join(assetRoot, item.relative.replace(/^assets\//, ''));
    await mkdir(path.dirname(target), { recursive: true });
    try { await copyFile(item.source, target, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(item.source)) !== sha(await readFile(target))) throw error; }
    item.target = target;
  }
  const generatedRecords = await Promise.all(generated.map(item => assetRecord(item.id, item.relative, item.target)));
  const bundle = validateGameBundle({ schemaVersion: 3, config: stage.config, copy: stage.copy,
    art: { ...stage.art, cardImages: baseline.art.cardImages,
      boardImage: { assetId: generatedRecords[0].id }, heroImage: { assetId: generatedRecords[1].id } },
    assets: [...baseline.assets, ...generatedRecords],
    experience: { choiceMode: 'single-fixed', founderId: stage.config.heroes[0].id, rewardRule: 'first-seeded' } });
  const manifest = { schemaVersion: 1, gameVersion: bundle.config.gameVersion,
    assets: [...baseline.assets.map(asset => ({ ...asset, provenance: 'reviewed-baseline-imagegen-v20260902-r1' })),
      { ...generatedRecords[0], provenance: 'openai-built-in-imagegen-2026-09-03', use: 'seven-hex-board-tile' },
      { ...generatedRecords[1], provenance: 'openai-built-in-imagegen-2026-09-03', use: 'fixed-founder-presentation' }] };
  const bundleTarget = await preparePrivateFile(path.resolve(root, outputBundleFile));
  const manifestTarget = await preparePrivateFile(path.resolve(root, outputManifestFile));
  await writeFile(bundleTarget, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  await writeFile(manifestTarget, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { gameVersion: bundle.config.gameVersion, assets: bundle.assets.length, contentSha256: sha(await readFile(bundleTarget)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.split('=')));
  try {
    const result = await assembleReviewedGameBundle({ stageBundleFile: args['--stage-bundle'], baselineBundleFile: args['--baseline-bundle'],
      baselineAssetsDirectory: args['--baseline-assets'], generatedAssetsDirectory: args['--assets'],
      outputBundleFile: args['--output'], outputManifestFile: args['--manifest'] });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch { console.log('{"ok":false,"error":"BUNDLE_ASSEMBLY_FAILED"}'); process.exitCode = 1; }
}
