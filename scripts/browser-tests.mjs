import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command, ...extra] = process.argv.slice(2);
if (!['install', 'test'].includes(command)) {
  console.error('Usage: node scripts/browser-tests.mjs install [--with-deps] | test [Playwright test options]');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [path.join(root, 'node_modules', 'playwright', 'cli.js'),
    ...(command === 'install' ? ['install', '--no-shell', ...extra, 'chromium'] : ['test', ...extra]),
  ], { cwd: root, stdio: 'inherit', env: { ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'node_modules', '.cache', 'boss-browser'),
    PLAYWRIGHT_SKIP_BROWSER_GC: '1',
  } });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
}
