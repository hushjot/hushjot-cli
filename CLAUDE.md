# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@hushjot/cli` is the **second client** for HushJot, an end-to-end encrypted notepad whose
primary client is a browser app. It reads and writes the same Firestore the app syncs with,
over plain REST with no Firebase SDK, and holds the data-encryption key on the operator's own
machine. It also ships an MCP server so an agent can reach the same verbs.

It is not a standalone product. The app repository is the authority for the storage format, the
security rules and the spec: the code cites spec sections by number (`§16`, `§28`, `§33.9`) and
those sections live in `encrypted-cloud-notepad-agentic-ai-spec.md` **in the app repo**, as does
`docs/security.md` § "The CLI and MCP server", which is the contract for what this tool may do.
Read the cited section before changing anything that references one.

## The `@hushjot/core` dependency

`package.json` declares `"@hushjot/core": "file:../hushjot/dist-core"` — a build artifact emitted
by the app repo's `npm run build:core`, not a published package. **It is not vendored and must
never be reimplemented here.** `deriveTitle`, `noteMetaJson`, `excerptOf`, the envelope and the
tokeniser all come from core, because a second implementation of any of them would work
perfectly and disagree silently: a title derived differently is written to the account, read
back by the app, and nothing anywhere reports a problem.

One thing about the checkout, because it is not obvious:

- The app is cloned beside this repo as **`../hushjot/`**, and `node_modules/@hushjot/core` is a
  symlink to its `dist-core`. If core resolves to something stale or missing, rebuild with
  `npm run build:core` there. A new export the CLI needs is added to the app's
  `src/core/public.ts` first — that list is the API.
- `dist-core` also ships **`contract/`** — `firestore.rules` and `format-vectors.json` — and the
  tests consume them from the *installed package* rather than from a copy here, deliberately.
  `tests/emulator/firestore.rules` is gitignored and written by `tests/integration/run.mjs` on
  every run for exactly that reason: there must be one source of truth for the rules, and it is
  the app repo.

A change to stored bytes in the app — the envelope, `noteMetaJson`'s omission rules,
`deriveTitle`, `excerptOf`, the tokeniser — moves `FORMAT_VERSION` and means this package needs
a release. A change to `firestore.rules` reaches the integration test here immediately.

## Commands

```bash
npm run check             # tsc --noEmit — the only type/lint gate; there is no ESLint
npm test                  # vitest unit suite, no network
npm run test:integration  # the emulator journey; needs the `firebase` CLI and Java
npm run verify            # all three — the full gate

npm run build             # emit dist/ — only needed to install, never to develop
npm run local             # build, then `npm link` → a global `hushjot`
npm run unlink            # remove that global command
```

Single test file / single case:

```bash
npx vitest run tests/unit.test.ts
npx vitest run tests/unit.test.ts -t 'conflict'
npx vitest                # watch mode
```

**Development needs no build, and there is no bundler.** Node 22.18+ runs the TypeScript in
`src/` directly — that is what the tests drive and what you should run while working
(`node src/bin/hushjot.ts ...`). It is why `tsconfig.json` sets `allowImportingTsExtensions`,
and why every relative import in `src/` is written with an explicit `.ts` extension. Keep
that; dropping the extension breaks the runtime even though tsc stays happy.

