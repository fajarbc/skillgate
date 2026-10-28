/** Fail-closed credential check for the experimental separate-UID broker.
 * A process with retained root credentials or mismatched effective credentials
 * is not a defensible privilege boundary for untrusted workspace writers.
 */
export function assertDedicatedBrokerIdentity(credentials = process) {
  for (const method of ['getuid', 'geteuid', 'getgid', 'getegid', 'getgroups']) {
    if (typeof credentials[method] !== 'function') {
      throw new Error('Immutable broker requires POSIX real/effective credential inspection');
    }
  }
  const uid = credentials.getuid();
  const euid = credentials.geteuid();
  const gid = credentials.getgid();
  const egid = credentials.getegid();
  const groups = credentials.getgroups();
  if (![uid, euid, gid, egid].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Array.isArray(groups) || !groups.every(value => Number.isSafeInteger(value) && value >= 0) ||
      uid === 0 || euid === 0 || uid !== euid || gid !== egid || egid === 0 ||
      groups.includes(0)) {
    throw new Error('Immutable broker requires matching non-root real/effective credentials without root supplementary groups');
  }
  return { uid, gid: egid };
}
