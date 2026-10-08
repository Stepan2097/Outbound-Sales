import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file so that what is on disk is always either the old version or the
 * whole new one, never half of it.
 *
 * `writeFileSync` truncates first: a kill in the middle left a cut file, and
 * `login-watch` read a cut file as "never seen anything" and said it all again.
 * This writes a temporary file beside the target, flushes it and renames it
 * over; a rename inside one directory is atomic.
 *
 * It is the synchronous twin of `state/atomic-write.mjs` in the server. The
 * agent is built into its own image from this folder alone, so it cannot reach
 * the server's copy; keep the two in step.
 */
export function writeFileAtomicSync(target, data, { fs: io = fs } = {}) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = io.openSync(temp, 'w', 0o600);
    io.writeFileSync(fd, data, 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    io.renameSync(temp, target);
  } catch (error) {
    if (fd !== null) try { io.closeSync(fd); } catch { /* already closed */ }
    try { io.unlinkSync(temp); } catch { /* never created */ }
    throw error;
  }
}
