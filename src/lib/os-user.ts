import { userInfo } from "os";

/**
 * The username the operating system reports for this process, or null where it
 * cannot say.
 *
 * `userInfo()` throws rather than returning nothing when there is no passwd
 * entry for the effective uid, which is ordinary inside a container run with
 * `--user 1000:1000` against an image that does not know that uid. It is one
 * of the few `os` calls that can fail on a perfectly healthy machine, so every
 * caller wants the same three lines around it and none of them should have to
 * remember that.
 *
 * Null is a real answer rather than an error, and it means "this machine will
 * not tell you who you are". What to do about it belongs to the caller: naming
 * the cluster's superuser has other sources to fall back on, while deciding
 * which IPC objects are yours has none, so one degrades and the other declines
 * to act.
 *
 * @internal Not part of the published API.
 */
export function readOsUsername(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}
