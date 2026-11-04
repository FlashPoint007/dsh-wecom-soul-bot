// Bundle src/client into dist/client.js in the DSH browser module format:
// a CommonJS body inside `window.__ModuleLoader__.load({ id, factory })`,
// the same shape DSH's own client packages ship. Modules the Web shell
// provides stay external and resolve through the factory's `require`.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const SHELL_MODULES = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'];

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  charset: 'utf8',
  legalComments: 'none',
  external: SHELL_MODULES,
  logLevel: 'warning',
});

const body = result.outputFiles[0].text
  .split('\n')
  .map(line => (line ? `\t\t${line}` : line))
  .join('\n');

const output = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`;

await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/client.js'), output);
console.log(`dist/client.js ${(Buffer.byteLength(output) / 1024).toFixed(1)} KiB`);
