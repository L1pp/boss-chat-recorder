import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runCli, selectReleaseArtifact } from '../scripts/release-artifact.mjs';

const repository = 'example/boss-chat-recorder';
const token = 'synthetic-github-token';
const builtSha = 'a'.repeat(40);
const controllerSha = 'b'.repeat(40);
const now = Date.parse('2026-10-23T12:00:00Z');
const selection = {
  operation: 'upload', buildRunId: '1234', repository, token,
  currentRunId: '9999', currentSha: controllerSha, currentVersion: '0.9.0',
  ref: 'refs/heads/main', now,
};
const originalRun = {
  id: 1234, workflow_id: 56, repository: { full_name: repository },
  head_repository: { full_name: repository }, head_branch: 'main', head_sha: builtSha,
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
};
const originalArtifact = {
  name: 'boss-chat-recorder-0.8.12', expired: false, expires_at: '2099-01-01T00:00:00Z',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function metadata({ run = {}, workflow = {}, artifacts = [originalArtifact], pages } = {}) {
  const requests = [];
  const artifactPages = pages || [artifacts];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    const prefix = `/repos/${repository}`;
    if (parsed.pathname === `${prefix}/actions/runs/1234`) return jsonResponse({ ...originalRun, ...run });
    if (parsed.pathname === `${prefix}/actions/workflows/release.yml`) {
      return jsonResponse({ id: 56, path: '.github/workflows/release.yml', ...workflow });
    }
    assert.equal(parsed.pathname, `${prefix}/actions/runs/1234/artifacts`);
    assert.equal(parsed.searchParams.get('per_page'), '100');
    const page = Number(parsed.searchParams.get('page'));
    return jsonResponse({
      total_count: artifactPages.reduce((count, entries) => count + entries.length, 0),
      artifacts: artifactPages[page - 1] || [],
    });
  };
  return { fetchImpl, requests };
}

test('empty build_run_id plans exactly one current build for build, upload, or publish without network access', async () => {
  for (const operation of ['build', 'upload', 'publish']) {
    const result = await selectReleaseArtifact({
      ...selection, operation, buildRunId: '', token: undefined,
      fetchImpl: async () => assert.fail('a new build must not request existing artifacts'),
    });
    assert.deepEqual(result, {
      needsBuild: true, version: '0.9.0', runId: '9999', sourceSha: controllerSha,
      artifactName: 'boss-chat-recorder-0.9.0',
    });
  }
});

test('status ignores package inputs and does not read a manifest or request artifact metadata', async () => {
  const result = await runCli({
    env: { RELEASE_OPERATION: 'status', BUILD_RUN_ID: 'not-a-run-id' },
    readFileImpl: async () => assert.fail('status must not read a package manifest'),
    fetchImpl: async () => assert.fail('status must not select or download a package'),
    stdout: () => {},
  });
  assert.deepEqual(result, { needsBuild: false, version: '', runId: '', sourceSha: '', artifactName: '' });
});

test('branch builds remain previews while upload and publish require main before any metadata request', async () => {
  const preview = await selectReleaseArtifact({ ...selection, operation: 'build', buildRunId: '', ref: 'refs/heads/preview' });
  assert.equal(preview.needsBuild, true);
  for (const operation of ['upload', 'publish']) {
    for (const buildRunId of ['', '1234']) {
      await assert.rejects(selectReleaseArtifact({
        ...selection, operation, buildRunId, ref: 'refs/heads/preview',
        fetchImpl: async () => assert.fail('branch writes must fail before network access'),
      }), /must run from main/);
    }
  }
});

test('reuses an existing successful manual main release artifact and its original source commit', async () => {
  for (const operation of ['build', 'upload', 'publish']) {
    const { fetchImpl, requests } = metadata({ artifacts: [{ name: 'release-browser-report' }, originalArtifact] });
    const result = await selectReleaseArtifact({ ...selection, operation, fetchImpl });
    assert.deepEqual(result, {
      needsBuild: false, version: '0.8.12', runId: '1234', sourceSha: builtSha,
      artifactName: 'boss-chat-recorder-0.8.12',
    });
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.init.method, 'GET');
      assert.equal(request.init.headers.Authorization, `Bearer ${token}`);
      assert.equal(request.init.redirect, 'error');
      assert.ok(request.init.signal instanceof AbortSignal);
      assert.equal(request.init.body, undefined);
      assert.doesNotMatch(request.url, /google|archive_download|\/zip/u);
    }
  }
});

