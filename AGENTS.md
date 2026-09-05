# Agent Guidelines

## Changelog

- **Order:** `changelog.md` runs oldest to newest, so new entries go at the bottom of the file.

- **Keep public changes represented:** when work introduces or materially changes the final user-facing release delta, update `changelog.md` under `## Unreleased`.

- **Describe the final release delta, not the branch history:** `## Unreleased` is a concise, user-facing summary of how the next release will differ from the last one, not a log of how it got there. A bug introduced and fixed on the same branch never existed as far as a reader is concerned, so it gets no entry.

- **Consolidate continuously by outcome:** keep `## Unreleased` release-ready after every change. Fold new work into the entry it belongs with rather than appending a line per commit.

- **Flag breaking changes:** call them out at the top of `## Unreleased`, and prefix the bullet itself with `**Breaking:**` so it sits next to the behavior it changed.

- **On release (human, not agents, reminder):** renaming `## Unreleased` to a version with a date, and bumping the version in `package.json`, are the maintainer's to do. Do not do either unless explicitly asked.

- **Style:** `## X.Y.Z (Month DD, YYYY)` headings, a short prose intro where a release needs one, then bold domain labels over plain bullets, not Added/Fixed/Changed sections. Run `bun run update-docs` after editing to regenerate the table of contents and reformat.

## Language Style

- **American English:** use American English spelling in code, comments, documentation, tests, and generated text. So `serialize`, `authorize`, `behavior`, `signaled`, `canceled`.

- **Except when it is somebody else's name:** a third-party API keeps its own spelling. `EmbeddedPostgres.initialise()` comes from the `embedded-postgres` package, so that call site stays British. The rule governs what this project names, not what it calls.

## Markdown and Prose Style

These rules govern published Markdown, meaning the README, the changelog, and the docs, plus commit messages and PR descriptions. They do not govern TypeScript or JavaScript source, and code comments are source. Nor do they govern code fences, inline code, table cells holding literal content, URLs, or identifiers, wherever those appear.

- **Avoid em dashes and semicolons in prose:** do not use `—` or `;` in normal text. Write with commas, periods, or a cleaner sentence split so it reads naturally. When editing a sentence that already has one, rewrite the sentence rather than swapping the character out.

- **Do not hard-wrap prose:** Prettier is set to `proseWrap: "never"`, so write each markdown paragraph as a single line. Hard-wrapped prose reflows the whole paragraph whenever a word changes, which turns a one-word edit into a dozen changed lines that a reviewer cannot tell apart from a rewrite. Code comments still wrap at the usual width.

## Verifying Your Work

- The suite talks to a real PostgreSQL, and some dev-server tests are sensitive to machine load. A single green run is weak evidence for anything touching process lifecycle, so run it more than once before calling such a change done.

- When you fix a bug, first confirm the new test fails without the fix. Otherwise you have written a test that asserts the code does what it already did.

- **Clear leaked IPC objects when PostgreSQL starts failing for no reason:** the suite force-kills PostgreSQL on purpose in the shutdown tests, and PostgreSQL frees its SysV shared memory and semaphores on a clean exit only. A dev-server run leaks around 50 semaphore sets, so nothing goes wrong for dozens of runs and then unrelated tests all fail at once with `could not create semaphores: No space left on device`, which reads as a full disk and is not one. `bun run test:clean-ipc` clears both kinds. It only removes what this user owns, skips shared memory whose creator is still running, and skips semaphores entirely while any PostgreSQL is up, since macOS reports no creator for those.
