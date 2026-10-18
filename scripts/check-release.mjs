import { readFile, readdir, lstat, realpath, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Script } from 'node:vm';
import { generateDemo } from './generate-demo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const allowedFiles = new Set([
  '.gitattributes', '.gitignore', 'LICENSE', 'README.md', 'package.json',
  '.github/workflows/ci.yml',
  'docs/ARCHITECTURE.md', 'docs/PROVENANCE.md', 'docs/VERIFICATION.md',
  'extension-tracker/LICENSE', 'extension-tracker/PRIVACY.md',
  'extension-tracker/manifest.json', 'extension-tracker/account-store.mjs',
  'extension-tracker/model.mjs', 'extension-tracker/ai-input.mjs',
  'extension-tracker/conversation-state.mjs', 'extension-tracker/conversation-store.mjs',
  'extension-tracker/storage-client.mjs', 'extension-tracker/storage-port-server.mjs',
  'extension-tracker/public-runtime.mjs',
  'extension-tracker/encrypted-storage.mjs', 'extension-tracker/archive-key.mjs',
  'extension-tracker/service-worker.js', 'extension-tracker/popup.html',
  'extension-tracker/popup.js', 'extension-tracker/popup.css',
  'extension-tracker/debug-log.mjs', 'extension-tracker/debug-control.mjs',
  'extension-tracker/dev-debug-ui.js',
  'extension-tracker/analysis/conversation-origin.mjs',
  'extension-tracker/content/account.bundle.js', 'extension-tracker/content/bulk.bundle.js',
  'scripts/account-reader.mjs', 'scripts/build-extension.mjs', 'scripts/check-release.mjs',
  'scripts/extension-api-bulk.mjs', 'scripts/history-api-reader.mjs', 'scripts/generate-demo.mjs',
  'scripts/site-response.mjs',
  'scripts/generate-store-assets.py',
  'store/README.md', 'store/listing-zh-CN.md', 'store/privacy-disclosure.md',
  'store/reviewer-instructions.md', 'store/acceptance-0.8.11.json',
  'store/assets/icon.svg', 'store/assets/small-promo.png',
  'store/assets/screenshot-overview.png', 'store/assets/screenshot-no-changes.png',
  'scripts/prepare-public.mjs',
  'scripts/debug-bridge.mjs',
  'tests/account-store.test.mjs', 'tests/account-runtime.test.mjs',
  'tests/conversation-state.test.mjs', 'tests/conversation-store.test.mjs',
  'tests/storage-client.test.mjs', 'tests/storage-port-server.test.mjs',
  'tests/public-runtime.test.mjs',
  'tests/encrypted-storage.test.mjs', 'tests/archive-key.test.mjs',
  'tests/account-reader.test.mjs', 'tests/account-collector.test.mjs',
  'tests/api-incremental.test.mjs', 'tests/history-api-reader.test.mjs',
  'tests/ai-input.test.mjs', 'tests/demo.test.mjs',
  'tests/bundle-runtime.test.mjs',
  'tests/site-response.test.mjs', 'tests/collection-recovery.test.mjs', 'tests/run-recovery.test.mjs',
  'tests/verification-gate.test.mjs',
  'tests/minimal-runtime.test.mjs', 'tests/popup-performance.test.mjs', 'tests/request-pacing.test.mjs',
  'tests/debug-log.test.mjs', 'tests/debug-runtime.test.mjs',
  'tests/debug-control.test.mjs', 'tests/debug-bridge.test.mjs', 'tests/debug-ui.test.mjs',
  'examples/index.html',
]);
for (const size of [16, 32, 48, 128]) allowedFiles.add(`extension-tracker/icons/icon-${size}.png`);
for (const account of ['account-a', 'account-b']) {
  for (const file of ['state.json', 'runtime.json', 'runtime-no-change.json',
    'ai-export-all.json', 'ai-export-latest.json', 'ai-export-no-change.json']) {
    allowedFiles.add(`examples/demo-data/${account}/${file}`);
  }
}

export const publicExcludedFiles = new Set([
  'extension-tracker/debug-log.mjs', 'extension-tracker/debug-control.mjs',
  'extension-tracker/dev-debug-ui.js', 'scripts/debug-bridge.mjs',
  'tests/debug-log.test.mjs', 'tests/debug-runtime.test.mjs',
  'tests/debug-control.test.mjs', 'tests/debug-bridge.test.mjs', 'tests/debug-ui.test.mjs',
  'scripts/prepare-public.mjs',
]);
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const publicProfile = packageMetadata.showcaseProfile === 'public';
if (publicProfile) for (const file of publicExcludedFiles) allowedFiles.delete(file);

const sensitivePatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['credential-shaped token', /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/u],
  ['mobile number', /(?<!\d)1[3-9]\d{9}(?!\d)/u],
  ['personal Windows path', /[A-Z]:[\\/]Users[\\/](?!Public\b|Default\b|example\b)[\w.-]+/iu],
];

