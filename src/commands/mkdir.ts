/**
 * `hushjot mkdir` — make a folder, and any missing folders above it.
 *
 * `-p` semantics without the flag: a folder that already exists along the path
 * is reused, not duplicated. An agent laying out `Docs/Architecture` should be
 * able to say so twice without leaving two `Docs` folders behind it, because
 * two folders of one name are the ambiguity every resolver here refuses to
 * guess through — the second call would make the first unreachable by name.
 *
 * Where the path starts, in order:
 *
 * - `--parent` (`parent` over MCP), resolved inside the scope;
 * - otherwise the longest leading part of the path that already names a folder
 *   inside the scope (`new-app/Docs/Architecture` under an existing `new-app`);
 * - otherwise the scope folder, when there is exactly one;
 * - otherwise the top level, when there is no scope at all.
 *
 * A leading part that only matches a folder *outside* the scope counts as not
 * found, so the whole path is created under the scope folder. Refusing instead
 * would block the ordinary case — `Docs` in this project while another project
 * also has a `Docs` — and would tell the agent that the other one exists. What
 * matters is that everything created lands inside the scope, and it does.
 */
import type { Folder } from '@hushjot/core';
import { folderPath } from '@hushjot/core';

import { createFolderRecord } from '../write.ts';
import {
  OutsideScopeError,
  UnknownFolderError,
  allowedFolderIds,
  folders,
  refresh,
  resolveFolder,
  resolveInScope,
  type Workspace,
} from '../workspace.ts';

export interface MkdirOptions {
  parent?: string | undefined;
  json: boolean;
}

export async function mkdir(workspace: Workspace, path: string, options: MkdirOptions): Promise<string> {
  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (segments.length === 0) throw new Error('mkdir needs a folder name or path.');
  if (segments.some((s) => s.length > 200)) throw new Error('A folder name is limited to 200 characters.');

  const all = await folders(workspace);
  const allowed = allowedFolderIds(workspace, all);
  const scopes = workspace.config.folderScopes;

  let parentId: string | null;
  let rest = segments;
  if (options.parent !== undefined) {
    parentId = resolveInScope(all, allowed, options.parent);
  } else {
    let found: { id: string; used: number } | null = null;
    for (let used = segments.length; used >= 1 && !found; used--) {
      try {
        found = { id: resolveInScope(all, allowed, segments.slice(0, used).join('/')), used };
      } catch (error) {
        if (!(error instanceof UnknownFolderError || error instanceof OutsideScopeError)) throw error;
      }
    }
    if (found) {
      parentId = found.id;
      rest = segments.slice(found.used);
    } else if (scopes.length === 1) {
      parentId = resolveFolder(all, scopes[0]!);
    } else if (scopes.length > 1) {
      throw new Error(
        'This machine is scoped to more than one folder, so say which one the new folder goes ' +
          'under (--parent, or the parent argument of hushjot_mkdir).',
      );
    } else {
      parentId = null;
    }
  }

  const created: string[] = [];
  const tree: Folder[] = all.map((f) => ({ ...f }));
  for (const name of rest) {
    const existing = tree.find(
      (f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const folder = await createFolderRecord(
      workspace.client,
      workspace.uid,
      workspace.key,
      name,
      parentId,
    );
    const now = Date.now();
    tree.push({ id: folder.id, name, parentId, createdAt: now, updatedAt: now });
    created.push(folder.id);
    parentId = folder.id;
  }

  // Pull what was just written, so the next command in this process (an MCP
  // `push` into the new folder, typically) can resolve it by name.
  if (created.length > 0) await refresh(workspace);

  const finalId = parentId!;
  const finalPath = folderPath(tree, finalId, '/');
  if (options.json) {
    return JSON.stringify({ id: finalId, path: finalPath, created: created.length }, null, 2);
  }
  return created.length === 0
    ? `${finalId}  ${finalPath}  (already existed)`
    : `${finalId}  ${finalPath}`;
}
