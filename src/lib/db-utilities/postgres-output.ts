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
 * The words that are not a severity of their own but a field of the message
 * above them.
 *
 * PostgreSQL writes a message as a primary line and then, optionally, these:
 *
 *   FATAL:  could not create semaphores: No space left on device
 *   DETAIL:  Failed system call was semget(345485937, 17, 03600).
 *   HINT:  This error does *not* mean that you have run out of disk space.
 *
 * So a group holding only these is not a message at `info`, it is the rest of
 * whichever message came before it — which is why {@link postgresSeverity}
 * reports "no severity here" rather than "info" for one, and why
 * {@link PostgresOutputReader} then carries the previous level across it.
 * Reading `DETAIL` as a fresh routine line is how the sentence explaining a
 * FATAL gets logged at `info` and dropped by a filter that was only asked to
 * quiet chatter.
 */
const POSTGRES_MESSAGE_FIELDS: ReadonlySet<string> = new Set([
  "DETAIL",
  "HINT",
  "CONTEXT",
  "STATEMENT",
  "QUERY",
  "LOCATION",
]);

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
 * The highest severity anywhere in the text wins, which makes this the answer
 * to "how bad is this, at worst" for a caller holding a block of output and
 * wanting one level for it.
 *
 * That is NOT how the surfaces log a running server, and the difference is
 * worth knowing before reaching for this. They read through
 * {@link PostgresOutputReader}, which splits the stream into messages and
 * gives each the level it stated, because a routine LOG that happened to
 * arrive in the same chunk as a FATAL is still routine. What both agree on is
 * the thing that would be lost by splitting per LINE: a FATAL is followed by
 * its own DETAIL and HINT, and those go at its level rather than their own,
 * since taking the explanation away from the thing it explains is the one
 * split neither will make.
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
  return postgresSeverity(text) ?? "info";
}

/**
 * The severity this text states for itself, or null when it states none.
 *
 * The same scan {@link postgresOutputLevel} reports, with the one distinction
 * that function cannot make: it answers `info` both for a line that says LOG
 * and for a line that says nothing this recognizes, because `info` is the
 * right thing to LOG either way. Deciding whether the previous level should
 * carry over is a different question, and it needs those two told apart — a
 * DETAIL is the continuation of whatever came before it, while a LOG is a new
 * message that ends the old one's reach.
 *
 * So a group holding only {@link POSTGRES_MESSAGE_FIELDS}, or nothing
 * recognizable at all, reports null. Only a primary severity word — PANIC
 * through DEBUG — answers with a level.
 *
 * @internal Exported alongside {@link postgresOutputLevel} so the stickiness
 * rule can be tested without driving a server into writing a torn message.
 */
export function postgresSeverity(text: string): LogLevel | null {
  let level: LogLevel | null = null;

  for (const line of text.split(/\r?\n/)) {
    const severity = postgresLineSeverity(line);

    if (severity === null) {
      continue;
    }

    if (severity === "error") {
      return "error";
    }

    if (severity === "warn") {
      level = "warn";
    } else if (level === null) {
      // A routine word states `info`, which is not the same as nothing having
      // been stated. It must not overwrite a `warn` already seen in this
      // group, which is what keeps "highest severity wins" true.
      level = "info";
    }
  }

  return level;
}

/**
 * The severity ONE line states, or null when it starts no message of its own.
 *
 * The primitive under both readers, and the one that decides where a message
 * begins. A line reports null in two cases that mean the same thing here: it
 * carries a {@link POSTGRES_MESSAGE_FIELDS} word, so it is the rest of the
 * message above it, or it carries nothing this recognizes — a blank line, a
 * wrapped continuation, one of this library's own lines on the `pg` source.
 * None of those starts a message, so none of them ends the previous one.
 *
 * @internal Exported so the message boundary can be tested a line at a time.
 */
