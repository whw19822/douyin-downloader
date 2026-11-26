import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-electron');

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  await Promise.all([
    // Electron Main process (CommonJS for rock-solid Electron entry)
    build({
      entryPoints: [path.join(ROOT, 'electron', 'main.ts')],
      outfile: path.join(OUT_DIR, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      sourcemap: false,
      logLevel: 'info',
    }),

    // Electron Preload script (CommonJS sandbox-safe preload)
    build({
      entryPoints: [path.join(ROOT, 'electron', 'preload.ts')],
      outfile: path.join(OUT_DIR, 'preload.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      sourcemap: false,
      logLevel: 'info',
    }),

    // Embedded Express backend server (ESM, runtime deps externalized to node_modules)
    build({
      entryPoints: [path.join(ROOT, 'server.ts')],
      outfile: path.join(OUT_DIR, 'server.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external: ['express', 'cors', 'archiver', 'vite'],
      sourcemap: false,
      logLevel: 'info',
    }),
  ]);

  console.log('Electron main, preload, and embedded server compiled to dist-electron/');
}

main().catch((err) => {
  console.error('Failed to build Electron bundles:', err);
  process.exit(1);
});
