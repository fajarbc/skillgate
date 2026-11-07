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
      // Node includes the effective GID in getgroups(). A retained non-root
      // supplementary group (e.g. Docker or a privileged service group) can
      // grant access to resources outside the broker's dedicated identity.
      // Require exactly the intended effective GID; --clear-groups satisfies
      // this on Linux, whereas merely excluding supplementary GID 0 does not.
      groups.length !== 1 || groups[0] !== egid) {
    throw new Error('Immutable broker requires matching non-root real/effective credentials without root or other supplementary groups');
  }
  return { uid, gid: egid };
}
