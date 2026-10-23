#!/usr/bin/env node
// Package the public extension runtime only. Build generated bundles first with
// `npm run build`; this script never walks or copies the source repository.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Keep this runtime list explicit: each file is installed by Chrome, and no
// source, test, demo, documentation, or local-data directory is considered.
export const runtimeFiles = Object.freeze([
  'LICENSE',
  'PRIVACY.md',
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

const ZIP_LIMIT = 0xffffffff;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DOS_DATE = 0x0021; // 1980-01-01; stable output metadata.

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

// CRC32 is the required integrity field in the ZIP file format. It is not used
// to compare, identify, or gate the package contents.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function checkedU32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP_LIMIT) {
    throw new Error(`${label} exceeds the ZIP32 limit`);
  }
  return value;
}

function buildZip(entries) {
  if (entries.length > 0xffff) throw new Error('Too many files for a ZIP32 archive');

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    if (!nameBytes.length || nameBytes.length > 0xffff) throw new Error(`Invalid ZIP path: ${name}`);
    const size = checkedU32(bytes.length, `File ${name}`);
    const checksum = crc32(bytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8); // STORE: no compression dependency.
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(ZIP_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, bytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(checkedU32(localOffset, 'Local file offset'), 42);
    centralParts.push(centralHeader, nameBytes);

    localOffset = checkedU32(localOffset + localHeader.length + nameBytes.length + size,
      'Local file data');
  }

  const centralOffset = checkedU32(localOffset, 'Central directory offset');
  const centralDirectory = Buffer.concat(centralParts);
  const centralSize = checkedU32(centralDirectory.length, 'Central directory');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function assertManifestReferencesArePackaged(manifest, includedFiles) {
  if (manifest?.manifest_version !== 3) throw new Error('Expected a Manifest V3 extension');
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(value => typeof value === 'string');
  for (const file of referenced) {
    if (!includedFiles.has(file)) throw new Error(`Manifest file is not packaged: ${file}`);
  }
}

async function readRuntimeFiles(root) {
  const extensionRoot = resolve(root, 'extension-tracker');
  const realExtensionRoot = await realpath(extensionRoot);
  const entries = [];

  for (const name of runtimeFiles) {
    const absolute = resolve(extensionRoot, name);
    const fileInfo = await lstat(absolute);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error(`Expected a regular runtime file: extension-tracker/${name}`);
    }
    const realFile = await realpath(absolute);
    const fromRoot = relative(realExtensionRoot, realFile);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) {
      throw new Error(`Runtime file resolves outside extension-tracker: ${name}`);
    }
    entries.push({ name, bytes: await readFile(realFile) });
  }
  return entries;
}

export async function packageExtension({ root = repositoryRoot, output } = {}) {
  const projectRoot = resolve(root);
  const [manifestText, packageText] = await Promise.all([
    readFile(join(projectRoot, 'extension-tracker', 'manifest.json'), 'utf8'),
    readFile(join(projectRoot, 'package.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const metadata = JSON.parse(packageText);
  if (typeof manifest.version !== 'string' || manifest.version !== metadata.version) {
    throw new Error('Extension manifest and package versions must match');
  }

  const includedFiles = new Set(runtimeFiles);
  assertManifestReferencesArePackaged(manifest, includedFiles);
  const entries = await readRuntimeFiles(projectRoot);
  const archive = buildZip(entries);
  const outputPath = resolve(output ?? join(projectRoot, 'dist', `boss-chat-recorder-${manifest.version}.zip`));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, archive);

  return {
    version: manifest.version,
    path: outputPath,
    fileCount: entries.length,
    bytes: archive.length,
  };
}

function parseArgs(args) {
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Usage: node scripts/package-extension.mjs [--output <path>]');
      output = value;
      index += 1;
    } else if (argument.startsWith('--output=')) {
      output = argument.slice('--output='.length);
      if (!output) throw new Error('Usage: node scripts/package-extension.mjs [--output <path>]');
    } else {
      throw new Error('Usage: node scripts/package-extension.mjs [--output <path>]');
    }
  }
  return { output };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await packageExtension(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
