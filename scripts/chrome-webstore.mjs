import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://chromewebstore.googleapis.com';
const UPLOAD_IN_PROGRESS_STATES = new Set([
  'IN_PROGRESS',
  'UPLOAD_IN_PROGRESS',
  'UPLOAD_STATE_UNSPECIFIED',
]);
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 120;
const REQUEST_TIMEOUT_MS = 120_000;

export class ChromeWebStoreApiError extends Error {
  constructor(message, { httpStatus, apiStatus } = {}) {
    super(message);
    this.name = 'ChromeWebStoreApiError';
    this.httpStatus = httpStatus;
    this.apiStatus = apiStatus;
  }
}

function redact(value, accessToken) {
  let safe = String(value ?? '');
  if (accessToken) safe = safe.split(accessToken).join('[REDACTED]');
  return safe.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
}

function requiredEnvValue(env, key) {
  const value = typeof env[key] === 'string' ? env[key].trim() : '';
  if (!value) throw new Error(`Missing required environment variable ${key}.`);
  return value;
}

function pathSegment(value, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must be a single safe Chrome Web Store ID.`);
  }
  return encodeURIComponent(value);
}

export function getChromeWebStoreConfig(env = process.env) {
  const publisherId = requiredEnvValue(env, 'CWS_PUBLISHER_ID');
  const extensionId = requiredEnvValue(env, 'CWS_EXTENSION_ID');
  const accessToken = requiredEnvValue(env, 'CWS_ACCESS_TOKEN');
  const publisherSegment = pathSegment(publisherId, 'CWS_PUBLISHER_ID');
  const extensionSegment = pathSegment(extensionId, 'CWS_EXTENSION_ID');
  const itemPath = `/publishers/${publisherSegment}/items/${extensionSegment}`;

  return {
    accessToken,
    itemPath,
    statusUrl: `${API_ORIGIN}/v2${itemPath}:fetchStatus`,
    uploadUrl: `${API_ORIGIN}/upload/v2${itemPath}:upload`,
    publishUrl: `${API_ORIGIN}/v2${itemPath}:publish`,
  };
}

async function responsePayload(response, accessToken) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new ChromeWebStoreApiError(
      redact(`Chrome Web Store API response body could not be read: ${error?.message ?? error}`, accessToken),
      { httpStatus: response.status },
    );
  }
  if (!text.trim()) {
    if (response.ok) {
      throw new ChromeWebStoreApiError(
        `Chrome Web Store API ${response.status} returned an empty response body.`,
        { httpStatus: response.status },
      );
    }
    return {};
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new ChromeWebStoreApiError(
        `Chrome Web Store API ${response.status} returned a non-JSON response body.`,
        { httpStatus: response.status },
      );
    }
    return { message: redact(text.slice(0, 1000), accessToken) };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    if (response.ok) {
      throw new ChromeWebStoreApiError(
        `Chrome Web Store API ${response.status} returned a JSON response that was not an object.`,
        { httpStatus: response.status },
      );
    }
    return { message: redact(text.slice(0, 1000), accessToken) };
  }
  return payload;
}

async function requestJson({ url, method, accessToken, fetchImpl, body, contentType }) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
  if (contentType) headers['Content-Type'] = contentType;

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    throw new ChromeWebStoreApiError(
      `Chrome Web Store API request failed: ${redact(error?.message ?? error, accessToken)}`,
    );
  }

  let payload;
  try {
    payload = await responsePayload(response, accessToken);
  } catch (error) {
    if (error instanceof ChromeWebStoreApiError) throw error;
    throw new ChromeWebStoreApiError(
      redact(`Chrome Web Store API ${response.status} response body could not be read: ${error?.message ?? error}`, accessToken),
      { httpStatus: response.status },
    );
  }
  if (!response.ok) {
    const apiError = payload?.error ?? payload;
    const message = typeof apiError?.message === 'string'
      ? apiError.message
      : `HTTP ${response.status} ${response.statusText || 'request failed'}`;
    const apiStatus = typeof apiError?.status === 'string' ? apiError.status : undefined;
    throw new ChromeWebStoreApiError(
      redact(`Chrome Web Store API ${response.status}${apiStatus ? ` ${apiStatus}` : ''}: ${message}`, accessToken),
      { httpStatus: response.status, apiStatus },
    );
  }
  return payload;
}

async function fetchStatusWithConfig(config, fetchImpl) {
  return requestJson({
    url: config.statusUrl,
    method: 'GET',
    accessToken: config.accessToken,
    fetchImpl,
  });
}

export async function fetchItemStatus({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getChromeWebStoreConfig(env);
  return fetchStatusWithConfig(config, fetchImpl);
}

function validatePollingOptions(pollIntervalMs, maxPollAttempts) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('pollIntervalMs must be a nonnegative safe integer.');
  }
  if (!Number.isSafeInteger(maxPollAttempts) || maxPollAttempts < 1) {
    throw new Error('maxPollAttempts must be a positive safe integer.');
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function uploadPackage({
  zipPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
} = {}) {
  if (typeof zipPath !== 'string' || !zipPath.trim()) {
    throw new Error('upload requires --zip <path>.');
  }
  validatePollingOptions(pollIntervalMs, maxPollAttempts);
  const config = getChromeWebStoreConfig(env);

  let zipBytes;
  try {
    zipBytes = await readFile(resolve(zipPath));
  } catch (error) {
    throw new Error(`Could not read ZIP package: ${redact(error?.message ?? error, config.accessToken)}`);
  }
  if (zipBytes.length === 0) throw new Error('ZIP package is empty.');

  const result = await requestJson({
    url: config.uploadUrl,
    method: 'POST',
    accessToken: config.accessToken,
    fetchImpl,
    body: zipBytes,
    contentType: 'application/zip',
  });

  const initialState = result?.uploadState;
  if (initialState === 'SUCCEEDED') return result;
  if (initialState === 'FAILED') throw new Error('Chrome Web Store reported that the ZIP upload failed.');
  if (!UPLOAD_IN_PROGRESS_STATES.has(initialState)) {
    throw new Error(`Chrome Web Store returned an unsupported uploadState: ${String(initialState ?? '(missing)')}.`);
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    await sleepImpl(pollIntervalMs);
    const status = await fetchStatusWithConfig(config, fetchImpl);
    const state = status?.lastAsyncUploadState;
    if (state === 'SUCCEEDED') return { ...result, uploadState: state, finalStatus: status };
    if (state === 'FAILED') throw new Error('Chrome Web Store reported that the asynchronous ZIP upload failed.');
    if (state === 'NOT_FOUND') throw new Error('Chrome Web Store could not find the asynchronous ZIP upload.');
    if (state !== undefined && !UPLOAD_IN_PROGRESS_STATES.has(state)) {
      throw new Error(`Chrome Web Store returned an unsupported lastAsyncUploadState: ${String(state)}.`);
    }
  }

  throw new Error(`Chrome Web Store ZIP upload is still in progress after ${maxPollAttempts} status checks.`);
}

export async function publishItem({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getChromeWebStoreConfig(env);
  return requestJson({
    url: config.publishUrl,
    method: 'POST',
    accessToken: config.accessToken,
    fetchImpl,
    contentType: 'application/json',
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  });
}

function parseCliArgs(argv) {
  const [command, ...args] = argv;
  if (!['status', 'upload', 'publish'].includes(command)) {
    throw new Error('Usage: node scripts/chrome-webstore.mjs status | upload --zip <path> | publish');
  }

  let zipPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--zip' || zipPath !== undefined || !args[index + 1]) {
      throw new Error('Usage: node scripts/chrome-webstore.mjs status | upload --zip <path> | publish');
    }
    zipPath = args[index + 1];
    index += 1;
  }
  if (command === 'upload' && zipPath === undefined) throw new Error('upload requires --zip <path>.');
  if (command !== 'upload' && zipPath !== undefined) throw new Error(`--zip is only valid with upload.`);
  return { command, zipPath };
}

export async function runCli(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = (text) => process.stdout.write(`${text}\n`),
} = {}) {
  const { command, zipPath } = parseCliArgs(argv);
  let result;
  if (command === 'status') result = await fetchItemStatus({ env, fetchImpl });
  else if (command === 'upload') result = await uploadPackage({ zipPath, env, fetchImpl });
  else result = await publishItem({ env, fetchImpl });

  const accessToken = env.CWS_ACCESS_TOKEN;
  stdout(redact(JSON.stringify(result, null, 2), accessToken));
  return result;
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  runCli().catch((error) => {
    process.stderr.write(`Chrome Web Store release failed: ${redact(error?.message ?? error, process.env.CWS_ACCESS_TOKEN)}\n`);
    process.exitCode = 1;
  });
}
