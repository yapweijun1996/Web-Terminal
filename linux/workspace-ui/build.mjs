import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('./', import.meta.url);
const dist = new URL('dist/', root);

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('preact/package.json');
const preactRoot = dirname(manifestPath);
const { exports: preactExports } = JSON.parse(readFileSync(manifestPath, 'utf8'));
const browserEntries = ['.', './hooks', './jsx-runtime'];
// Source-only checkouts can omit the prebuilt distribution. Resolve all three
// modules to source together so the renderer, hooks, and JSX share one runtime.
const usePreactSource = browserEntries.some((entry) => !existsSync(resolve(preactRoot, preactExports[entry].browser)));
const alias = usePreactSource ? {
  preact: resolve(preactRoot, 'src/index.js'),
  'preact/hooks': resolve(preactRoot, 'hooks/src/index.js'),
  'preact/jsx-runtime': resolve(preactRoot, 'jsx-runtime/src/index.js'),
} : {};

await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/index.jsx'],
  outfile: 'dist/app.js',
  bundle: true,
  alias,
  minify: true,
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
});

await Promise.all([
  copyFile(new URL('index.html', root), new URL('index.html', dist)),
  copyFile(new URL('src/styles.css', root), new URL('styles.css', dist)),
]);
