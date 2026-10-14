import { build, context } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entryPoints = {
  'content/content': path.join(root, 'src/content/index.js'),
  background: path.join(root, 'src/background/service-worker.js'),
  'popup/popup': path.join(root, 'src/popup/popup.js'),
  'options/options': path.join(root, 'src/options/options.js'),
};

const staticFiles = [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/popup/popup.css', 'popup/popup.css'],
  ['src/options/options.html', 'options/options.html'],
  ['src/options/options.css', 'options/options.css'],
];

const options = {
  entryPoints,
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  platform: 'browser',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
};

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  for (const [src, dest] of staticFiles) {
    const from = path.join(root, src);
    const to = path.join(outdir, dest);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { force: true });
  }
}

async function writeMetafile(result) {
  if (!result.metafile) return;
  const metaPath = path.join(outdir, 'meta.json');
  await writeFile(metaPath, JSON.stringify(result.metafile));
}

async function assertManifestTargets() {
  const manifestPath = path.join(outdir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('dist/manifest.json missing after build');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const refs = [
    manifest.background && manifest.background.service_worker,
    ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
    manifest.action && manifest.action.default_popup,
    manifest.options_page,
    ...(manifest.action && manifest.action.default_icon
      ? Object.values(manifest.action.default_icon)
      : []),
  ].filter(Boolean);
  for (const ref of refs) {
    if (!existsSync(path.join(outdir, ref))) {
      throw new Error(`manifest references missing file: ${ref}`);
    }
  }
}

async function run() {
  await copyStatic();
  const result = await build({ ...options, write: true, metafile: true });
  await writeMetafile(result);
  await assertManifestTargets();
  console.log('build complete ->', path.relative(process.cwd(), outdir));
}

if (watch) {
  await copyStatic();
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'codesync-copy-static',
        setup(build0) {
          build0.onEnd(async (result) => {
            await copyStatic();
            if (!result.errors.length) {
              try {
                await writeMetafile({ metafile: result.metafile });
                await assertManifestTargets();
              } catch (err) {
                console.error(err.message);
              }
            }
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log('watching...');
} else {
  await run();
}
