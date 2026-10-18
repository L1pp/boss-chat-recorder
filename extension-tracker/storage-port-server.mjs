// Extension-local persistence transport. No website or loopback requests.
export function createStoragePortServer({ runtime, handleMessage, isTrustedSender }) {
  const pending = new Map();
  const connect = port => {
    if (port.name !== 'bossReadonlyTracker.storage.v1') return;
    let used = false, closed = false;
    const disconnect = () => {
      closed = true;
      pending.delete(port);
      port.onMessage.removeListener?.(message);
      port.onDisconnect.removeListener?.(disconnect);
    };
    const finish = result => {
      const alreadyClosed = closed;
      disconnect();
      if (alreadyClosed) return;
      try { port.postMessage({ type: 'STORAGE_RESULT', result }); } catch { /* Caller may have gone away. */ }
      // The client closes after receiving the result; do not race delivery by
      // tearing down the port immediately after postMessage.
    };
    const message = value => {
      if (used || closed) return;
      used = true;
      if (!['BULK_PROGRESS', 'BULK_SNAPSHOTS'].includes(value?.type)) {
        finish({ ok: false, error: 'UNKNOWN_COLLECTOR_MESSAGE' });
        return;
      }
      pending.set(port, disconnect);
      try { port.postMessage({ type: 'STORAGE_ACTIVITY' }); } catch { disconnect(); }
      // A caller disconnect does not cancel an already accepted durable commit.
      Promise.resolve().then(() => handleMessage(value, port.sender)).then(result => {
        // The collector only needs a commit ACK for checkpoints. Do not echo
        // its full contact baseline back through the browser's IPC channel.
        finish(value.type === 'BULK_PROGRESS' && result?.ok === true ? { ok: true } : result);
      }, () => finish({ ok: false, error: 'BULK_STORAGE_UNAVAILABLE' }));
    };
    if (!isTrustedSender(port.sender)) {
      finish({ ok: false, error: 'UNTRUSTED_COLLECTOR_SENDER' });
      return;
    }
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
  };
  runtime.onConnect?.addListener(connect);
  return {
    activity() {
      for (const [port, disconnect] of pending) {
        try { port.postMessage({ type: 'STORAGE_ACTIVITY' }); }
        catch { disconnect(); }
      }
    },
  };
}
