/** Experimental root-selected, read-only immutable generation consumer.
 * The selector pathname, expected agent and broker credentials must come from
 * administrator-controlled configuration, never from untrusted workspace data.
 * This does not authorize publication or integrate legacy adapter lifecycle.
 */
import { readTrustedGenerationSelection } from './immutable-broker-trusted-selection.mjs';
import { readPinnedBrokerGeneration, resolvePinnedBrokerGeneration } from './immutable-broker-generation-client.mjs';

/** Testable digest-authenticated reader; the callback must fetch only by digest.
 * The trusted selector is validated before any blob transport is invoked.
 */
export async function resolveRootSelectedGeneration(selectionPath, expectedAgent, readBlob) {
  if (typeof readBlob !== 'function') throw new Error('Invalid root-selected generation reader');
  const digest = await readTrustedGenerationSelection(selectionPath, expectedAgent);
  return resolvePinnedBrokerGeneration(readBlob, digest, expectedAgent);
}

/** Production read-only path: root-owned selector -> pinned broker -> verified files.
 * No workspace path is written, renamed, or removed by this function.
 */
export async function readRootSelectedBrokerGeneration(selectionPath, socketPath, expectedAgent, options) {
  const digest = await readTrustedGenerationSelection(selectionPath, expectedAgent);
  return readPinnedBrokerGeneration(socketPath, digest, expectedAgent, options);
}
