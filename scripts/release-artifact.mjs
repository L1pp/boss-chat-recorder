import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';
const ARTIFACT_PREFIX = 'boss-chat-recorder-';
const REQUEST_TIMEOUT_MS = 30_000;

function redact(value, token) {
  const text = String(value ?? '');
  return token ? text.split(token).join('[REDACTED]') : text;
}

function runId(value, name) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive GitHub Actions run ID.`);
  }
  return value;
}

function sourceSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error('The package source commit must be a GitHub commit SHA.');
  }
  return value;
}

function extensionVersion(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/u.test(value) ||
      value.split('.').some(part => Number(part) > 65535) || !value.split('.').some(part => Number(part) > 0)) {
    throw new Error('The package must have a valid Chrome extension version.');
  }
  return value;
}

async function githubJson(path, { repository, token, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('GitHub Actions metadata request failed.');
  }
  if (!response.ok) throw new Error(`GitHub Actions metadata request failed (HTTP ${response.status}).`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('GitHub Actions metadata response was not readable JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub Actions metadata response must be an object.');
  }
  return payload;
}

async function existingPackage({ buildRunId, repository, token, fetchImpl, now }) {
  const id = runId(buildRunId, 'BUILD_RUN_ID');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/u.test(repository) ||
      ['.', '..'].includes(repository.split('/')[1])) {
    throw new Error('GITHUB_REPOSITORY must identify the current owner/repository.');
  }
  if (typeof token !== 'string' || !token.trim()) throw new Error('GH_TOKEN is required to select an existing package.');
  const api = { repository, token, fetchImpl };
  const run = await githubJson(`/actions/runs/${id}`, api);
  const sameRepository = value => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
  if (String(run.id) !== id || !sameRepository(run.repository?.full_name) ||
      !sameRepository(run.head_repository?.full_name) || run.event !== 'workflow_dispatch' ||
      run.head_branch !== 'main' || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('BUILD_RUN_ID must be a successful completed manual release run from this repository on main.');
  }
  const sha = sourceSha(run.head_sha);
  const workflow = await githubJson('/actions/workflows/release.yml', api);
  if (!Number.isSafeInteger(workflow.id) || workflow.id !== run.workflow_id || workflow.path !== RELEASE_WORKFLOW_PATH) {
    throw new Error(`BUILD_RUN_ID must come from ${RELEASE_WORKFLOW_PATH}.`);
  }

  const artifacts = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubJson(`/actions/runs/${id}/artifacts?per_page=100&page=${page}`, api);
    if (!Array.isArray(payload.artifacts) || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0) {
      throw new Error('GitHub Actions returned malformed artifact metadata.');
    }
    artifacts.push(...payload.artifacts);
    if (artifacts.length >= payload.total_count || payload.artifacts.length === 0) break;
  }
  const packages = artifacts.filter(artifact => typeof artifact?.name === 'string' &&
    /^boss-chat-recorder-\d+(?:\.\d+){0,3}$/u.test(artifact.name));
  if (packages.length !== 1) {
    throw new Error('The release run must contain exactly one boss-chat-recorder-<version> package artifact.');
  }
  const artifact = packages[0];
  const version = extensionVersion(artifact.name.slice(ARTIFACT_PREFIX.length));
  const expiresAt = Date.parse(artifact.expires_at);
  if (artifact.expired !== false || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error('The release package artifact is expired or has no valid expiry time.');
  }
  return { needsBuild: false, version, runId: id, sourceSha: sha, artifactName: artifact.name };
}

export async function selectReleaseArtifact({
  operation,
  buildRunId = '',
  repository,
  currentRunId,
  currentSha,
  currentVersion,
  ref,
  token,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  if (!['build', 'status', 'upload', 'publish'].includes(operation)) {
    throw new Error('RELEASE_OPERATION must be build, status, upload, or publish.');
  }
  if (operation === 'status') {
    return { needsBuild: false, version: '', runId: '', sourceSha: '', artifactName: '' };
  }
  if ((operation === 'upload' || operation === 'publish') && ref !== 'refs/heads/main') {
    throw new Error('Upload and publish must run from main. Use build for a branch preview.');
  }
  if (typeof buildRunId !== 'string') throw new Error('BUILD_RUN_ID must be a positive GitHub Actions run ID.');
  const selectedRunId = buildRunId.trim();
  if (selectedRunId) return existingPackage({ buildRunId: selectedRunId, repository, token, fetchImpl, now });
  const version = extensionVersion(currentVersion);
  return {
    needsBuild: true,
    version,
    runId: runId(currentRunId, 'GITHUB_RUN_ID'),
    sourceSha: sourceSha(currentSha),
    artifactName: `${ARTIFACT_PREFIX}${version}`,
  };
}

export async function runCli({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  appendFileImpl = appendFile,
  stdout = text => process.stdout.write(`${text}\n`),
} = {}) {
  const operation = env.RELEASE_OPERATION;
  const buildRunId = env.BUILD_RUN_ID ?? '';
  let currentVersion;
  if (operation !== 'status' && typeof buildRunId === 'string' && !buildRunId.trim()) {
    const manifest = JSON.parse(await readFileImpl(new URL('../extension-tracker/manifest.json', import.meta.url), 'utf8'));
    currentVersion = manifest.version;
  }
  const plan = await selectReleaseArtifact({
    operation,
    buildRunId,
    repository: env.GITHUB_REPOSITORY,
    currentRunId: env.GITHUB_RUN_ID,
    currentSha: env.GITHUB_SHA,
    currentVersion,
    ref: env.GITHUB_REF,
    token: env.GH_TOKEN,
    fetchImpl,
  });
  if (env.GITHUB_OUTPUT) {
    await appendFileImpl(env.GITHUB_OUTPUT, [
      `needs_build=${plan.needsBuild}`,
      `version=${plan.version}`,
      `run_id=${plan.runId}`,
      `source_sha=${plan.sourceSha}`,
      `artifact_name=${plan.artifactName}`,
      '',
    ].join('\n'), 'utf8');
  }
  if (operation === 'build' && !plan.needsBuild && env.GITHUB_STEP_SUMMARY) {
    await appendFileImpl(env.GITHUB_STEP_SUMMARY, [
      '## Selected existing tested package',
      '',
      'The build stage creates no new build artifact; it selects an existing tested ZIP.',
      `Download the original ZIP from [build run ${plan.runId}](https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${plan.runId}).`,
      `Selected artifact: ${plan.artifactName}; source commit: ${plan.sourceSha}.`,
      'If GitHub Release creation is enabled on main, its job uses this same original ZIP.',
      '',
    ].join('\n'), 'utf8');
  }
  stdout(redact(JSON.stringify(plan), env.GH_TOKEN));
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch(error => {
    process.stderr.write(`Release package selection failed: ${redact(error?.message ?? error, process.env.GH_TOKEN)}\n`);
    process.exitCode = 1;
  });
}
