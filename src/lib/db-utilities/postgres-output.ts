import { type LogLevel } from "../logger";

/**
 * PostgreSQL's own severity words, and what each is to a `Logger`.
 *
 * Only the ones that are not ordinary. Everything else PostgreSQL emits —
 * LOG, NOTICE, INFO, DEBUG, and the DETAIL/HINT/CONTEXT/STATEMENT lines that
 * accompany a message — is routine output and stays `info`, which is where
 * every line used to go regardless.
 */
const POSTGRES_SEVERITIES: Readonly<Record<string, LogLevel>> = {
  PANIC: "error",
  FATAL: "error",
  ERROR: "error",
  WARNING: "warn",
};

/**
 * Every severity word PostgreSQL can print, whether or not it raises the
 * level. The set is the one `log_min_messages` accepts — DEBUG5 through
 * DEBUG1, INFO, NOTICE, WARNING, ERROR, LOG, FATAL, PANIC — plus the fields
 * elog prints alongside a message.
 *
 * English, which is not an assumption so much as something both callers
 * arrange: each runs initdb so that the cluster is written with
 * `lc_messages = C`, and the bundled PostgreSQL ships no translation catalogs
 * to render the words any other way. TestDatabaseInstance has to say so twice
 * to get there, since embedded-postgres supplies an `--lc-messages` of its own
 * ahead of anything passed to it. A cluster created elsewhere under a
 * different lc_messages could print a translated severity,
 * and the scan would not recognize it — that chunk falls back to `info`,
 * which is where every line used to go. Matching all of them and then looking the match up is what stops the
 * scan reading a word out of the middle of a message: `STATEMENT:  SELECT ...`
 * is matched by STATEMENT, so an `ERROR:` quoted inside that statement is
 * never reached.
 */
const POSTGRES_SEVERITY_PATTERN =
  /(?:^|\s)(PANIC|FATAL|ERROR|WARNING|LOG|NOTICE|INFO|DEBUG[1-5]?|DETAIL|HINT|CONTEXT|STATEMENT|QUERY|LOCATION):/;

/**
 * The level PostgreSQL's output is asking to be logged at.
 *
 * PostgreSQL says how bad a line is, in the line. It writes
 * `2026-09-02 19:32:50.954 MDT [64506] FATAL:  ...`, where the leading part is
 * `log_line_prefix` and the severity follows it, so the word is neither at the
 * start of the string nor at a fixed offset — the prefix is configurable and
 * carries a timestamp whose length varies with the zone. Hence a scan for the
 * word rather than a parse of the line.
 *
 * The highest severity in the chunk wins, and the whole chunk is logged at it.
 * A FATAL is followed by its own DETAIL and HINT lines, and splitting a
 * message up to give each line its own level would take the explanation away
 * from the thing it explains.
 *
 * Anything unrecognized is `info`, which is what every line used to get. A
 * chunk this cannot read is therefore no worse off than before, and that is
 * the direction to be wrong in: this decides whether output is shown when the
 * caller has asked for quiet, so a false ERROR is noise nobody asked for while
 * a missed one is the status quo.
 *
 * Its own module rather than LocalDevDBServer's, because both surfaces that
 * run a PostgreSQL have the same reason to read it and only one of them is a
 * dev server. A `pgVerbose: false` that hid the FATAL explaining why a server
 * would not start is the same failure wherever it happens, and importing the
 * dev server into TestDatabaseInstance to avoid it would pull a whole
 * lifecycle manager into a bundle that has no use for one.
 *
 * @internal Exported so the scan can be tested against real PostgreSQL output
 * without having to provoke a server into producing each severity.
 */
export function postgresOutputLevel(text: string): LogLevel {
  let level: LogLevel = "info";

  for (const line of text.split(/\r?\n/)) {
    const match = POSTGRES_SEVERITY_PATTERN.exec(line);

    if (!match) {
      continue;
    }

    const severity = POSTGRES_SEVERITIES[match[1]];

    if (severity === "error") {
      return "error";
    }

    if (severity === "warn") {
      level = "warn";
    }
  }

  return level;
}

