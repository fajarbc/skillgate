/** Fail closed if the dedicated Linux broker retains ambient or inheritable
 * capabilities, even when its real/effective UID and GID are non-root.
 *
 * This checks the *current* process. It is a startup guard, not a substitute
 * for a separately provisioned UID or a protected store ancestry.
 */
import { readFileSync, statfsSync } from 'node:fs';

const PROC_SUPER_MAGIC = 0x9fa0;
const CAPABILITY_FIELDS = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'];

export function assertNoBrokerCapabilities({
  platform = process.platform,
  readStatus = () => readFileSync('/proc/self/status', 'utf8'),
  statusFilesystem = () => statfsSync('/proc/self/status').type,
} = {}) {
  if (platform !== 'linux') {
    throw new Error('Immutable broker capability inspection requires Linux');
  }
  let status;
  try {
    if (statusFilesystem() !== PROC_SUPER_MAGIC) {
      throw new Error('untrusted procfs mount');
    }
    status = readStatus();
  } catch {
    throw new Error('Immutable broker cannot verify Linux process capabilities');
  }
  if (typeof status !== 'string') {
    throw new Error('Immutable broker cannot verify Linux process capabilities');
  }
  const noNewPrivs = [...status.matchAll(/^NoNewPrivs:\s*([01])\s*$/gm)];
  if (noNewPrivs.length !== 1 || noNewPrivs[0][1] !== '1') {
    throw new Error('Immutable broker requires Linux NoNewPrivs=1');
  }
  for (const field of CAPABILITY_FIELDS) {
    const matches = [...status.matchAll(new RegExp(`^${field}:\\s*([0-9a-fA-F]+)\\s*$`, 'gm'))];
    if (matches.length !== 1 || BigInt(`0x${matches[0][1]}`) !== 0n) {
      throw new Error(`Immutable broker requires zero Linux ${field} capabilities`);
    }
  }
}
