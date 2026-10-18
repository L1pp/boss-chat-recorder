// Shipped public entry point for the extension runtime.
//
// Importing this module is inert: nothing is registered until the bootstrap
// calls registerPublicRuntime. The module has no imports of its own, no local
// bridge, no access secret and no instrumentation layer. The message handler
// factory, the storage port server factory and the collector trust check are
// injected so the public wiring reuses the shipped implementations without
// pulling in any temporary debugging module.
const PUBLIC_MESSAGE_TYPES = new Set([
  'SITE_REQUEST_SLOT',
  'GET_STATE',
  'GET_BULK_PROGRESS',
  'START_UPDATE',
  'STOP_UPDATE',
  'RESUME_AFTER_VERIFICATION',
  'EXPORT_AI_INPUT',
  'EXPORT_ACCOUNT_BACKUP',
  'CLEAR_ACCOUNT',
  'BULK_PROGRESS',
  'BULK_SNAPSHOTS',
]);

export function registerPublicRuntime(chromeApi, {
  createExtensionMessageHandler,
  createStoragePortServer,
  isTrustedCollectorSender,
} = {}) {
  if (typeof chromeApi?.runtime?.onMessage?.addListener !== 'function' ||
      typeof chromeApi.runtime.id !== 'string' || !chromeApi.runtime.id) {
    throw new Error('CHROME_EXTENSION_API_REQUIRED');
  }
  if (typeof createExtensionMessageHandler !== 'function') throw new Error('MESSAGE_HANDLER_FACTORY_REQUIRED');
  if (typeof createStoragePortServer !== 'function') throw new Error('STORAGE_PORT_FACTORY_REQUIRED');
  if (typeof isTrustedCollectorSender !== 'function') throw new Error('TRUSTED_SENDER_CHECK_REQUIRED');

  // Storage port traffic is accepted only from the collector page, reusing the
  // existing trust boundary scoped to this build's own extension id.
  const isTrustedSender = sender => isTrustedCollectorSender(sender, chromeApi.runtime.id);

  let dispatch = null;
  const storagePorts = createStoragePortServer({
    runtime: chromeApi.runtime,
    // Resolved lazily: the port server can report storage activity as soon as
    // the message handler below is initialised.
    handleMessage: (message, sender) => dispatch(message, sender),
    isTrustedSender,
  });
  dispatch = createExtensionMessageHandler(chromeApi, {
    onStorageActivity: () => storagePorts.activity(),
  });
  if (typeof dispatch !== 'function') throw new Error('MESSAGE_HANDLER_REQUIRED');

  const handleMessage = (message, sender, sendResponse) => {
    // Anything outside the whitelist (unknown types and every DEBUG_* control
    // type) is dropped without a response, so a sender cannot even learn
    // whether a hidden channel exists.
    if (!PUBLIC_MESSAGE_TYPES.has(message?.type)) return false;
    Promise.resolve().then(() => dispatch(message, sender)).then(
      result => sendResponse(result),
      // Only a static code may leave the worker. Error text can carry page
      // content or collector internals, so it is never echoed back.
      error => sendResponse({ ok: false,
        error: typeof error?.code === 'string' ? error.code : 'RUNTIME_ERROR' }),
    );
    return true;
  };
  chromeApi.runtime.onMessage.addListener(handleMessage);
  return { handleMessage, storagePorts };
}
