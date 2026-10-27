/**
 * The ciphertext cache: `~/.hushjot/cache/<uid>/`.
 *
 * **It is a read-side cache, not a second sync engine.** Writes go straight to
 * Firestore and nothing is queued here, so none of the app's backfill and
 * ownership machinery (`app:owner`, `sync:backfilled`, `classifyVault`) has an
 * analogue. Deleting this directory loses nothing; the next command refetches.
 *
 * It exists for `search`, which needs every note's body. Without it, searching
 * would pull the whole account on every invocation — hundreds of billed reads
 * to answer one question, several times a minute in an agent's loop. With it, a
 * search is one delta query that usually returns zero documents.
 *
 * **Ciphertext only on disk**, the same rule the browser's IndexedDB follows.
 * Two consequences worth stating rather than discovering:
 *
 * - The rows here are byte-identical to what Firestore holds. Someone who
 *   copies this directory gets exactly what a breach of the backend would give
 *   them, and no more.
 * - The token index is deliberately *not* persisted, even though rebuilding it
 *   each run is the slowest part of a search. A serialised inverted index is
 *   the words of every note, in the clear, which is most of what the encryption
 *   was for. Rebuilding in memory is the price of not writing that file.
 *
 * The format is one JSON file rather than a file per note. At the scale this
 * has to work — the app's own budget is 10,000 notes — a single read of a few
 * megabytes beats ten thousand `open`/`read`/`close` cycles, and it makes the
 * cursor and the rows update atomically.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cacheDir } from './config.ts';
import { CURSOR_START, parseCursor, type Cursor } from './pull.ts';
import type { SealedFolder, SealedNote } from './notes.ts';

/** Bumped when the on-disk shape changes. A mismatch drops the cache. */
const CACHE_VERSION = 1;

export interface Cache {
  version: number;
  cursor: Cursor;
  notes: Record<string, SealedNote>;
  folders: Record<string, SealedFolder>;
}

const emptyCache = (): Cache => ({
  version: CACHE_VERSION,
  cursor: CURSOR_START,
  notes: {},
  folders: {},
});

const cachePath = (uid: string) => join(cacheDir(uid), 'store.json');

export function loadCache(uid: string): Cache {
  let raw: string;
  try {
    raw = readFileSync(cachePath(uid), 'utf8');
  } catch {
    return emptyCache();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Cache>;
    // A cache from a different shape is discarded rather than migrated. It is
    // derived data; refetching costs one delta pull from the beginning.
    if (parsed.version !== CACHE_VERSION) return emptyCache();
    return {
      version: CACHE_VERSION,
      cursor: parseCursor(parsed.cursor),
      notes: parsed.notes ?? {},
      folders: parsed.folders ?? {},
    };
  } catch {
    return emptyCache();
  }
}

/**
 * Write through a temporary file and rename. A cache truncated by a process
 * killed mid-write would be JSON that does not parse, which `loadCache` would
 * then silently treat as "no cache" and refetch the whole account — correct,
 * but a surprising bill. `rename` is atomic on every platform this runs on.
 */
export function saveCache(uid: string, cache: Cache): void {
  const directory = cacheDir(uid);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const target = cachePath(uid);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
  renameSync(temporary, target);
}

/**
 * Fold one delta page into the cache.
 *
 * Tombstones are kept rather than dropped: a note deleted on another device
 * arrives as `deleted: true`, and forgetting it here would let the *next* pull
 * from an older cursor resurrect it in a listing. Callers filter on `deleted`.
 */
export function applyPage(
  cache: Cache,
  page: { notes: readonly SealedNote[]; folders: readonly SealedFolder[]; cursor: Cursor },
): void {
  for (const note of page.notes) {
    const known = cache.notes[note.id];
    // Revision is the backend's counter, so a lower one is a stale re-delivery
    // — which the inclusive first page of a pull produces deliberately.
    if (known && known.revision > note.revision) continue;
    cache.notes[note.id] = note;
  }

  for (const folder of page.folders) {
    const known = cache.folders[folder.id];
    // Folders carry no revision and get no compare-and-swap: there is no user
    // text in one to lose, only a name and a parent, so the later write wins.
    if (known && known.updatedAt > folder.updatedAt) continue;
    cache.folders[folder.id] = folder;
  }

  cache.cursor = page.cursor;
}
