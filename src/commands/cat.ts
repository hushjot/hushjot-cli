/**
 * `hushjot cat` — one note's Markdown on stdout.
 *
 * The body is fetched from the cache, not from Firestore, and then the cache
 * has already been refreshed by `openWorkspace` — so this is current without
 * costing a read per note. Output is the note's text byte-for-byte: no header,
 * no trailing newline added, nothing an agent would have to strip.
 */
import { describeAll, pickNote } from '../find.ts';
import { openNote } from '../notes.ts';
import { notesInScope, type Workspace } from '../workspace.ts';

export async function cat(
  workspace: Workspace,
  wanted: string,
  options: { json: boolean },
): Promise<string> {
  const scoped = await notesInScope(workspace, undefined);
  const chosen = pickNote(await describeAll(workspace, scoped), wanted);
  const note = await openNote(workspace.key, chosen.sealed);

  if (!options.json) return note.content;

  return JSON.stringify(
    {
      id: note.id,
      title: note.title,
      folderId: note.folderId,
      pinned: note.pinnedAt !== null,
      revision: note.revision,
      updatedAt: new Date(note.updatedAt).toISOString(),
      content: note.content,
    },
    null,
    2,
  );
}
