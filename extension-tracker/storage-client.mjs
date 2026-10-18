// A single extension-local port per durable request. No retries or website IO.
export function createStorageMessenger(runtime) {
  const unavailable = () => Object.assign(new Error('扩展内部保存连接不可用。'), { code: 'BULK_STORAGE_UNAVAILABLE' });
  return (message, { onActivity } = {}) => {
    if (typeof runtime?.connect !== 'function') {
      try {
        return typeof runtime?.sendMessage === 'function'
          ? Promise.resolve(runtime.sendMessage(message)) : Promise.reject(unavailable());
      } catch { return Promise.reject(unavailable()); }
    }
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      let port, settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        port?.onMessage.removeListener?.(receive);
        port?.onDisconnect.removeListener?.(disconnect);
        try { port?.disconnect(); } catch { /* Already disconnected. */ }
        callback(value);
      };
      const disconnect = () => {
        try { void runtime.lastError; } catch { /* Consume without logging its contents. */ }
        finish(reject, unavailable());
      };
      const receive = value => {
        if (settled) return;
        if (value?.type === 'STORAGE_ACTIVITY') {
          try { onActivity?.(); } catch { /* Observation must not break persistence. */ }
        } else if (value?.type === 'STORAGE_RESULT') {
          if (!value.result || typeof value.result.ok !== 'boolean') finish(reject, unavailable());
          else finish(resolve, value.result);
        }
      };
      cancel = () => finish(reject, unavailable());
      try {
        port = runtime.connect({ name: 'bossReadonlyTracker.storage.v1' });
        port.onMessage.addListener(receive);
        port.onDisconnect.addListener(disconnect);
        port.postMessage(message);
      } catch { finish(reject, unavailable()); }
    });
    promise.cancel = () => cancel();
    return promise;
  };
}
