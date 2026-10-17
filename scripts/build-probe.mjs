import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['apps/probe-stdio.ts'], bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', minify: true,
  legalComments: 'linked', outfile: 'probe/stdio.cjs', metafile: true });
const packages = new Set(Object.keys(result.metafile.inputs)
  .filter(path => path.startsWith('node_modules/'))
  .map(path => { const parts = path.split('/'); return parts.slice(1, parts[1].startsWith('@') ? 3 : 2).join('/'); }));
let notices = 'Third-party licenses for the generated probe/stdio.cjs bundle.\nRegenerate with npm run build:probe; do not edit the bundle manually.\n';
for (const name of [...packages].sort()) {
  const root = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const files = (await readdir(root)).filter(file => /^(license|licence|copying)(\.|$)/i.test(file)).sort();
  if (!files.length) throw new Error(`No license found for ${name}`);
  notices += `\n=== ${name} ${pkg.version} (${pkg.license}) ===\n`;
  for (const file of files) notices += '\n' + await readFile(`${root}/${file}`, 'utf8') + '\n';
}
await writeFile('probe/THIRD_PARTY_NOTICES.txt', notices);
