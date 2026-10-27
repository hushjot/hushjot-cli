/**
 * `hushjot ls` — the note list, in the order the app shows it.
 *
 * Opens meta only. A thousand notes is a thousand small AES-GCM opens and no
 * bodies at all, which is the same trade `loadAllMeta` makes in the app: the
 * body store is a separate place that a listing deliberately never touches.
 */
import { folderPath, type Folder } from '@hushjot/core';

import { describeAll } from '../find.ts';
import { folders, notesInScope, type Workspace } from '../workspace.ts';

export interface LsOptions {
  folder?: string | undefined;
  limit: number;
  json: boolean;
}

export async function ls(workspace: Workspace, options: LsOptions): Promise<string> {
  const all = await folders(workspace);
  const scoped = await notesInScope(workspace, options.folder);
  const described = (await describeAll(workspace, scoped)).slice(0, options.limit);

  const pathOf = (id: string | null) =>
    id === null ? '' : folderPath(all as readonly Folder[], id, '/');

  if (options.json) {
    return JSON.stringify(
      described.map((c) => ({
        id: c.sealed.id,
        title: c.title,
        folder: pathOf(c.folderId),
        pinned: c.pinnedAt !== null,
        updatedAt: new Date(c.sealed.updatedAt).toISOString(),
        excerpt: c.excerpt,
      })),
      null,
      2,
    );
  }

  if (described.length === 0) return 'No notes.';

  // Pad the title column to the longest actually shown rather than a constant,
  // so a vault of short titles does not print a field of spaces.
  const width = Math.min(48, Math.max(...described.map((c) => c.title.length)));
  return described
    .map((c) => {
      const pin = c.pinnedAt !== null ? '*' : ' ';
      const folder = pathOf(c.folderId);
      return `${pin} ${c.title.padEnd(width)}  ${c.sealed.id}${folder ? `  ${folder}` : ''}`;
    })
    .join('\n');
}