export function postgresLineSeverity(line: string): LogLevel | null {
  const match = POSTGRES_SEVERITY_PATTERN.exec(line);

  if (!match || POSTGRES_MESSAGE_FIELDS.has(match[1])) {
    return null;
  }

  // Recognized but not raising — LOG, NOTICE, INFO, DEBUG — which still STATES
  // a level, and stating one is what makes it a message rather than a
  // continuation.
  return POSTGRES_SEVERITIES[match[1]] ?? "info";
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

/**
 * Holds back the tail of a chunk that stops mid-line, so what is read is only
 * ever whole lines.
 *
 * The companion to {@link PostgresOutputBuffer} and the opposite job. That one
 * keeps every byte for a reader that will scan the lot at the end, so it must
 * never impose a line structure the pipe did not have. This one feeds a reader
 * that runs on EVERY chunk as it arrives — {@link PostgresOutputReader}, which
 * decides the level a line is logged at — and that reader needs the structure.
 *
 * The two are not in tension, they are the same fact used twice: a chunk
 * boundary falls wherever the pipe happened to flush, so `FATAL:` can arrive
 * as `FAT` and then `AL:  database files are incompatible`. Scanned as two
 * chunks neither one contains a severity word, so both are logged `info` —
 * and `info` from source `pg` is exactly what `createConsoleLogger({ pg:
 * false })` drops. The sentence saying why the server would not start is then
 * the one line that never reaches the log, which is the failure reading the
 * severity was added to prevent.
 *
 * What it does NOT do is decide where one message ends and the next begins.
 * Everything complete goes out as one string and
 * {@link PostgresOutputReader} takes that boundary from PostgreSQL's own
 * structure, which is the only place it is recorded. The one thing held back
 * here is a final line that has not finished arriving.
 *
 * Deliberately not a parse of `log_line_prefix`, which would find the true
 * boundary between one message and the next. It is configurable, so there is
 * no format to rely on — the same reason the severity is scanned for rather
 * than read at an offset.
 *
 * One instance per stream. Two pipes interleaved into one assembler would
 * splice a half-written stdout line onto the front of a stderr line and make a
 * token out of neither.
 *
 * @internal Not part of the published API.
 */
export class PostgresLineAssembler {
  private pending = "";

  /**
   * The complete lines this chunk finishes, or "" when it finishes none.
   *
   * A chunk with no newline in it at all yields nothing and waits, which is
   * the whole point: a partial line read now is a line whose severity cannot
   * be read at all.
   */
  take(chunk: string): string {
    this.pending += chunk;

    const lastBreak = this.pending.lastIndexOf("\n");

    if (lastBreak === -1) {
      return "";
    }

    const complete = this.pending.slice(0, lastBreak + 1);

    this.pending = this.pending.slice(lastBreak + 1);

    return complete;
  }

  /**
   * Whatever is still held, for a stream that has ended.
   *
   * Not optional. A postmaster that refuses to start writes the reason and
   * exits, and PostgreSQL's last line before it goes is not guaranteed to end
   * in a newline — so without this the held text is the FATAL itself, and
   * holding a line back forever loses more than reading it early ever did.
   */
  flush(): string {
    const rest = this.pending;

    this.pending = "";

    return rest;
  }
}

/** One PostgreSQL message, and the level it stated for itself. */
export interface PostgresOutputRead {
  text: string;
  level: LogLevel;
}

/**
 * Turns a stream of chunks into whole messages, each at the level it states.
 *
 * Three things go wrong between a postmaster writing a message and a logger
 * receiving it, and all three end the same way: the sentence saying why a
 * server would not start is logged at `info`, and `info` from source `pg` is
 * what `createConsoleLogger({ pg: false })` drops. So the failure is invisible
 * to a caller who only asked for quiet, which is the failure reading the
 * severity was added to prevent.
 *
 * **A torn word.** `FATAL:` arrives as `FAT` and then `AL:  ...`, and neither
 * half is a severity. {@link PostgresLineAssembler} holds the tail back until
 * the line is whole.
 *
 * **A torn message.** A flush can fall cleanly between the lines of one
 * message:
 *
 *   FATAL:  could not create semaphores: No space left on device   <- chunk 1
 *   DETAIL:  Failed system call was semget(...).                   <- chunk 2
 *   HINT:  This error does *not* mean that you have run out of ...
 *
 * The second chunk states no severity of its own — see
 * {@link POSTGRES_MESSAGE_FIELDS} — so read alone it is `info`, and the
 * explanation is filtered away from the failure it explains. So the level
 * CARRIES: a run of lines stating nothing belongs to the last message that
 * stated something.
 *
 * **Two messages in one chunk.** The mirror image, and the reason this splits
 * rather than levelling whatever arrived:
 *
 *   LOG:  could not bind IPv4 address "127.0.0.1": Address already in use
 *   FATAL:  could not create any TCP/IP sockets
 *
 * Levelling that as one unit sends the LOG out at `error` too. Which lines
 * share a level would then be decided by where the kernel happened to flush —
 * the same two lines arriving in two chunks get two levels, and nothing about
 * the server changed. So the boundary is taken from PostgreSQL's own
 * structure instead of from the pipe's: a line stating a severity STARTS a
 * message, and the field and blank lines after it CONTINUE it.
 *
 * That is what keeps both halves true at once. A FATAL still carries the
 * DETAIL and HINT that explain it, because those attach to it rather than
 * standing alone, and a routine line beside it is still routine. Splitting per
 * LINE would get the second and lose the first, which is why this splits per
 * message.
 *
 * A message comes back out with its lines joined by `\n`, so a `\r\n` the
 * stream carried is not preserved. That is a change to text a person reads and
 * to nothing else, which is the only reason it is acceptable: every scan that
 * has to see what PostgreSQL actually wrote — ipcExhaustionHint, the bind
 * check on a failed test-database start — runs over
 * {@link PostgresOutputBuffer}, which is appended to verbatim and never split
 * into lines at all.
 *
 * @internal Not part of the published API.
 */
export class PostgresOutputReader {
  private readonly lines = new PostgresLineAssembler();

  // The level a continuation belongs to, held across chunks. `info` until
  // PostgreSQL says otherwise, which is where every line went before any of
  // this existed and the right way to be wrong: this decides what survives a
  // filter, so a level invented here is noise nobody asked for while a missed
  // one is the status quo.
  private carried: LogLevel = "info";

  /** The messages this chunk completes, in order. Empty when it completes none. */
  take(chunk: string): PostgresOutputRead[] {
    return this.read(this.lines.take(chunk));
  }

  /**
   * Whatever is still held, for a stream that has ended, after which this is
   * back to where it started.
   *
   * The reset is the half that is easy to leave out. Both surfaces keep one
   * reader for longer than one postmaster: the dev server can be stopped and
   * started again on the same instance, and a test database that loses its
   * port retries against a new child. Nothing a dead server wrote continues
   * into what a live one writes, so a level left carried across that boundary
   * would put the last server's FATAL on the first unrecognized line of the
   * next one's startup, and a level is what decides whether a line survives a
   * filter.
   */
  flush(): PostgresOutputRead[] {
    const reads = this.read(this.lines.flush());

    this.carried = "info";

    return reads;
  }

  private read(assembled: string): PostgresOutputRead[] {
    const reads: PostgresOutputRead[] = [];

    // Nothing but whitespace states nothing and continues nothing, so it
    // leaves `carried` where it was. A blank line between the lines of a
    // message is handled below by the same rule, having no severity of its
    // own.
    if (!assembled.trim()) {
      return reads;
    }

    let current: string[] = [];
    // The run that is still open. It starts at whatever the last chunk left,
    // so a DETAIL arriving on its own goes out at its FATAL's level.
    let level = this.carried;

    const close = (): void => {
      const text = current.join("\n").trim();

      current = [];

      if (text) {
        reads.push({ text, level });
      }
    };

    for (const line of assembled.split(/\r?\n/)) {
      const stated = postgresLineSeverity(line);

      // A line that states a severity is a new message, so the one being
      // built is finished. A line that states none continues it, whether it
      // is a DETAIL, a blank line, or something unrecognized.
      if (stated !== null) {
        close();
        level = stated;
        this.carried = stated;
      }

      current.push(line);
    }

    close();

    return reads;
  }
}
