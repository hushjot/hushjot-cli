/**
 * `hushjot append` — add text to the end of an existing note.
 *
 * The only read-modify-write in the tool, and therefore the only place the
 * compare-and-swap can refuse. `appendToNote` re-reads and re-appends on a
 * genuine conflict and gives up rather than overwriting; see `write.ts`.
 */
import { readFileSync } from 'node:fs';

import { describeAll, pickNote } from '../find.ts';
import { hasPipedInput, readStdin } from '../stdin.ts';
import { appendToNote } from '../write.ts';
import { notesInScope, type Workspace } from '../workspace.ts';

export interface AppendOptions {
  text?: string | undefined;
  file?: string | undefined;
  json: boolean;
}

export async function append(
  workspace: Workspace,
  wanted: string,
  options: AppendOptions,
): Promise<string> {
  const addition = options.file
    ? readFileSync(options.file, 'utf8')
    : (options.text ?? (hasPipedInput() ? await readStdin() : ''));

  if (addition === '') {
    throw new Error(
      'Nothing to append. Give the text as an argument, pipe it in, or pass --file.',
    );
  }

  // Resolve against the scope, so an MCP server confined to one folder cannot
  // be talked into appending to a note outside it by passing a title.
  const scoped = await notesInScope(workspace, undefined);
  const chosen = pickNote(await describeAll(workspace, scoped), wanted);

  const result = await appendToNote(
    workspace.client,
    workspace.uid,
    workspace.key,
    chosen.sealed.id,
    addition,
  );

  return options.json
    ? JSON.stringify({ ...result, title: chosen.title }, null, 2)
    : `${result.id}  ${chosen.title}  (+${result.bytesAdded} bytes, revision ${result.revision})`;
}
