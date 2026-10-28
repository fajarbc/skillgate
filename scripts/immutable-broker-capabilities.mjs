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
  credentials = () => ({
    uid: process.getuid(), euid: process.geteuid(),
    gid: process.getgid(), egid: process.getegid(),
  }),
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
  // Node's getuid/geteuid and getgid/getegid do not expose saved-set or
  // filesystem IDs. A process with saved UID 0 can regain effective root
  // via seteuid(0) even with NoNewPrivs=1 and all capability sets empty.
  // Require all four kernel IDs to agree with Node's real/effective IDs.
  let ids;
  try { ids = credentials(); } catch {
    throw new Error('Immutable broker cannot verify Linux Uid/Gid credentials');
  }
  for (const [field, real, effective] of [
    ['Uid', ids?.uid, ids?.euid], ['Gid', ids?.gid, ids?.egid],
  ]) {
    const matches = status.split('\n').filter(line => line.startsWith(`${field}:`));
    const parts = matches.length === 1
      ? matches[0].slice(field.length + 1).trim().split(/[ \t]+/)
      : [];
    if (!Number.isSafeInteger(real) || real < 0 ||
        !Number.isSafeInteger(effective) || effective !== real ||
        parts.length !== 4 ||
        parts.some(value => !/^[0-9]+$/.test(value) ||
          !Number.isSafeInteger(Number(value)) || Number(value) !== real)) {
      throw new Error(`Immutable broker requires matching real/effective/saved/filesystem ${field} credentials`);
    }
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