/**
 * Names the cause when PostgreSQL could not get its SysV IPC objects.
 *
 * Worth a sentence of our own because PostgreSQL's wording sends the reader
 * somewhere else entirely. Both failures read "No space left on device", which
 * is a full disk everywhere else it appears, and the actual cause is a
 * per-machine kernel limit on shared memory segments or semaphore sets. macOS
 * ships low defaults for both, and PostgreSQL releases neither on a hard kill,
 * so a suite that force-kills servers accumulates them until an unrelated
 * start fails.
 *
 * Shared by both surfaces that run a PostgreSQL, for the reason
 * {@link postgresOutputLevel} gives: this repository's own suite is what leaks
 * the objects, and the suite runs on TestDatabaseInstance, so the surface most
 * likely to hit the limit must not be the one that cannot explain it.
 *
 * PostgreSQL's own HINT does say this, and is carried through with the rest of
 * its output. What it cannot say is that leaked objects, rather than a limit
 * that is genuinely too low, are the usual reason a developer machine reaches
 * one. So the remedy is spelled out in terms anyone can act on rather than
 * pointing at a script only this repository has.
 */
export function ipcExhaustionHint(output: string): string {
  if (!/could not create (shared memory segment|semaphores)/i.test(output)) {
    return "";
  }

  return (
    "\n\nThis is a kernel limit on SysV IPC objects rather than disk space. Leaked objects are the usual reason it is reached, " +
    "since PostgreSQL frees them on a clean shutdown and not on a hard kill, so they accumulate across crashed or force-killed servers. " +
    "List them with `ipcs -m` and `ipcs -s`, and remove the abandoned ones with `ipcrm`."
  );
}

/**
 * How much of a server's output to keep for a diagnosis.
 *
 * Counted in CHARACTERS rather than in lines, which is the whole point of
 * this being one number in one place. Both buffers are read as well as
 * reported: {@link ipcExhaustionHint} scans the dev server's, and
 * TestDatabaseInstance additionally scans its own to decide whether a lost
 * port is worth retrying. A cap counted in lines requires splitting the
 * chunks to apply it, and splitting into lines and rejoining them is not the
 * identity function.
 *
 * Generous, because the only thing this has to prevent is a server that runs
 * for a week accumulating its own log in memory. A startup failure is a few
 * hundred characters, so nothing that diagnoses anything is ever reached by
 * the trim.
 */
const OUTPUT_BUFFER_CHARS = 8000;

/**
 * The last of what a PostgreSQL wrote, kept for a failure that has to explain
 * itself.
 *
 * Bytes as PostgreSQL emitted them, trimmed only at the front. That is the
 * property the readers need and the one an earlier line-based version of this
 * quietly did not have: a chunk boundary falls wherever the pipe happened to
 * flush, so a message can arrive as `could not create sema` and then
 * `phores: No space left on device`. Split those into trimmed lines and
 * rejoin them and the text carries a newline through the middle of a word,
 * which matches neither {@link ipcExhaustionHint} nor the bind-failure scan
 * that decides whether to retry a lost port. Appending verbatim cannot go
 * wrong that way, and bounding by length rather than by line is what lets it
 * stay verbatim.
 *
 * @internal Not part of the published API.
 */
export class PostgresOutputBuffer {
  private text = "";

  constructor(private readonly limit: number = OUTPUT_BUFFER_CHARS) {}

  /** Records a chunk exactly as it arrived, dropping the oldest if over. */
  append(chunk: string): void {
    this.text += chunk;

    if (this.text.length > this.limit) {
      this.text = this.text.slice(-this.limit);
    }
  }

  /** Forgets everything, for the start of a fresh attempt. */
  clear(): void {
    this.text = "";
  }

  /** What was written, ready to put in a message or scan. */
  read(): string {
    return this.text.trim();
  }
}
