#!/usr/bin/env node
// Build only the self-contained public API collector bundles and the extension
// license copy. No package manager, network, upstream checkout, or private data.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'extension-tracker', 'content');
const outputs = new Map([
  [resolve(outputDir, 'account.bundle.js'), 'account'],
  [resolve(outputDir, 'bulk.bundle.js'), 'bulk'],
  [resolve(root, 'extension-tracker', 'LICENSE'), 'license'],
]);
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check') || args.length > 1) {
  console.error(`Unknown build option. Usage: node scripts/build-extension.mjs [--check]`);
  process.exitCode = 2;
} else {
  const check = args[0] === '--check';
  const source = name => readFile(resolve(root, 'scripts', name), 'utf8');
  const stripExports = text => text.replace(/^export\s+(?=(?:async\s+)?(?:function|class)\b)/gmu, '');
  const stripSiteResponseImports = text => text.replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/site-response\.mjs['"];\s*\r?\n/gmu, '');
  const assertUniqueTopLevelDeclarations = modules => {
    const declarations = new Map();
    const declarationPattern = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gmu;
    for (const [moduleName, contents] of modules) {
      for (const [, name] of contents.matchAll(declarationPattern)) {
        const previous = declarations.get(name);
        if (previous) throw new Error(`Duplicate bundle declaration "${name}" in ${previous} and ${moduleName}.`);
        declarations.set(name, moduleName);
      }
    }
  };
  const accountRuntime = `\nglobalThis.__bossBeforeSiteRequest = ({ endpoint, signal }) => waitForRequestSlot({
  endpoint, signal,
  requestSlot: message => {
    const runtime = globalThis.chrome?.runtime;
    if (typeof runtime?.sendMessage !== 'function') {
      throw new SiteResponseError('SITE_REQUEST_SCHEDULER_UNAVAILABLE', '本地请求限速器不可用，采集已停止。', { endpoint });
    }
    return runtime.sendMessage(message);
  },
});
const __bossAccountReaderRevision = 'site-response-paced-v5';
const __bossAccountReaderRuntime = globalThis.__bossAccountReaderRuntime;
const __bossAccountReaderInstance = __bossAccountReaderRuntime?.revision === __bossAccountReaderRevision
  ? __bossAccountReaderRuntime.reader : createAccountReader();
globalThis.__bossAccountReaderRuntime = { revision: __bossAccountReaderRevision, reader: __bossAccountReaderInstance };
globalThis.__bossAccountReader = Object.freeze({ read: options => __bossAccountReaderInstance.read(options) });
`;
  const bulkRuntime = `${accountRuntime}
globalThis.__bossStartCollection = ({ accountUid, collectionToken, previous, storedContacts } = {}) => {
  const runtime = globalThis.chrome?.runtime;
  const collector = createApiBulkCollector({
    accountUid, collectionToken, previous, storedContacts,
    readHistory: options => readAvailableConversationHistory(options),
    send: createStorageMessenger(runtime),
  });
  globalThis.__bossBulkCollector = collector;
  return collector.start(previous);
};
`;
  const build = async () => {
    const [siteResponse, account, history, bulk, storageClient, license] = await Promise.all([
      source('site-response.mjs'), source('account-reader.mjs'), source('history-api-reader.mjs'),
      source('extension-api-bulk.mjs'), readFile(resolve(root, 'extension-tracker/storage-client.mjs'), 'utf8'),
      readFile(resolve(root, 'LICENSE'), 'utf8'),
    ]);
    const responseBody = stripExports(siteResponse);
    const accountBody = stripExports(stripSiteResponseImports(account));
    const historyBody = stripExports(stripSiteResponseImports(history));
    const bulkBody = stripExports(stripSiteResponseImports(bulk));
    const storageBody = stripExports(storageClient);
    assertUniqueTopLevelDeclarations([
      ['site-response.mjs', responseBody], ['account-reader.mjs', accountBody],
      ['history-api-reader.mjs', historyBody], ['extension-api-bulk.mjs', bulkBody],
      ['storage-client.mjs', storageBody],
    ]);
    const bundles = new Map([
      [resolve(outputDir, 'account.bundle.js'), `(() => {\n${responseBody}\n${accountBody}${accountRuntime}\n})();\n`],
      [resolve(outputDir, 'bulk.bundle.js'), `(() => {\n${responseBody}\n${accountBody}\n${historyBody}\n${storageBody}\n${bulkBody}${bulkRuntime}\n})();\n`],
      [resolve(root, 'extension-tracker', 'LICENSE'), license],
    ]);
    return bundles;
  };

  try {
    const bundles = await build();
    if (check) {
      const mismatches = [];
      for (const [path, expected] of bundles) {
        let actual;
        try { actual = await readFile(path, 'utf8'); }
        catch { mismatches.push(path); continue; }
        if (actual !== expected) mismatches.push(path);
      }
      if (mismatches.length) {
        console.error(`Generated files are missing or out of date:\n${mismatches.map(path => `- ${path}`).join('\n')}`);
        process.exitCode = 1;
      } else console.log('Showcase extension bundles and license copy are current.');
    } else {
      await mkdir(outputDir, { recursive: true });
      for (const [path, contents] of bundles) await writeFile(path, contents, 'utf8');
      console.log('Built showcase extension bundles and copied the MIT license.');
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