async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Git metadata is allowed only as metadata; it is never inspected or packaged.
    if (relative === '.git') continue;
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${relative}`);
    if (stat.isDirectory()) {
      if (!([...allowedFiles].some(file => file.startsWith(`${relative}/`)))) {
        throw new Error(`Unexpected directory: ${relative}`);
      }
      files.push(...await walk(absolute, relative));
    } else if (stat.isFile()) files.push(relative);
    else throw new Error(`Unsupported filesystem entry: ${relative}`);
  }
  return files.sort();
}

async function check() {
  const files = await walk(root);
  for (const file of files) {
    if (!allowedFiles.has(file)) throw new Error(`Unexpected file: ${file}`);
    const bytes = await readFile(path.join(root, file));
    if (file.endsWith('.png')) {
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error(`Invalid PNG asset: ${file}`);
      }
      const size = /icon-(\d+)\.png$/u.exec(file)?.[1];
      const expected = size ? [Number(size), Number(size)] :
        file.endsWith('small-promo.png') ? [440, 280] : [1280, 800];
      if (bytes.length < 24 || bytes.readUInt32BE(16) !== expected[0] || bytes.readUInt32BE(20) !== expected[1]) {
        throw new Error(`Unexpected image dimensions: ${file}`);
      }
      continue;
    }
    const contents = bytes.toString('utf8');
    for (const [category, pattern] of sensitivePatterns) {
      if (pattern.test(contents)) throw new Error(`Potential ${category}: ${file}`);
    }
    if (/\.(?:mjs|js)$/u.test(file) && !file.includes('/content/')) {
      // This generator emits module imports as strings; its real imports are
      // deliberately kept as one-line top-level declarations.
      const importSource = file === 'scripts/prepare-public.mjs'
        ? contents.split(/\r?\n/u).filter(line => line.startsWith('import ')).join('\n')
        : contents;
      for (const [, specifier] of importSource.matchAll(/\b(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
        if (specifier.startsWith('node:') && !file.startsWith('extension-tracker/')) continue;
        if (!specifier.startsWith('.')) throw new Error(`Unexpected external import: ${file}`);
        const imported = path.relative(root, path.resolve(root, path.dirname(file), specifier)).replaceAll(path.sep, '/');
        if (!allowedFiles.has(imported)) throw new Error(`Import outside source allowlist: ${file}`);
      }
    }
  }
  for (const file of allowedFiles) {
    if (!files.includes(file)) throw new Error(`Missing file: ${file}`);
  }
  for (const file of ['account.bundle.js', 'bulk.bundle.js']) {
    new Script(await readFile(path.join(root, 'extension-tracker/content', file), 'utf8'), { filename: file });
  }
  const preview = await readFile(path.join(root, 'examples/index.html'), 'utf8');
  for (const [, attributes, body] of preview.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)) {
    if (!attributes.includes('application/json')) new Script(body, { filename: 'examples/index.html inline script' });
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'extension-tracker/manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.license !== 'MIT' || manifest.version !== pkg.version) throw new Error('Version or MIT license metadata mismatch');
  for (const size of [16, 32, 48, 128]) {
    if (manifest.icons?.[size] !== `icons/icon-${size}.png`) throw new Error('Missing manifest icon');
  }
  for (const size of [16, 32, 48]) {
    if (manifest.action?.default_icon?.[size] !== `icons/icon-${size}.png`) throw new Error('Missing action icon');
  }
  const permissions = ['activeTab', 'scripting', 'storage', 'unlimitedStorage'];
  if (manifest.manifest_version !== 3 || manifest.permissions?.length !== permissions.length ||
      !permissions.every(permission => manifest.permissions.includes(permission)) ||
      manifest.host_permissions?.length ||
      (publicProfile ? Boolean(manifest.optional_host_permissions?.length) :
        (manifest.optional_host_permissions?.length !== 1 ||
         manifest.optional_host_permissions[0] !== 'http://127.0.0.1:17374/*'))) {
    throw new Error('Unexpected manifest permissions');
  }
  const tempParent = await realpath(os.tmpdir());
  const generated = await mkdtemp(path.join(tempParent, 'boss-showcase-check-'));
  try {
    await generateDemo(generated);
    for (const file of files.filter(file => file.startsWith('examples/'))) {
      const relative = file.slice('examples/'.length);
      if (await readFile(path.join(generated, relative), 'utf8') !== await readFile(path.join(root, file), 'utf8')) {
        throw new Error(`Demo output differs: ${file}; run npm run demo`);
      }
    }
  } finally {
    const resolved = await realpath(generated);
    if (path.dirname(resolved).toLowerCase() !== tempParent.toLowerCase() ||
        !path.basename(resolved).startsWith('boss-showcase-check-')) {
      throw new Error('Refusing to clean an unexpected temporary directory');
    }
    await rm(resolved, { recursive: true, force: true });
  }
  console.log(`Release checks passed: ${files.length} allowlisted files; deterministic demos; no matching credential patterns.`);
  console.log('This is a bounded local check, not a guarantee that all possible personal data has been detected.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  check().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
