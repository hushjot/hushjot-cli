/**
 * `hushjot push` — put text into the vault as a new note.
 *
 * The verb an agent should reach for. It creates a fresh UUID at revision 1, so
 * it cannot collide with anything and cannot fork a note; the app picks it up
 * on its next pull and writes it with no conflict.
 *
 * The title is not a flag. It is derived from the first line of the content by
 * the same `deriveTitle` the app uses — that is what makes a note pushed from a
 * terminal look identical to one typed in the browser, and why the CLI must not
 * be allowed to invent its own idea of a title.
 */
import { readFileSync } from 'node:fs';

import { hasPipedInput, readStdin } from '../stdin.ts';
import { createNote } from '../write.ts';
import {
  allowedFolderIds,
  folders,
  resolveFolder,
  resolveInScope,
  type Workspace,
} from '../workspace.ts';

export interface PushOptions {
  text?: string | undefined;
  file?: string | undefined;
  folder?: string | undefined;
  json: boolean;
}

export async function push(workspace: Workspace, options: PushOptions): Promise<string> {
  const content = options.file
    ? readFileSync(options.file, 'utf8')
    : (options.text ?? (hasPipedInput() ? await readStdin() : ''));

  if (content.trim() === '') {
    throw new Error(
      'Nothing to push. Give the text as an argument, pipe it in, or pass --file.',
    );
  }

  // The configured folder scope is the default, not just a filter: with an
  // MCP server confined to a folder, a note it pushes belongs in that folder
  // rather than at the root where the scope would then hide it. With several
  // scope folders there is no obvious default, so the caller must name one.
  //
  // An explicit folder is resolved *within* the scope. Resolving it against
  // every folder was a hole: an agent confined to `Agents/` could not read
  // `Finance/` but could write into it by naming it.
  const all = await folders(workspace);
  const allowed = allowedFolderIds(workspace, all);
  const scopes = workspace.config.folderScopes;
  let folderId: string | null;
  if (options.folder !== undefined) {
    folderId = resolveInScope(all, allowed, options.folder);
  } else if (scopes.length === 1) {
    folderId = resolveFolder(all, scopes[0]!);
  } else if (scopes.length > 1) {
    throw new Error(
      'This machine is scoped to more than one folder, so say which one the note goes in ' +
        '(--folder, or the folder argument of hushjot_push).',
    );
  } else {
    folderId = null;
  }

  const created = await createNote(
    workspace.client,
    workspace.uid,
    workspace.key,
    content,
    folderId,
  );

  return options.json
    ? JSON.stringify(created, null, 2)
    : `${created.id}  ${created.title}`;
}
