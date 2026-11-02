import { constants } from 'node:fs';

/** Refuse to start the broker when its immutable store cannot safely open
 * caller-influenced paths without following links or blocking on special files.
 */
export function assertBrokerSafeOpenFlags({ platform = process.platform, flags = constants } = {}) {
  if (platform !== 'linux' || !flags ||
      ['O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK'].some(name =>
        !Number.isSafeInteger(flags[name]) || flags[name] <= 0)) {
    throw new Error('Immutable broker requires Linux O_NOFOLLOW, O_DIRECTORY and O_NONBLOCK');
  }
}