test('rejects runs from CI, branches, forks, other repositories, or unsuccessful executions', async context => {
  const cases = [
    ['another run', { id: 5678 }],
    ['another repository', { repository: { full_name: 'someone/else' } }],
    ['a fork', { head_repository: { full_name: 'someone/fork' } }],
    ['pull request CI', { event: 'pull_request' }],
    ['push CI', { event: 'push' }],
    ['a branch', { head_branch: 'preview' }],
    ['a running job', { status: 'in_progress', conclusion: null }],
    ['a failed run', { conclusion: 'failure' }],
    ['a cancelled run', { conclusion: 'cancelled' }],
  ];
  for (const [name, run] of cases) {
    await context.test(name, async () => {
      const { fetchImpl, requests } = metadata({ run });
      await assert.rejects(selectReleaseArtifact({ ...selection, fetchImpl }), /successful completed manual release run/);
      assert.equal(requests.length, 1);
    });
  }
});

test('requires the release workflow identity and rejects malformed source commit metadata', async () => {
  for (const workflow of [{ id: 57 }, { id: '56' }, { path: '.github/workflows/ci.yml' }]) {
    const { fetchImpl, requests } = metadata({ workflow });
    await assert.rejects(selectReleaseArtifact({ ...selection, fetchImpl }), /must come from .github\/workflows\/release.yml/);
    assert.equal(requests.length, 2);
  }
  const { fetchImpl, requests } = metadata({ run: { head_sha: 'main\nartifact_name=other' } });
  await assert.rejects(selectReleaseArtifact({ ...selection, fetchImpl }), /commit SHA/);
  assert.equal(requests.length, 1);
});

test('rejects malformed run IDs and repository inputs before network access', async () => {
  const fetchImpl = async () => assert.fail('malformed inputs must fail before a request');
  for (const buildRunId of ['0', '-1', '1e3', '1234/other', '12\nversion=99', '9007199254740992', 1234]) {
    await assert.rejects(selectReleaseArtifact({ ...selection, buildRunId, fetchImpl }), /positive GitHub Actions run ID/);
  }
  for (const invalidRepository of ['example/repo/other', '../repo', 'example/..', 'https://github.com/example/repo']) {
    await assert.rejects(selectReleaseArtifact({ ...selection, repository: invalidRepository, fetchImpl }), /current owner\/repository/);
  }
  await assert.rejects(selectReleaseArtifact({ ...selection, token: '', fetchImpl }), /GH_TOKEN is required/);
  await assert.rejects(selectReleaseArtifact({ ...selection, operation: 'submit', fetchImpl }), /RELEASE_OPERATION/);
});

test('rejects missing, ambiguous, expired, and malformed official package artifacts', async context => {
  const cases = [
    ['missing package', [], /exactly one/],
    ['preview name', [{ ...originalArtifact, name: 'boss-chat-recorder-0.8.12-candidate' }], /exactly one/],
    ['ambiguous versions', [originalArtifact, { ...originalArtifact, name: 'boss-chat-recorder-0.8.13' }], /exactly one/],
    ['expired flag', [{ ...originalArtifact, expired: true }], /expired/],
    ['past expiry', [{ ...originalArtifact, expires_at: '2026-10-01T00:00:00Z' }], /expired/],
    ['missing expiry', [{ ...originalArtifact, expires_at: undefined }], /expiry/],
    ['invalid expiry', [{ ...originalArtifact, expires_at: 'later' }], /expiry/],
    ['invalid version', [{ ...originalArtifact, name: 'boss-chat-recorder-65536.1' }], /valid Chrome extension version/],
    ['noncanonical version', [{ ...originalArtifact, name: 'boss-chat-recorder-00.8.12' }], /valid Chrome extension version/],
  ];
  for (const [name, artifacts, pattern] of cases) {
    await context.test(name, async () => {
      const { fetchImpl } = metadata({ artifacts });
      await assert.rejects(selectReleaseArtifact({ ...selection, fetchImpl }), pattern);
    });
  }
});

test('reads artifact metadata pages without fetching ZIP contents', async () => {
  const reports = Array.from({ length: 100 }, (_, index) => ({ name: `browser-report-${index}` }));
  const { fetchImpl, requests } = metadata({ pages: [reports, [originalArtifact]] });
  const result = await selectReleaseArtifact({ ...selection, fetchImpl });
  assert.equal(result.artifactName, originalArtifact.name);
  assert.equal(requests.length, 4);
  assert.match(requests.at(-1).url, /artifacts\?per_page=100&page=2$/u);
});

