/** Read one MCP input chunk without retaining a listener on a never-settling
 * output-failure promise for every message in a long-running session.
 * Abort also rejects a pending iterator.next() when stdin remains idle.
 */
export function nextMcpChunk(
  iterator: AsyncIterator<Uint8Array>, signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error("MCP output failed"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("MCP output failed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Do not miss abort between the initial check and listener installation.
    if (signal.aborted) { onAbort(); return; }
    try {
      Promise.resolve(iterator.next()).then(
        value => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}
