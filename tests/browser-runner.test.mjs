import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserEnvironment } from '../scripts/browser-tests.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('browser runner passes an explicit Playwright browser path through unchanged', () => {
  const environment = createBrowserEnvironment({
    CI: 'true',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
  });

  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright');
  assert.equal(environment.PLAYWRIGHT_SKIP_BROWSER_GC, '1');
  assert.equal(environment.CI, 'true');
});

test('browser runner keeps its repository-local browser path when no override is supplied', () => {
  const environment = createBrowserEnvironment({ CI: 'true' });

  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH,
    path.join(repositoryRoot, 'node_modules', '.cache', 'boss-browser'));
  assert.equal(environment.PLAYWRIGHT_SKIP_BROWSER_GC, '1');
});


test('CI and release images match the locked Playwright package', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const version = metadata.packages['node_modules/@playwright/test'].version;
  for (const name of ['ci', 'release']) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    const images = [...workflow.matchAll(/mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble/gu)];
    assert.equal(images.length, 1, `${name} has one pinned browser image`);
    assert.equal(images[0][1], version, `${name} uses the installed Playwright version`);
  }
});


test('PR CI keeps main-only pushes, unrestricted PRs, and preinstalled browser execution', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const events = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));
  assert.match(events, /push:\s*\n\s+branches: \[main\]/u);
  assert.ok(events.trimEnd().endsWith('pull_request:'), 'PR triggering has no branch/path restriction');
  const browser = workflow.slice(workflow.indexOf('  browser:'));
  assert.match(browser, /name: Chromium synthetic regression/u);
  assert.match(browser, /PLAYWRIGHT_BROWSERS_PATH: \/ms-playwright/u);
  assert.ok(browser.includes('run: npm ci --ignore-scripts'));
  assert.ok(browser.includes('run: npm run test:browser'));
  assert.ok(!browser.includes('test:browser:install'));
  assert.ok(!browser.includes('apt-get'));
});