test('metadata failures reveal no token or server response body', async () => {
  const fetchFailures = [
    async () => { throw new Error(`network failure echoed ${token}`); },
    async () => jsonResponse({ message: `server echoed ${token}` }, 403),
    async () => new Response(`not JSON ${token}`),
    async () => jsonResponse(null),
    async () => jsonResponse([]),
  ];
  for (const fetchImpl of fetchFailures) {
    await assert.rejects(selectReleaseArtifact({ ...selection, fetchImpl }), error => {
      assert.match(error.message, /GitHub Actions metadata/u);
      assert.ok(!error.message.includes(token));
      return true;
    });
  }
  const { fetchImpl } = metadata();
  await assert.rejects(selectReleaseArtifact({
    ...selection,
    fetchImpl: (url, init) => url.includes('/artifacts?') ? jsonResponse({ artifacts: null }) : fetchImpl(url, init),
  }), /malformed artifact metadata/);
});

test('CLI writes the new-build plan to GitHub outputs and reads only the checkout manifest', async () => {
  const writes = [];
  const lines = [];
  const result = await runCli({
    env: {
      RELEASE_OPERATION: 'build', BUILD_RUN_ID: '', GITHUB_RUN_ID: '9999', GITHUB_SHA: controllerSha,
      GITHUB_REF: 'refs/heads/main', GITHUB_OUTPUT: 'synthetic-output', GH_TOKEN: '0.9.0',
    },
    readFileImpl: async (url, encoding) => {
      assert.ok(url.pathname.endsWith('/extension-tracker/manifest.json'));
      assert.equal(encoding, 'utf8');
      return JSON.stringify({ version: '0.9.0' });
    },
    appendFileImpl: async (...args) => writes.push(args),
    fetchImpl: async () => assert.fail('a new build must not call GitHub'),
    stdout: line => lines.push(line),
  });
  assert.equal(result.needsBuild, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ['synthetic-output', [
    'needs_build=true', 'version=0.9.0', 'run_id=9999', `source_sha=${controllerSha}`,
    'artifact_name=boss-chat-recorder-0.9.0', '',
  ].join('\n'), 'utf8']);
  assert.ok(!lines.join('\n').includes('0.9.0'));
  assert.match(lines[0], /\[REDACTED\]/u);
});

test('CLI reuse does not read the current manifest and preserves the original run, version, and source SHA', async () => {
  const { fetchImpl } = metadata();
  const writes = [];
  const lines = [];
  const result = await runCli({
    env: {
      RELEASE_OPERATION: 'publish', BUILD_RUN_ID: '1234', GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: '9999', GITHUB_SHA: controllerSha, GITHUB_REF: 'refs/heads/main',
      GITHUB_OUTPUT: 'synthetic-output', GH_TOKEN: token,
    },
    fetchImpl,
    readFileImpl: async () => assert.fail('reuse must not read the controller checkout manifest'),
    appendFileImpl: async (_path, text) => writes.push(text),
    stdout: text => lines.push(text),
  });
  assert.equal(result.sourceSha, builtSha);
  assert.match(writes[0], /needs_build=false\nversion=0.8.12\nrun_id=1234\n/u);
  assert.ok(writes[0].includes(`source_sha=${builtSha}\n`));
  assert.ok(!writes[0].includes(controllerSha));
  assert.ok(!lines.join('\n').includes(token));
});

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

