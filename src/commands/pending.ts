/**
 * `hushjot pending` — which notes are waiting on the user, and which on you.
 *
 * The first call of every `/loop` tick. Without it the model reads every note
 * in the project to find out whether anything changed, every fifteen minutes,
 * and decides from memory whether it has already acted on a ticked box. With
 * it, one call answers both, and "nothing is ready" means end the turn.
 *
 * It opens bodies, unlike `ls`, because a gate is the last checkbox of the
 * text. That is affordable for the scoped project folder this is meant for.
 *
 * `--wait` is the loop for agents that have none. Claude Code and Grok Build
 * can re-prompt themselves every fifteen minutes; Codex, Gemini, Antigravity
 * and Cursor cannot, but all of them have a headless mode. So the waiting is
 * done here, by the person's own shell, at no model cost:
 *
 *     while hushjot pending --wait; do codex exec resume --last "Continue."; done
 *
 * It opens a fresh workspace on every check rather than holding one, because
 * an ID token lasts an hour and a wait can last a day, and it shrugs off a
 * network failure, because a laptop that sleeps loses the network and should
 * not end the loop for it. Anything else — signed out, scope gone — ends it.
 */
import { SessionExpiredError, SyncPausedError, TransientSyncError, folderPath, type Folder } from '@hushjot/core';

import { AuthError } from '../auth.ts';

import { describeAll } from '../find.ts';
import { gateState } from '../gates.ts';
import { openNote } from '../notes.ts';
import { folders, notesInScope, type Workspace } from '../workspace.ts';

export async function pending(
  workspace: Workspace,
  options: { folder?: string | undefined; json: boolean },
): Promise<string> {
  const all = await folders(workspace);
  const scoped = await notesInScope(workspace, options.folder);
  const described = await describeAll(workspace, scoped);

  const rows: { id: string; title: string; folder: string; state: 'ready' | 'waiting'; updatedAt: string }[] = [];
  for (const candidate of described) {
    const note = await openNote(workspace.key, candidate.sealed);
    const state = gateState(note.content);
    if (state !== 'ready' && state !== 'waiting') continue;
    rows.push({
      id: note.id,
      title: candidate.title,
      folder: candidate.folderId === null ? '' : folderPath(all as readonly Folder[], candidate.folderId, '/'),
      state,
      updatedAt: new Date(note.updatedAt).toISOString(),
    });
  }
  // Ready first: those are the ones to act on.
  rows.sort((a, b) => (a.state === b.state ? 0 : a.state === 'ready' ? -1 : 1));

  if (options.json) {
    const ready = rows.filter((r) => r.state === 'ready').length;
    return JSON.stringify(
      {
        ready,
        summary:
          ready === 0
            ? 'Nothing is ready. Do not act on any note; end your turn.'
            : `${ready} note(s) ready. hushjot_take each one before acting on it.`,
        notes: rows,
      },
      null,
      2,
    );
  }

  if (rows.length === 0) return 'Nothing is waiting on anyone.';
  return rows.map((r) => `${r.state.padEnd(7)}  ${r.title}  ${r.id}${r.folder ? `  ${r.folder}` : ''}`).join('\n');
}

/** "30s", "2m", "1h" (or plain seconds) to milliseconds. At least thirty seconds. */
export function parseInterval(text: string): number {
  const match = /^(\d+)\s*(s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not an interval. Use a number with s, m or h, as in 2m.`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? 's') as 's' | 'm' | 'h'];
  const ms = Number(match[1]!) * unit;
  if (ms < 30_000) throw new Error('--every must be at least 30s.');
  return ms;
}

/** Blocks until a note in scope is ready, then returns what `pending` says about it. */
export async function waitForReady(
  open: () => Promise<Workspace>,
  options: {
    folder?: string | undefined;
    every: number;
    json: boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      const workspace = await open();
      const report = JSON.parse(await pending(workspace, { folder: options.folder, json: true })) as {
        ready: number;
      };
      if (report.ready > 0) return pending(workspace, { folder: options.folder, json: options.json });
    } catch (error) {
      // A pause (the cost kill switch) ends by itself too, so waiting through
      // it is right: the loop's own interval keeps the probes rare.
      const offline =
        error instanceof TransientSyncError ||
        error instanceof SyncPausedError ||
        error instanceof SessionExpiredError ||
        (error instanceof AuthError && error.code === 'NETWORK');
      if (!offline) throw error;
    }
    await sleep(options.every);
  }
}
