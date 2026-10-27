/**
 * `hushjot take` — pick up a note whose "… may continue." box is ticked.
 *
 * Appends a receipt straight after the ticked gate and returns the note. The
 * receipt is the agent's memory that it has acted on this tick (so a second
 * `/loop` run, or a second session, is refused), and it is the user's sign on
 * the phone that the agent has it. It is an append, so it never overwrites a
 * word the user typed; and the "is it still ready?" check runs on the text the
 * compare-and-swap is against, inside `appendToNote`, not on a cached copy.
 */
import { describeAll, pickNote } from '../find.ts';
import { GateError, gateState, notReady, receiptLine } from '../gates.ts';
import { openNote } from '../notes.ts';
import { appendToNote } from '../write.ts';
import { notesInScope, refresh, type Workspace } from '../workspace.ts';

export async function take(
  workspace: Workspace,
  wanted: string,
  options: { json: boolean; now?: Date; agent?: string | undefined },
): Promise<string> {
  const scoped = await notesInScope(workspace, undefined);
  const chosen = pickNote(await describeAll(workspace, scoped), wanted);

  const result = await appendToNote(
    workspace.client,
    workspace.uid,
    workspace.key,
    chosen.sealed.id,
    `\n${receiptLine(options.now ?? new Date(), options.agent)}\n`,
    (content) => {
      const state = gateState(content);
      if (state !== 'ready') throw new GateError(notReady(chosen.title, state, options.agent));
    },
  );

  // Return what the note says now, receipt included, at the revision the
  // append produced: a following `replace` (revising a plan) needs it.
  await refresh(workspace);
  const after = pickNote(
    await describeAll(workspace, await notesInScope(workspace, undefined)),
    chosen.sealed.id,
  );
  const note = await openNote(workspace.key, after.sealed);

  return options.json
    ? JSON.stringify(
        {
          id: note.id,
          title: note.title,
          revision: result.revision,
          updatedAt: new Date(note.updatedAt).toISOString(),
          content: note.content,
        },
        null,
        2,
      )
    : note.content;
}