function jobBlock(name) {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `missing workflow job ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-z-]+:$/u.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function jobRuns(name, { operation = 'build', needsBuild = true, packageResult = 'success',
  prepareResult = 'success', storeResult = 'success', main = true, githubRelease = true, cancelled = false } = {}) {
  const block = jobBlock(name);
  const condition = block.slice(block.indexOf('    if:'), block.indexOf('    runs-on:'));
  const match = /\$\{\{([\s\S]*?)\}\}/u.exec(condition);
  assert.ok(match, `missing workflow condition ${name}`);
  const expression = match[1].replaceAll('needs.chrome-web-store', "needs['chrome-web-store']");
  const evaluate = new Function('inputs', 'needs', 'github', 'always', 'cancelled', `return Boolean(${expression});`);
  return evaluate(
    { operation, github_release: githubRelease },
    { prepare: { result: prepareResult, outputs: { needs_build: String(needsBuild) } },
      package: { result: packageResult }, 'chrome-web-store': { result: storeResult } },
    { ref: main ? 'refs/heads/main' : 'refs/heads/preview' }, () => true, () => cancelled,
  );
}

test('workflow job conditions support skipped package jobs while protecting store and Release writes', () => {
  const status = { operation: 'status', needsBuild: false, packageResult: 'skipped', prepareResult: 'skipped' };
  assert.equal(jobRuns('prepare', status), false);
  assert.equal(jobRuns('package', status), false);
  assert.equal(jobRuns('chrome-web-store', status), true);
  assert.equal(jobRuns('github-release', status), false);
  for (const operation of ['build', 'upload', 'publish']) {
    const reused = { operation, needsBuild: false, packageResult: 'skipped' };
    assert.equal(jobRuns('package', reused), false);
    assert.equal(jobRuns('chrome-web-store', reused), operation !== 'build');
    assert.equal(jobRuns('github-release', reused), true);
    assert.equal(jobRuns('github-release', { ...reused, githubRelease: false }), false);
    assert.equal(jobRuns('github-release', { ...reused, main: false }), false);
    assert.equal(jobRuns('chrome-web-store', { ...reused, main: false }), false);
  }
  assert.equal(jobRuns('package', { operation: 'build', main: false }), true);
  for (const failure of [
    { needsBuild: true, packageResult: 'failure' },
    { needsBuild: false, packageResult: 'skipped', prepareResult: 'failure' },
    { needsBuild: false, packageResult: 'skipped', cancelled: true },
  ]) {
    assert.equal(jobRuns('chrome-web-store', { operation: 'publish', ...failure }), false);
    assert.equal(jobRuns('github-release', { operation: 'publish', ...failure }), false);
  }
  assert.equal(jobRuns('github-release', { operation: 'publish', storeResult: 'failure' }), false);
  assert.match(jobBlock('chrome-web-store'), /always\(\) && !cancelled\(\)/u);
  assert.match(jobBlock('github-release'), /always\(\) && !cancelled\(\)/u);
});

test('workflow downloads one selected artifact before Google auth and publishes only after its successful upload', () => {
  const store = jobBlock('chrome-web-store');
  for (const block of [store, jobBlock('github-release')]) {
    assert.match(block, /name: \$\{\{ needs.prepare.outputs.artifact_name \}\}/u);
    assert.match(block, /run-id: \$\{\{ needs.prepare.outputs.run_id \}\}/u);
    assert.match(block, /github-token: \$\{\{ github.token \}\}/u);
    assert.match(block, /repository: \$\{\{ github.repository \}\}/u);
    assert.match(block, /actions: read/u);
  }
  assert.ok(store.indexOf('actions/download-artifact@v4') < store.indexOf('google-github-actions/auth@v3'));
  assert.ok(store.indexOf('chrome-webstore.mjs upload --zip') < store.indexOf('chrome-webstore.mjs publish'));
  assert.match(store, /inputs.operation == 'publish' && steps.upload.outcome == 'success'/u);
  assert.match(store, /chromewebstore.readonly/u);
  assert.match(store, /cancel-in-progress: false/u);
  const release = jobBlock('github-release');
  assert.match(release, /RELEASE_SOURCE_SHA: \$\{\{ needs.prepare.outputs.source_sha \}\}/u);
  assert.ok(release.includes('--target "$RELEASE_SOURCE_SHA"'));
  assert.ok(!release.includes('--target "$GITHUB_SHA"'));
  assert.ok(!release.includes('--clobber'));
});

test('new release builds keep all checks and use the preinstalled matching Playwright browser', () => {
  const packageJob = jobBlock('package');
  assert.match(packageJob, /container: mcr.microsoft.com\/playwright:v\d+\.\d+\.\d+-noble/u);
  assert.match(packageJob, /PLAYWRIGHT_BROWSERS_PATH: \/ms-playwright/u);
  for (const command of ['npm run build', 'npm ci --ignore-scripts', 'npm test', 'npm run check', 'npm run test:browser']) {
    assert.ok(packageJob.includes(`run: ${command}\n`));
  }
  assert.ok(!packageJob.includes('test:browser:install'));
  assert.ok(!packageJob.includes('apt-get'));
  assert.ok(packageJob.includes('node scripts/package-extension.mjs --output "$RUNNER_TEMP/boss-chat-recorder.zip"'));
  assert.match(packageJob, /name: release-browser-report/u);
});
