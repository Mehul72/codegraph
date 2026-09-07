import { Session } from '../../session.js';
import { NoIndexError } from '../../session.js';
import { log } from '../../util/log.js';
import { plural } from '../../util/text.js';

/**
 * The hook path. Agents call this after writing a file, so it has to be quiet,
 * quick, and completely harmless when something is wrong. A failure here must
 * never surface as an error in the agent's tool output, because the staleness
 * check will pick the change up on the next query anyway.
 */
export async function touchCommand(files: string[]): Promise<void> {
  let session: Session;
  try {
    session = await Session.open();
  } catch (err) {
    if (err instanceof NoIndexError) return;
    log.debug(`touch could not open the index: ${(err as Error).message}`);
    return;
  }

  try {
    // A hook may hand over several space separated paths in one argument.
    const expanded = files.flatMap((entry) => entry.split(/\s+/).filter(Boolean));
    if (expanded.length === 0) return;
    const stats = await session.touch(expanded);
    log.debug(`touched ${stats.filesIndexed} ${plural(stats.filesIndexed, 'file')} in ${stats.durationMs}ms`);
  } catch (err) {
    log.debug(`touch failed: ${(err as Error).message}`);
  } finally {
    session.close();
  }
}
