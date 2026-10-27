#!/usr/bin/env node
/**
 * The command line.
 *
 * Argument parsing is `node:util.parseArgs`. A CLI framework would be a
 * dependency, a startup cost on every invocation, and a lot of machinery for
 * six verbs — §28 of the spec says prefer the platform, and here the platform
 * is enough.
 *
 * **Errors are translated once, here.** Everything below throws a typed error
 * and says nothing; this is the only place that decides what a person reads and
 * what the exit code is. The reason is that the same failure has to make sense
 * to two audiences — someone at a terminal who can go and get a sync plan,
 * and an agent that needs to know whether retrying is worth anything.
 * Exit codes carry that second meaning: 4 is "your fault, fixable", 5 is
 * "transient, retry", 6 is "conflict, re-read and try again", 8 is "the
 * service is paused for maintenance, try later" — retryable like 5, but on a
 * scale of hours rather than seconds, and nothing an agent should loop on.
 *
 * There is no `rm`, no `mv`, and no `delete`. The rules refuse a hard delete
 * outright and deleting is an app decision with a Recently Deleted screen
 * behind it. The one verb that overwrites, `replace`, uploads the text it
 * replaces to History first, in the same commit. Verbs that cannot lose
 * anything is the design.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  DAILY_PUSH_LIMIT,
  PushLimitError,
  QuotaExceededError,
  RevisionConflictError,
  SessionExpiredError,
  SyncNotApprovedError,
  SyncPausedError,
  TransientSyncError,
  WrongSecretError,
} from '@hushjot/core';

import { append } from '../commands/append.ts';
import { cat } from '../commands/cat.ts';
import { login } from '../commands/login.ts';
import { ls } from '../commands/ls.ts';
import { mkdir } from '../commands/mkdir.ts';
import { parseInterval, pending, waitForReady } from '../commands/pending.ts';
import { push } from '../commands/push.ts';
import { replace } from '../commands/replace.ts';
import { reply } from '../commands/reply.ts';
import { search } from '../commands/search.ts';
import { take } from '../commands/take.ts';
import { NotConfiguredError, configPath, loadConfig, saveConfig, stateDir } from '../config.ts';
import { AmbiguousNoteError, NoteNotFoundError } from '../find.ts';
import { GateError, checkAgentName } from '../gates.ts';
import { backend } from '../keychain.ts';
import { NotATerminalError } from '../prompt.ts';
import { hasPipedInput, readStdin } from '../stdin.ts';
import { NoVaultError } from '../vault.ts';
import { NoteMissingError, WriteRefusedError } from '../write.ts';
import {
  OutsideScopeError,
  ScopeMissingError,
  UnknownFolderError,
  openWorkspace,
} from '../workspace.ts';

const USAGE = `hushjot — your encrypted notes, from the terminal.

  hushjot login                     Sign in and unlock this machine
  hushjot ls [--folder F]           List notes, pinned first
  hushjot cat <note>                Print one note's Markdown
  hushjot search <query>            Full-text search (see Search syntax below)
  hushjot push [text]               Create a note (also reads stdin, or --file)
  hushjot append <note> [text]      Add text to the end of a note
  hushjot replace <note> [text] --revision N
                                    Overwrite a note; the old text goes to History
  hushjot mkdir <path>              Create a folder (and any missing parents)
  hushjot pending                   Notes whose "… may continue." box is
                                    ticked (ready) or not yet (waiting)
  hushjot pending --wait [--every T]
                                    Block until a note is ready, then exit 0
  hushjot take <note>               Pick up a ready note: mark it and print it
  hushjot reply [note] [text]       Append to a note (default: Inbox) and end
                                    with a fresh "Done. Claude may continue." box
  hushjot status                    What this machine is configured for
  hushjot scope                     Show the folders commands are confined to
  hushjot scope <folder>            Confine every command to exactly this folder
  hushjot scope add|rm <folder>     Add or remove one scope folder
  hushjot scope clear               Remove the scope: the whole vault
  hushjot logout                    Forget the key and the credentials
  hushjot mcp enable [--read-only]  Permit the MCP server (read-only: no writes)
  hushjot mcp disable               Forbid it again
  hushjot mcp [--scope F ...]       Run it, optionally narrowed to folder(s) F
            [--agent NAME]          and naming the agent in boxes (default Claude)

A <note> is an id, a title, or an unambiguous prefix of a title.

  --folder F      Limit to a folder (name, path or id)
  --parent F      mkdir: create under this folder
  --revision N    replace: the revision the note was read at (cat --json)
  --agent NAME    mcp, take, reply: the name in boxes and receipts, e.g. Codex
  --every T       pending --wait: how often to check, e.g. 30s, 2m (default 2m)
  --limit N       Cap the rows returned            (default 50)
  --file PATH     Take the text from a file
  --json          Machine-readable output
  --help          This text

Search syntax (the same grammar as the app's search box):

  word          matches as a prefix; every term must match
  #tag          notes tagged tag, or nested under it
  in:Work/DB    notes in that folder and everything under it; in:/ is unfiled
                quote a name with spaces: in:"My Work"
  "exact words" a literal phrase — and the way to search for a leading # or -
  -x            exclude; works on any of the above (-draft, -#work, -in:Old)

The vault passphrase is never stored. The derived key is kept in your OS
keychain so that repeated commands do not re-run Argon2id. Nothing is ever
sent anywhere but your own Firestore, and only ever as ciphertext.`;

/** Exit codes an agent can branch on. See the header. */
const EXIT = { usage: 2, notConfigured: 3, user: 4, transient: 5, conflict: 6, internal: 7, paused: 8 };

