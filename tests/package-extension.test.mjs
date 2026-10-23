import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { packageExtension, runtimeFiles } from '../scripts/package-extension.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const extensionRoot = path.join(repositoryRoot, 'extension-tracker');
const forbiddenRoots = new Set(['.github', 'data', 'docs', 'examples', 'scripts', 'tests']);
// Distribution contract kept independent from the ZIP writer's entry list.
const expectedRuntimeFiles = Object.freeze([
  'LICENSE',
  'PRIVACY.md',
  '_locales/en/messages.json',
  '_locales/zh_CN/messages.json',
  '_locales/zh_TW/messages.json',
  'account-store.mjs',
  'ai-input.mjs',
  'analysis/conversation-origin.mjs',
  'archive-key.mjs',
  'content/account.bundle.js',
  'content/bulk.bundle.js',
  'conversation-state.mjs',
  'conversation-store.mjs',
  'encrypted-storage.mjs',
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'i18n.mjs',
  'manifest.json',
  'model.mjs',
  'popup.css',
  'popup.html',
  'popup.js',
  'public-runtime.mjs',
  'service-worker.js',
  'storage-client.mjs',
  'storage-port-server.mjs',
]);

function parseStoredZip(bytes) {
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 0xffff - 22); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  assert.notEqual(endOffset, -1, 'ZIP end record exists');
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  assert.equal(endOffset + 22 + commentLength, bytes.length, 'ZIP end record reaches EOF');
  assert.equal(commentLength, 0, 'archive has no extra comment');

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  assert.equal(bytes.readUInt16LE(endOffset + 8), entryCount, 'single-disk entry counts agree');
  assert.equal(centralOffset + centralSize, endOffset, 'central directory bounds match');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, 'central directory entry signature');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(flags, 0x0800, 'UTF-8 filename flag is set');
    assert.equal(method, 0, 'extension files are stored without compression');
    assert.equal(compressedSize, uncompressedSize, 'stored file sizes agree');
    assert.equal(extraLength, 0);
    assert.equal(entryCommentLength, 0);

    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50, 'local file header signature');
    assert.equal(bytes.readUInt16LE(localOffset + 6), flags, 'local flags agree');
    assert.equal(bytes.readUInt16LE(localOffset + 8), method, 'local method agrees');
    assert.equal(bytes.readUInt32LE(localOffset + 14), checksum, 'local checksum field agrees');
    assert.equal(bytes.readUInt32LE(localOffset + 18), compressedSize, 'local compressed size agrees');
    assert.equal(bytes.readUInt32LE(localOffset + 22), uncompressedSize, 'local size agrees');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    assert.equal(localName, name, 'local and central paths agree');
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataOffset, dataOffset + compressedSize);
    assert.equal(data.length, uncompressedSize, 'file data is complete');
    entries.push({ name, data });

    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }
  assert.equal(cursor, centralOffset + centralSize, 'all central directory bytes are accounted for');
  return entries;
}

async function withTemporaryOutput(run) {
  const tempParent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(tempParent, 'boss-extension-package-test-'));
  try {
    await run(directory);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase());
    assert.match(path.basename(resolved), /^boss-extension-package-test-/u);
    await rm(resolved, { recursive: true, force: true });
  }
}

async function assertPackageContents(info) {
  const zipBytes = await readFile(info.path);
  assert.equal(info.bytes, zipBytes.length);
  const entries = parseStoredZip(zipBytes);
  assert.equal(info.fileCount, 28);
  assert.equal(entries.length, 28);
  assert.deepEqual(runtimeFiles, expectedRuntimeFiles, 'packaging list matches the reviewed public runtime scope');
  assert.deepEqual(entries.map(entry => entry.name), expectedRuntimeFiles, 'archive path list matches the public runtime scope');

  const names = new Set(entries.map(entry => entry.name));
  assert.equal(names.has('manifest.json'), true, 'manifest is at ZIP root');
  assert.equal(names.has('extension-tracker/manifest.json'), false, 'extension directory is not nested in ZIP');
  assert.equal(names.has('package.json'), false);
  const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data.toString('utf8'));
  assert.equal(manifest.default_locale, 'en');
  for (const locale of ['en', 'zh_CN', 'zh_TW']) {
    const messages = JSON.parse(entries.find(entry => entry.name === `_locales/${locale}/messages.json`).data.toString('utf8'));
    for (const field of ['name', 'description']) {
      const key = /^__MSG_(\w+)__$/u.exec(manifest[field])?.[1];
      assert.ok(key && messages[key]?.message, `${locale} resolves manifest ${field}`);
    }
  }
  for (const name of names) {
    assert.equal(name.startsWith('/') || name.includes('\\'), false, `archive path is relative: ${name}`);
    assert.equal(forbiddenRoots.has(name.split('/')[0]), false, `non-runtime project area is excluded: ${name}`);
    assert.equal(name.split('/').includes('debug'), false, `debug files are excluded: ${name}`);
    assert.equal(name.split('/').includes('data'), false, `local data is excluded: ${name}`);
    assert.equal(name.split('/').includes('tests'), false, `tests are excluded: ${name}`);
    const expected = await readFile(path.join(extensionRoot, ...name.split('/')));
    const actual = entries.find(entry => entry.name === name)?.data;
    assert.deepEqual(actual, expected, `archive payload matches public runtime file ${name}`);
  }
}

test('packageExtension creates a root-level ZIP containing only public runtime files', async () => {
  await withTemporaryOutput(async directory => {
    const output = path.join(directory, 'release.zip');
    const info = await packageExtension({ output });
    const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
    assert.equal(info.version, manifest.version);
    assert.equal(info.path, output);
    await assertPackageContents(info);
  });
});

test('CLI accepts --output and prints machine-readable package metadata', async () => {
  await withTemporaryOutput(async directory => {
    const output = path.join(directory, 'workflow.zip');
    const stdout = execFileSync(process.execPath, [
      path.join(repositoryRoot, 'scripts', 'package-extension.mjs'), '--output', output,
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    const info = JSON.parse(stdout);
    assert.equal(info.path, output);
    await assertPackageContents(info);
  });
});
