import { constants } from "fs";
import { access } from "fs/promises";

/**
 * Whether a path is there, and whether that answer is one we actually got.
 *
 * The third case is the whole reason this exists. `absent` and `inaccessible`
 * are both "no file came back", and every decision in these modules that rests
 * on a missing record treats the first as license to act — delete a data
 * directory, start a second postmaster, remove somebody's PID file — while the
 * second is a question that could not be answered and licenses nothing.
 */
export type FilePresence = "present" | "absent" | "inaccessible";

/**
 * Distinguishes genuine absence from an inability to inspect a path.
 *
 * Only ENOENT and ENOTDIR are absence. ENOTDIR is in there because a component
 * of the path being a file rather than a directory means the named file cannot
 * exist, which is the same answer by a different route. Everything else —
 * EACCES on a directory this user may not traverse, EIO on a failing disk,
 * ELOOP on a symlink cycle — is the filesystem declining to say, and reporting
 * that as "nothing is there" is how an unreadable record becomes a deleted one.
 *
 * Its own module rather than a helper on either caller. Both ./pid-file and
 * ./local-dev-db-server need it, and ./local-dev-db-server re-exports
 * ./pid-file wholesale onto the `strataline/local-dev-db-server` entry point,
 * so exporting it from there would publish a plumbing detail as public API and
 * commit the package to supporting it. Nothing re-exports this file.
 *
 * @internal Not part of the published API.
 */
export async function getFilePresence(path: string): Promise<FilePresence> {
  try {
    await access(path, constants.F_OK);

    return "present";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;

    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "inaccessible";
  }
}

/**
 * True only where a path is confirmed to be there.
 *
 * The convenience form, for a caller whose two branches are both safe. A
 * caller for which "could not tell" has to behave like "present" — anything
 * gating a delete or a spawn — wants {@link getFilePresence} instead, since
 * this folds `inaccessible` into `false` like any other absence.
 *
 * @internal Not part of the published API.
 */
export async function fileExists(path: string): Promise<boolean> {
  return (await getFilePresence(path)) === "present";
}
