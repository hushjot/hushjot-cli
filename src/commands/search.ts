/**
 * `hushjot search` — full-text over encrypted notes.
 *
 * The server cannot do this: it holds ciphertext and an index cannot be built
 * over a value the database cannot read. So the same answer the app reaches for
 * applies here — a hand-written inverted index, in memory, over content this
 * process has just decrypted. `SearchIndex` comes from `@hushjot/core`
 * unchanged; only the thing feeding it differs. In the browser that is a worker
 * reading IndexedDB, here it is the ciphertext cache.
 *
 * **Every body is decrypted on every search.** That is the cost of not writing
 * a token index to disk, which would be the words of every note in the clear
 * (`cache.ts` says why). At the app's own working scale — 10,000 notes — this
 * is roughly three seconds, and at the scale anyone actually has it is tens of
 * milliseconds. If it ever stops being acceptable, the answer is a daemon that
 * holds the index in memory between invocations, not a file.
 *
 * The grammar is the app's ⌘P grammar, from `parseQuery` in core: `#tag` is a
 * tag-prefix filter, `in:folder` scopes, `"quoted"` is a literal phrase and `-`
 * negates any of them. Sharing the parser is the point — a second one would
 * disagree silently about a query somebody pasted from the app.
 *
 * Two of those need something the index cannot supply.
 *
 * **`in:` cannot escape the scope, and not because it is checked.** The index
 * is built from `notesInScope`, so `folderScope` (the MCP server's containment)
 * and `--folder` have already decided what exists. A query naming a folder
 * outside that finds nothing because no such note was ever indexed — the
 * confinement is structural rather than a test somebody has to remember.
 *
 * **Phrases are verified here rather than in the index**, which holds tokens
 * and no positions on purpose. In the browser that costs a re-read; here the
 * bodies are already open, so `verify` is a substring test over `opened`.
 */
import {
  SearchIndex,
  excerptOf,
  folderPath,
  foldersMatching,
  hasPositiveTerm,
  normalisePhrase,
  parseQuery,
  subtreeIds,
  type Folder,
} from '@hushjot/core';

import { openNote } from '../notes.ts';
import { folders, notesInScope, type Workspace } from '../workspace.ts';

export interface SearchOptions {
  folder?: string | undefined;
  limit: number;
  json: boolean;
}

export interface Hit {
  id: string;
  title: string;
  folder: string;
  score: number;
  excerpt: string;
}

export async function search(
  workspace: Workspace,
  query: string,
  options: SearchOptions,
): Promise<string> {
  const all = await folders(workspace);
  const scoped = await notesInScope(workspace, options.folder);

  const index = new SearchIndex();
  // Keep the opened notes: a hit is an id and a score — the index stores no
  // text — so producing an excerpt means having the body to hand.
  const opened = new Map<string, Awaited<ReturnType<typeof openNote>>>();

  for (const sealed of scoped) {
    const note = await openNote(workspace.key, sealed);
    opened.set(note.id, note);
    index.add({
      id: note.id,
      title: note.title,
      content: note.content,
      updatedAt: note.updatedAt,
      folderId: note.folderId,
    });
  }

  const parsed = parseQuery(query);
  if (!hasPositiveTerm(parsed)) {
    return options.json ? '[]' : `No notes match ${JSON.stringify(query)}.`;
  }

  // `in:` names folders by name, so it is resolved against the full list — but
  // filtering happens over an index that only holds in-scope notes, so naming
  // something outside the scope can only ever narrow to nothing.
  const scopeIds = (paths: readonly string[]): Set<string | null> | undefined => {
    if (paths.length === 0) return undefined;
    const out = new Set<string | null>();
    for (const path of paths) {
      if (path === '/') {
        out.add(null);
        continue;
      }
      for (const id of foldersMatching(all as readonly Folder[], path)) {
        for (const descendant of subtreeIds(all as readonly Folder[], id)) out.add(descendant);
      }
    }
    return out;
  };

  const wantsPhrase = parsed.phrases.length > 0 || parsed.notPhrases.length > 0;
  const holdsPhrases = (id: string): boolean => {
    const note = opened.get(id);
    if (!note) return false;
    const hay = normalisePhrase(note.content);
    return parsed.phrases.every((p) => hay.includes(p)) && !parsed.notPhrases.some((p) => hay.includes(p));
  };

  const candidates = index.searchParsed(parsed, {
    folderIds: scopeIds(parsed.folders),
    notFolderIds: scopeIds(parsed.notFolders),
    // Phrase candidates are words-in-any-order and mostly get rejected, so ask
    // for everything and cut to `limit` after verifying. No cap is needed: the
    // bodies are already decrypted, unlike in the browser.
    limit: wantsPhrase ? Number.MAX_SAFE_INTEGER : options.limit,
  });

  const hits: Hit[] = [];
  for (const hit of candidates) {
    if (hits.length >= options.limit) break;
    if (wantsPhrase && !holdsPhrases(hit.id)) continue;
    const note = opened.get(hit.id);
    if (!note) continue;
    hits.push({
      id: note.id,
      title: note.title,
      folder: note.folderId === null ? '' : folderPath(all as readonly Folder[], note.folderId, '/'),
      score: hit.score,
      excerpt: note.excerpt ?? excerptOf(note.content),
    });
  }

  if (options.json) return JSON.stringify(hits, null, 2);
  if (hits.length === 0) return `No notes match ${JSON.stringify(query)}.`;

  return hits
    .map((h) => {
      const where = h.folder ? `  (${h.folder})` : '';
      const tail = h.excerpt ? `\n    ${h.excerpt}` : '';
      return `${h.title}${where}\n    ${h.id}${tail}`;
    })
    .join('\n\n');
}
