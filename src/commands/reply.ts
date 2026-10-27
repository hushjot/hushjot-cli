/**
 * `hushjot reply` — write to the user in a thread note, and wait for them.
 *
 * Appends the text and then a fresh, unticked "Done. <agent> may continue." box,
 * so the user can answer under it and tick it from the phone. The box is added
 * here, not typed by the model, because the whole loop keys on its exact form.
 *
 * With no note named, it replies in the project's **Inbox**, creating it if
 * there is none: the one place an agent reports what it did and what it
 * suggests next, and the user asks for more.
 *
 * Replying to a note that is ticked but not yet taken is refused. The user's
 * request is above that box; burying it under a new one would make it look
 * answered when nobody read it.
 */
import { AmbiguousNoteError, describeAll, pickNote, type Candidate } from '../find.ts';
import { GateError, gateDone, gateState } from '../gates.ts';
import { appendToNote } from '../write.ts';
import { notesInScope, type Workspace } from '../workspace.ts';
import { push } from './push.ts';

export const INBOX_TITLE = 'Inbox';

export async function reply(
  workspace: Workspace,
  wanted: string | undefined,
  options: { text: string; folder?: string | undefined; json: boolean; agent?: string | undefined },
): Promise<string> {
  const body = options.text.trim();
  if (body === '') throw new GateError('Nothing to reply with.');
  const addition = `\n${body}\n\n${gateDone(options.agent)}\n`;

  const candidates = await describeAll(workspace, await notesInScope(workspace, undefined));
  let chosen: Candidate | undefined;
  if (wanted !== undefined) {
    chosen = pickNote(candidates, wanted);
  } else {
    // The Inbox by exact title only: a prefix match would happily reply in a
    // note the user called "Inbox ideas".
    const inboxes = candidates.filter((c) => c.title.toLowerCase() === INBOX_TITLE.toLowerCase());
    if (inboxes.length > 1) throw new AmbiguousNoteError(INBOX_TITLE, inboxes);
    chosen = inboxes[0];
  }

  if (chosen === undefined) {
    const created = JSON.parse(
      await push(workspace, { text: `# ${INBOX_TITLE}\n${addition}`, folder: options.folder, json: true }),
    ) as { id: string; title: string };
    return options.json
      ? JSON.stringify({ id: created.id, title: created.title, created: true }, null, 2)
      : `${created.id}  ${created.title}  (created)`;
  }

  const title = chosen.title;
  const result = await appendToNote(
    workspace.client,
    workspace.uid,
    workspace.key,
    chosen.sealed.id,
    addition,
    (content) => {
      if (gateState(content) === 'ready') {
        throw new GateError(
          `"${title}" is ticked and nobody has picked it up. hushjot_take it and act on it first.`,
        );
      }
    },
  );
  return options.json
    ? JSON.stringify({ id: result.id, title, revision: result.revision, created: false }, null, 2)
    : `${result.id}  ${title}  (revision ${result.revision})`;
}