function describe(error: unknown): { message: string; code: number } {
  if (error instanceof NotConfiguredError) {
    return { message: `${error.message}`, code: EXIT.notConfigured };
  }
  // Before non-approval: a pause is the same refusal, already told apart by
  // `rest.ts`, and "no active sync plan" is exactly the wrong thing to tell a
  // paying user while the service is paused.
  if (error instanceof SyncPausedError) {
    return {
      message:
        'HushJot sync is paused for maintenance; try later.\n' +
        'Nothing was changed. Your plan is not affected, and the same command works once sync resumes.',
      code: EXIT.paused,
    };
  }
  if (error instanceof SyncNotApprovedError) {
    return {
      message:
        'That account has no active sync plan.\n' +
        'Get one at https://hushjot.com/account, or ask for an invitation.',
      code: EXIT.user,
    };
  }
  if (error instanceof WrongSecretError) {
    return { message: 'That passphrase does not open this vault.', code: EXIT.user };
  }
  if (error instanceof SessionExpiredError) {
    return { message: 'The session has expired. Run `hushjot login` again.', code: EXIT.user };
  }
  if (error instanceof QuotaExceededError) {
    const mb = (n: number) => `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
    const where =
      error.used !== null && error.quota !== null ? ` (${mb(error.used)} of ${mb(error.quota)} used)` : '';
    return {
      message:
        `Sync storage is full${where}, so nothing was written.\n` +
        'Free up space by deleting notes in the app, or add storage at https://hushjot.com/account.',
      code: EXIT.user,
    };
  }
  if (error instanceof PushLimitError) {
    // Transient in the exit-code sense — retrying works, just not yet — and
    // the message says when, so an agent can decide whether to wait.
    const when = error.retryAt === null ? 'within a day' : `after ${new Date(error.retryAt).toISOString()}`;
    return {
      message:
        `The daily sync limit is reached: this account has synced ${DAILY_PUSH_LIMIT.toLocaleString('en-US')} ` +
        'changes in the last day, ' +
        `so nothing was written.\nTry again ${when}. Notes already synced are unaffected.`,
      code: EXIT.transient,
    };
  }
  if (error instanceof RevisionConflictError) {
    return {
      message:
        `${error.message}\nAnother device is writing to that note. Nothing was changed ` +
        'and no text was lost — read it again and retry.',
      code: EXIT.conflict,
    };
  }
  if (error instanceof TransientSyncError) {
    return { message: `Temporarily unavailable: ${error.message}`, code: EXIT.transient };
  }
  if (
    error instanceof NoVaultError ||
    error instanceof UnknownFolderError ||
    error instanceof OutsideScopeError ||
    error instanceof ScopeMissingError ||
    error instanceof NoteNotFoundError ||
    error instanceof AmbiguousNoteError ||
    error instanceof NoteMissingError ||
    error instanceof WriteRefusedError ||
    error instanceof NotATerminalError ||
    error instanceof GateError
  ) {
    return { message: error.message, code: EXIT.user };
  }
  return { message: error instanceof Error ? error.message : String(error), code: EXIT.internal };
}

async function status(): Promise<string> {
  const config = loadConfig();
  return [
    `Account      ${config.email}`,
    `Project      ${config.projectId}`,
    `Folder scope ${config.folderScopes.length ? config.folderScopes.join(', ') : '(whole vault)'}`,
    `MCP server   ${
      config.mcpEnabled
        ? config.mcpReadOnly
          ? 'enabled, read-only'
          : 'enabled'
        : 'disabled — run `hushjot mcp enable`'
    }`,
    `Secrets in   ${backend()}`,
    `State in     ${stateDir()}`,
    `Config       ${configPath()}`,
  ].join('\n');
}

async function logout(): Promise<string> {
  const config = loadConfig();
  const { forgetVault } = await import('../vault.ts');
  // Forget the credentials unconditionally. The cached key is named after the
  // key record, which needs a network round trip to fetch — so if that is not
  // available, fall back to clearing what can be cleared and say so.
  try {
    const { currentSession } = await import('../auth.ts');
    const { FirestoreClient } = await import('../rest.ts');
    const { fetchKeyRecord } = await import('../vault.ts');
    const session = await currentSession(config);
    const record = await fetchKeyRecord(new FirestoreClient(config, session.idToken), session.uid);
    forgetVault(config, record);
  } catch {
    forgetVault(config, null);
    return 'Credentials forgotten. The cached key could not be located (offline?) — run `hushjot logout` again when online, or remove the "hushjot" items from your keychain by hand.';
  }
  return 'Forgotten: the cached key, the refresh token and the password. Your notes are untouched.';
}

async function mcp(
  action: string | undefined,
  options: { readOnly: boolean; scopes: readonly string[]; agent: string | undefined },
): Promise<string | null> {
  const config = loadConfig();
  if (action === 'enable' || action === 'disable') {
    const enable = action === 'enable';
    saveConfig({ ...config, mcpEnabled: enable, mcpReadOnly: enable && options.readOnly });
    if (!enable) return 'MCP server disabled.';
    return [
      `MCP server enabled${options.readOnly ? ', read-only (search, cat, ls)' : ''}. Register it with:`,
      '  claude mcp add hushjot -- hushjot mcp',
      'or, to give one project one folder:',
      '  claude mcp add hushjot -- hushjot mcp --scope "Projects/my-app"',
      'For Codex, Copilot, Gemini, Grok or Cursor, add `--agent <Name>` and see',
      'docs/agents.md for that client\'s setup.',
      config.folderScopes.length
        ? `It will see only ${config.folderScopes.map((f) => `"${f}"`).join(', ')}.`
        : 'It will see every note in your vault. `hushjot scope <folder>` narrows that.',
      'The scope keeps an agent on task; it does not sandbox one that can also run shell',
      'commands as you. Deny `hushjot` in its shell permissions — see the README.',
    ].join('\n');
  }
  if (action !== undefined) throw new Error(`Unknown: hushjot mcp ${action}`);

  const { serve } = await import('../mcp/server.ts');
  await serve({ scopes: options.scopes, agent: options.agent });
  return null; // serve() owns the process from here.
}

/**
 * `hushjot scope`, in its forms. Entries are stored as typed and resolved on
 * every use (see `folderScopes` in `config.ts`), so setting one needs no
 * network and a typo surfaces on the next command, as an error.
 */
function scope(args: readonly string[]): string {
  const config = loadConfig();
  const [verb, ...rest] = args;
  const folder = rest.join(' ').trim();
  const show = (scopes: readonly string[]) =>
    scopes.length === 0
      ? 'No scope: commands and the MCP server see the whole vault.'
      : `Commands and the MCP server see only: ${scopes.map((f) => `"${f}"`).join(', ')}.`;

  switch (verb) {
    case undefined:
    case 'ls':
      return show(config.folderScopes);
    case 'clear':
      saveConfig({ ...config, folderScopes: [] });
      return `Scope cleared. ${show([])}`;
    case 'add': {
      if (!folder) throw Object.assign(new Error('hushjot scope add needs a folder'), { exitCode: EXIT.usage });
      const next = config.folderScopes.some((f) => f.toLowerCase() === folder.toLowerCase())
        ? config.folderScopes
        : [...config.folderScopes, folder];
      saveConfig({ ...config, folderScopes: next });
      return show(next);
    }
    case 'rm': {
      if (!folder) throw Object.assign(new Error('hushjot scope rm needs a folder'), { exitCode: EXIT.usage });
      const next = config.folderScopes.filter((f) => f.toLowerCase() !== folder.toLowerCase());
      if (next.length === config.folderScopes.length) throw new Error(`"${folder}" is not a scope folder.`);
      // Removing the last one widens to the whole vault, which is a decision
      // rather than a side effect of tidying up.
      if (next.length === 0) {
        throw new Error(
          `"${folder}" is the only scope folder, and removing it would expose the whole vault. ` +
            'Use `hushjot scope clear` if that is what you mean.',
        );
      }
      saveConfig({ ...config, folderScopes: next });
      return show(next);
    }
    case 'set':
      if (!folder) throw Object.assign(new Error('hushjot scope set needs a folder'), { exitCode: EXIT.usage });
      saveConfig({ ...config, folderScopes: [folder] });
      return show([folder]);
    default: {
      const only = args.join(' ').trim();
      saveConfig({ ...config, folderScopes: [only] });
      return show([only]);
    }
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      folder: { type: 'string' },
      parent: { type: 'string' },
      revision: { type: 'string' },
      scope: { type: 'string', multiple: true },
      agent: { type: 'string' },
      wait: { type: 'boolean', default: false },
      every: { type: 'string' },
      'read-only': { type: 'boolean', default: false },
      limit: { type: 'string' },
      file: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false, short: 'h' },
      project: { type: 'string' },
      'api-key': { type: 'string' },
      email: { type: 'string' },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const limit = values.limit === undefined ? 50 : Number(values.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw Object.assign(new Error('--limit must be a positive number'), { exitCode: EXIT.usage });
  }
  const json = values.json === true;
  const agent = values.agent === undefined ? undefined : checkAgentName(values.agent);

  const need = (what: string): string => {
    const value = rest[0];
    if (value === undefined) {
      throw Object.assign(new Error(`hushjot ${command} needs ${what}`), { exitCode: EXIT.usage });
    }
    return value;
  };

  switch (command) {
    case 'login':
      process.stdout.write(
        `${await login({
          project: values.project,
          apiKey: values['api-key'],
          email: values.email,
          folderScope: values.folder,
        })}\n`,
      );
      return;

    case 'status':
      process.stdout.write(`${await status()}\n`);
      return;

    case 'logout':
      process.stdout.write(`${await logout()}\n`);
      return;

    case 'scope':
      process.stdout.write(`${scope(rest)}\n`);
      return;

    case 'mcp': {
      const message = await mcp(rest[0], {
        readOnly: values['read-only'] === true,
        scopes: values.scope ?? [],
        agent,
      });
      if (message !== null) process.stdout.write(`${message}\n`);
      return;
    }

    case 'ls':
      process.stdout.write(
        `${await ls(await openWorkspace(), { folder: values.folder, limit, json })}\n`,
      );
      return;

    case 'cat': {
      const wanted = need('a note');
      // No trailing newline: `cat` hands back the note's bytes, and an agent
      // diffing what it reads against what it wrote should see them match.
      process.stdout.write(await cat(await openWorkspace(), wanted, { json }));
      return;
    }

    case 'search':
      process.stdout.write(
        `${await search(await openWorkspace(), need('a query'), {
          folder: values.folder,
          limit,
          json,
        })}\n`,
      );
      return;

    case 'push':
      process.stdout.write(
        `${await push(await openWorkspace(), {
          text: rest.join(' ') || undefined,
          file: values.file,
          folder: values.folder,
          json,
        })}\n`,
      );
      return;

    case 'append': {
      const wanted = need('a note');
      process.stdout.write(
        `${await append(await openWorkspace(), wanted, {
          text: rest.slice(1).join(' ') || undefined,
          file: values.file,
          json,
        })}\n`,
      );
      return;
    }

    case 'replace': {
      const wanted = need('a note');
      const revision = values.revision === undefined ? undefined : Number(values.revision);
      process.stdout.write(
        `${await replace(await openWorkspace(), wanted, {
          text: rest.slice(1).join(' ') || undefined,
          file: values.file,
          revision,
          json,
        })}\n`,
      );
      return;
    }

    case 'pending':
      if (values.wait) {
        let every: number;
        try {
          every = parseInterval(values.every ?? '2m');
        } catch (error) {
          throw Object.assign(error as Error, { exitCode: EXIT.usage });
        }
        process.stdout.write(
          `${await waitForReady(() => openWorkspace(), { folder: values.folder, every, json })}\n`,
        );
        return;
      }
      process.stdout.write(
        `${await pending(await openWorkspace(), { folder: values.folder, json })}\n`,
      );
      return;

    case 'take':
      process.stdout.write(`${await take(await openWorkspace(), need('a note'), { json, agent })}\n`);
      return;

    case 'reply': {
      // `reply "text"` goes to the Inbox; `reply <note> "text"` to that note.
      // With --file or stdin, a single argument is the note.
      const fromElsewhere = values.file !== undefined || hasPipedInput();
      const [note, ...words] = fromElsewhere || rest.length > 1 ? rest : [undefined, ...rest];
      const body = values.file
        ? readFileSync(values.file, 'utf8')
        : words.length > 0
          ? words.join(' ')
          : fromElsewhere
            ? await readStdin()
            : '';
      process.stdout.write(
        `${await reply(await openWorkspace(), note, { text: body, folder: values.folder, json, agent })}\n`,
      );
      return;
    }

    case 'mkdir':
      process.stdout.write(
        `${await mkdir(await openWorkspace(), rest.join(' ') || need('a folder name or path'), {
          parent: values.parent,
          json,
        })}\n`,
      );
      return;

    default:
      throw Object.assign(new Error(`Unknown command "${command}".\n\n${USAGE}`), {
        exitCode: EXIT.usage,
      });
  }
}

try {
  await main();
} catch (error) {
  const explicit = (error as { exitCode?: number }).exitCode;
  const { message, code } = describe(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = explicit ?? code;
}
