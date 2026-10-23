import { mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../coverage/', import.meta.url), { recursive: true });
const files = (await readdir(new URL('../tests/', import.meta.url)))
  .filter(file => file.endsWith('.test.mjs')).sort().map(file => `tests/${file}`);
const child = spawn(process.execPath, [
  '--test', '--experimental-test-coverage',
  '--test-coverage-include=extension-tracker/**',
  '--test-coverage-include=scripts/**',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info',
  ...files,
], { cwd: root, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