`npm run build` exists for one reason: **Node refuses to strip types under `node_modules`**
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts` entry point cannot survive being
installed. `tsconfig.build.json` flips `noEmit` off into `dist/`, and the base config's
`rewriteRelativeImportExtensions` rewrites those `.ts` specifiers to `.js` on the way out —
which is precisely why the explicit extensions above are load-bearing rather than noise. `bin`
points at `dist/bin/hushjot.js`, and `prepare` builds, so `npm link` and any install get a
working binary. Still no bundler: it is `tsc` and nothing else.

The public repository is written from a private working copy by `npm run export:public -- <dir>`,
which exports `HEAD` without `private/` (`tools/export-public.mjs`) and fails if any word in
`private/export-forbidden.txt` appears in the result. Anything that must never be published goes
in `private/`.

`test:integration` starts its own emulators via `emulators:exec`, so nothing needs to be running
first. Its ports are **9099/8086**, chosen so a running `npm run emulators` in the app checkout
(9098/8085) does not collide.

## Architecture

A command is assembled bottom-up, and the layering is a dependency direction:

```
src/bin/hushjot.ts     argument parsing, and the ONLY place errors become text + exit codes
src/mcp/server.ts      the verbs over stdio MCP, plus the working protocol (instructions, prompts)
src/commands/*.ts      ls, cat, search, push, append, replace, mkdir, pending, take, reply — one file each
src/gates.ts           "Claude may continue." boxes and receipts: the agent loop's state, parsed
src/workspace.ts       config → session → key record → vault, assembled once
src/find.ts            what someone typed → exactly one note
src/write.ts           the write path and its two safety rules
src/notes.ts           the Firestore document envelope, both directions
src/pull.ts            the delta pull      src/cache.ts    the ciphertext cache
src/rest.ts            Firestore over REST  src/auth.ts     Identity Toolkit over REST
src/vault.ts           passphrase → DEK     src/keychain.ts the OS secret store
```

**Errors are translated once, in `bin/hushjot.ts`.** Everything below throws a typed error and
says nothing. That file is the only thing that decides what a person reads and what the process
exits with, because the same failure has to make sense to two audiences — someone at a terminal
who can go fix their allowlist entry, and an agent deciding whether a retry is worth anything.
Exit codes carry that second meaning and are part of the public interface: **2** usage, **3** not
configured, **4** the user's to fix, **5** transient (retry), **6** write conflict, **7** internal,
**8** sync paused for maintenance (the cost kill switch; retry later — hours, not seconds).
Add a new failure by adding a branch to `describe()`, not by printing from a command.

**`openWorkspace()` orders its failures on purpose.** Config, then session, then key record, then
vault — each step's failure has a different remedy, and collapsing them produces the single worst
error a tool like this can give ("something went wrong") when the answer was "run `hushjot login`"
or "you are not on the allowlist" or "wrong passphrase". Reading the key record is *also* the
approval check: every path under `users/{uid}` is gated on the allowlist, so a refused read
surfaces as `SyncNotApprovedError` before a passphrase is ever asked for.

**No Firebase SDK, by argument rather than by preference.** The SDK exists to manage a session
and a local cache across page loads in a browser; this process lives for eighty milliseconds and
needs one ID token. The rules are enforced identically over REST — `firestore.rules` never sees
which transport a request arrived on. The precedent is the app's own
`src/adapters/firebase/shareRest.ts`.

**Three runtime dependencies**, and §28 is why there are not more: `@hushjot/core`, `hash-wasm`
(Argon2id, transitively) and `@modelcontextprotocol/sdk`. Argument parsing is
`node:util.parseArgs`, HTTP is global `fetch`, the keychain is the OS binary, and the no-echo
passphrase prompt is thirty lines of raw-mode TTY handling. Prefer the platform before adding a
fourth.

## Invariants that are easy to break

- **Never assume a revision.** The wire `revision` counts writes the backend has *accepted*, and
  the rules enforce `incoming.revision == stored.revision + 1`. It is not the app's local
  per-keystroke counter. Assuming zero pushes revision 1, the compare-and-swap refuses it, the
  refusal reads as a conflict, and the note forks — every note, on a loop, which is a bug the app
  has actually had. Every write reads the document first and sends `stored + 1`.
- **A 403 on a read is checked for a pause before it is believed.** The app's cost kill switch
  releases rules that refuse every request, so during a lockdown every read is the same 403 an
  account without a plan gets. Those rules allow exactly one `get`, of `LOCKDOWN_SENTINEL` from
  core (`status/lockdown`), which the normal rules refuse; `FirestoreClient.#refused` makes that
  one request and throws `SyncPausedError` (exit 8, and the MCP tools' "paused for maintenance"
  text) when it is allowed, `SyncNotApprovedError` otherwise. A refused write reaches it through
  `write.ts`'s deciding read. `pending --wait` waits through a pause. The journey's step 16
  drives it against a lockdown ruleset built from the same constant.
- **A 403 on a write is ambiguous** and must be disambiguated by a second request. Firestore says
  "your revision is stale" and "you may not write here" with the same status. Reads carry no
  revision check, so a read that is *also* refused means authorisation. `rest.ts`'s `commit`
  returns `false` on a 403 rather than throwing, and `write.ts` makes the deciding read. Confusing
  the two forks the note on every retry, forever.
- **Nothing here may destroy text** (§16, §33.9). `push` only creates, under a fresh UUID, so it
  has no conflict case at all — it is the verb an agent should reach for. A rejected `append`
  retries against the *re-read* body (`APPEND_ATTEMPTS` times) because appending is
  order-insensitive; then it fails and says so. `replace` is the one overwrite, and it is
  undoable by construction: a compare-and-swap on the revision the *caller* read (never
  retried — re-applying a replace to newer text would discard the newer edit), and the stored
  `meta`/`body` copied byte for byte into `notes/{id}/versions/{sealIdOf(body)}` **in the same
  `commitAll`**, with the meter's `hist` moved by its charge and `lastDoc` naming the *version*
  (that is how the rules find both documents; a commit may carry at most one version). Split those into two commits and a
  refusal between them is an overwrite with nothing to restore. `tests/unit.test.ts` § "replace"
  and the journey's history check are the gates.
  **There is no `rm`, `mv` or `delete`**, and no tombstone writing: the rules refuse a hard delete
  outright, and deleting is an app decision with a Recently Deleted screen behind it.
- **The CLI is read-only on `users/{uid}/keys/primary`, always.** The rules permit create and
  update there and refuse delete, so a key record written from outside the app would be permanent
  and would lock out every browser device bound to the old one. Creating a vault is the app's job —
  it issues a recovery code that must be shown exactly once, and a terminal scrollback or an agent
  transcript is the wrong place for that. No vault means say so and stop.
- **Unwrapping is done by hand, not through `unlockWithPassphrase`.** That helper returns a
  *non-extractable* `CryptoKey`, right for a browser and wrong here — the whole point is to put raw
  bytes in the OS keychain so the next invocation does not pay ~95 ms of Argon2id. `vault.ts` calls
  `deriveKekFromPassphrase` and `open` directly, which is the same two steps, and keeps the bytes.
- **The cached DEK is named after a fingerprint of `wrappedByPassphrase`.** Changing the passphrase
  on *any* device re-randomises the salt and rewrites that blob, so the fingerprint changes, so the
  cache misses and the key is derived again. Invalidation is a consequence of the format, not a
  message somebody has to remember to send. Do not key it on anything else.
- **Ciphertext only on disk, and no token index.** `~/.hushjot/cache/<uid>/` holds rows
  byte-identical to Firestore's, so copying it gets someone exactly what a backend breach would and
  no more. The inverted index is rebuilt in memory on every search even though that is the slowest
  part of one: a serialised index is the words of every note in the clear, which is most of what the
  encryption was for. If the cost ever stops being acceptable the answer is a daemon, not a file.
  The cache is read-side only — writes go straight to Firestore, nothing is queued, and deleting the
  directory loses nothing.
- **Three wire details the rules will refuse silently if you get them wrong.** `syncedAt` must be a
  server transform (`:commit` with `updateTransforms`), never a timestamp the client sends — the
  rules require `syncedAt == request.time`, which stops a skewed clock from hiding writes from
  another device's cursor. **No `updateMask`**: the rules check the *resulting* document with
  `hasOnly`/`hasAll`, so every write is a full replace. And ciphertext is `bytesValue`, never
  `stringValue` (standard base64 *with* padding over REST, not base64url), so a client that forgot
  to encrypt fails loudly instead of quietly uploading readable notes.
- **Every note write moves the storage meter in the same commit.** `commit` sends a second write,
  a merge into `users/{uid}/usage/current` that increments `bytes` by `meterDelta(new, old)` (the
  change in stored `meta`+`body`, each document charged at least 1 KiB), increments `pn` (one push
  against the daily limit) and names the note in `lastDoc`. Path, month key and what counts come
  from core (`sync/usage.ts`). This is the one masked write, because the meter is merged into,
  never replaced. A wrong delta, or a missing push, means every write is refused. So measure on
  the document the compare-and-swap is against (`append` re-measures on each retry), and never
  move the meter outside the commit. Writes go through `commitMetered`, which answers one refusal
  itself: a full push window gets one retry as a reset (`ws` = the server's time), and a refused
  reset is `PushLimitError` — exit 5, with the time to retry. **Deploy order:** the rules with the `usage` block must be
  live before this CLI is used, or every write is refused as an unmatched path.
- **The delta pull needs one position per collection, and a document id in the cursor.** Notes and
  folders are separate queries with no shared snapshot; a single position let one collection's newest
  timestamp carry the cursor past documents the other had not delivered. And `serverTimestamp()` has
  millisecond resolution, so a burst gives several documents the same value and paginating on the
  timestamp alone skips ties that fall across a page boundary. The order is `(syncedAt, __name__)`,
  total, and the cursor is the last document of the page. Both lost documents permanently in the app
  before they were got right. `documentId()` is appended to every single-field index automatically,
  so this needs no composite index.
- **`sealNote` builds the meta payload field by field, so a caller that forgets a field deletes
  it.** Title and excerpt are derived from the text this process holds. The pin, the folder and the
  created date are not derivable from anything — they have to be read off the note and carried in,
  and `append` does exactly that. Drop one and the write is not merely missing it: it is removed
  from the note, on every device, permanently. This has cost data once already, as the excerpt (a
  blanked second line on every phone row of every note anyone pinned). `createdAt` is the newest
  member and is **optional**, because a note written before the field existed has none and inventing
  one would be a wrong date that syncs — omitted, the app resolves it from the note's `updatedAt`,
  which every device agrees on. `tests/unit.test.ts` § "append preserves the meta it did not write"
  is the gate.
- **The search grammar is core's, and `in:` cannot escape the scope.** `parseQuery` and
  `foldersMatching` come from `@hushjot/core` — `resolveFolder` here is a thin policy wrapper that
  errors on ambiguity, because a command about to act must ask while the app's search box narrows
  to all the matches. Reimplementing either would mean `in:work` selecting one folder in the
  browser and another in an agent's MCP call, with nothing reporting it. The containment is
  structural: `search` indexes only what `notesInScope` returned, so a query naming a folder
  outside `folderScopes` finds nothing because no such note was ever indexed. Keep it that way —
  resolving `in:` against the full folder list *before* scoping would hand an agent the whole
  vault through a query string. `tests/unit.test.ts` § "the search grammar" is the gate.
- **Never guess which note was meant.** Matching is exact id, then exact title case-insensitively,
  then unique title prefix — prefix last so it can never beat an exact match. Ambiguity is an error
  listing the candidates, because `append` is on the other side of it and appending to the wrong note
  is silent.
- **Every folder a caller names is resolved with `resolveInScope`, never `resolveFolder`.**
  `resolveFolder` is the unscoped resolver, for the operator's own scope entries. Using it on a
  tool argument is the hole `push` once had: a scoped agent could not read `Finance/` but could
  write into it by naming it. `resolveInScope` also drops out-of-scope candidates *before*
  reporting ambiguity or listing folders, so an error never enumerates what the agent cannot see.
  A scope entry that no longer resolves is `ScopeMissingError`, never skipped — skipping the last
  one would widen to the whole vault.
- **The MCP server is gated, scoped, and mute.** It refuses to start until `mcp enable` is run, once,
  by a person: installing a CLI must not silently expose every note to a model. It honours
  `folderScopes` for reads *and* writes, `--scope` narrows that per process and can never widen it,
  and `mcpReadOnly` both hides and refuses the write tools. A write tool forces the next call to
  re-pull, or `cat` after `replace` reports the old revision. And stdio MCP owns stdin and stdout,
  so **nothing in `src/mcp/` may print** and the passphrase cannot be prompted for — the key must
  already be in the keychain or in `HUSHJOT_PASSPHRASE`, and the check is made at startup so the
  failure is not inside a tool call. The scope is containment for the MCP tools, not a sandbox: an
  agent with a shell as the same user can reach the keychain, and the docs say so rather than
  implying otherwise.
- **The agent loop's state lives in the notes, and the agent only appends to the user's.** A note is
  answered when its last "Claude may continue." box is ticked; `take` acknowledges it by appending a
  receipt, checked inside `appendToNote`'s re-read (the `guard`) so the test and the compare-and-swap
  see the same revision; `reply` appends text plus a fresh box and refuses a ticked-but-untaken note.
  Keep this parsing in `gates.ts` rather than in the instructions: a model on a `/loop` cannot be
  trusted to remember which ticks it acted on, and the user should see the receipt on the phone.
  Instructions stay under 4096 characters (Claude Code truncates there; a unit test enforces it).
- **A passphrase is never read from a pipe.** `prompt.ts` throws when stdin is not a TTY rather than
  reading one, because a piped passphrase is a passphrase in a shell history. The supported
  non-interactive path is `HUSHJOT_PASSPHRASE` / `HUSHJOT_PASSWORD`, and that is the weaker option —
  an environment variable is readable by every process the session starts.
- **Secrets go in the OS keychain, config goes in a file.** `~/.hushjot/config.json` holds email
  and scope, none of it confidential. The Firebase project id and web API key are constants in
  `config.ts` (the key authorises nothing, every decision is made by the rules against the ID token);
  the file carries them only when `login --project/--api-key` overrides them, as the emulator does. The password, refresh token and DEK go
  through `keychain.ts` (`security` on macOS, `secret-tool` on Linux, Credential Manager on Windows
  via `powershell.exe` and `CredReadW`/`CredWriteW`, env vars as the fallback), via `execFile` with an
  argument array and never a shell. On Windows the secret goes on stdin, base64, never in argv. The one
  leak, written down rather than left to be discovered: on macOS the secret is an argv to `security`,
  so it is briefly visible to `ps`. The `environment` backend **persists nothing and must not throw**
  for the refresh token or a DEK — it once did, which made `login` and every command fail on any
  machine without a keychain. `HUSHJOT_SECRET_STORE` forces a backend; `tests/keychain.test.ts`
  (its own file, because it mocks `node:child_process`) is the gate.
- **`HUSHJOT_HOME` and the env overrides are read every time, never cached**, so a test can move the
  whole world between cases. Keep it that way.

## Tests

The two suites are split by what they can reach, and the division is deliberate:

- `tests/integration/journey.mjs` proves **protocol** — that the documents this CLI builds are shaped
  the way the real rules demand. Six constraints are invisible until a real rules engine refuses a
  real request, and each is asserted there. It logs in with the frozen key record from
  `@hushjot/core/contract/format-vectors.json`, so it proves the CLI unwraps bytes the *app* sealed
  rather than bytes this repo invented — standing in for "a browser created this vault", the one
  thing the CLI deliberately cannot do. `Bearer owner` is the emulator's admin credential, used to
  plant fixtures and to read back what was really stored; without it a ciphertext audit would 403 and
  "pass" by looking at nothing.
- `tests/unit.test.ts` covers what the journey cannot **force**: a compare-and-swap losing a race
  needs two writers, and a mis-advancing cursor needs a page boundary landing on a tie. Both are
  decisions that have cost data in the app's history, and both are exercised against stubs.

## Conventions

Modules open with a block comment explaining *why* the design is what it is — the trade-off
considered, the measurement that settled it, the bug the shape prevents. This repo is unusually
dense in them and they are load-bearing documentation; match that when adding a module, and update
one when a change invalidates it.
