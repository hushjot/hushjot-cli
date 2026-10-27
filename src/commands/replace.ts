/**
 * `hushjot replace` — overwrite a note's text, keeping the old text in history.
 *
 * The revision is required, not defaulted. It is what turns "overwrite" into
 * "overwrite the version I read": without it the command could only mean
 * "whatever the note says now", which is the one meaning that loses an edit
 * made on another device in between. Read with `cat --json`, change, replace
 * with the revision `cat` reported. See `replaceNote` in `write.ts`.
 */
import { readFileSync } from 'node:fs';

import { describeAll, pickNote } from '../find.ts';
import { hasPipedInput, readStdin } from '../stdin.ts';
import { replaceNote } from '../write.ts';
import { notesInScope, type Workspace } from '../workspace.ts';

export interface ReplaceOptions {
  text?: string | undefined;
  file?: string | undefined;
  revision: number | undefined;
  json: boolean;
}

export async function replace(
  workspace: Workspace,
  wanted: string,
  options: ReplaceOptions,
): Promise<string> {
  if (options.revision === undefined || !Number.isInteger(options.revision) || options.revision < 1) {
    throw new Error(
      'replace needs the revision the note was read at (--revision N, from `hushjot cat --json`), ' +
        'so that an edit made elsewhere since then is not overwritten.',
    );
  }

  const content = options.file
    ? readFileSync(options.file, 'utf8')
    : (options.text ?? (hasPipedInput() ? await readStdin() : ''));
  if (content.trim() === '') {
    throw new Error('Nothing to replace with. An empty note is a deletion, and this tool does not delete.');
  }

  // Resolved inside the scope, as `append` is.
  const scoped = await notesInScope(workspace, undefined);
  const chosen = pickNote(await describeAll(workspace, scoped), wanted);

  const result = await replaceNote(
    workspace.client,
    workspace.uid,
    workspace.key,
    chosen.sealed.id,
    content,
    options.revision,
  );

  return options.json
    ? JSON.stringify(result, null, 2)
    : `${result.id}  ${result.title}  (revision ${result.revision}; the previous text is in History)`;
}
