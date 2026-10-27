/**
 * The delta pull, over REST.
 *
 * This mirrors `src/adapters/firebase/pull.ts` in the app, and the two
 * decisions it encodes are both things that lost documents permanently before
 * they were got right — `docs/security.md` § "What is stored, and where"
 * records both, and `tests/rules/pull.test.ts` reproduces them.
 *
 * **One position per collection.** Notes and folders are separate queries with
 * separate page limits and no shared server snapshot. A single position let one
 * collection's newest timestamp carry the cursor past documents the other had
 * not delivered yet.
 *
 * **A document id alongside the timestamp.** `serverTimestamp()` has
 * millisecond resolution and a burst of writes gives several documents the same
 * value. Paginating on the timestamp alone skipped whichever of those ties fell
 * past a page boundary. So the order is `(syncedAt, __name__)`, which is total,
 * and the cursor is the last document of the page rather than the largest
 * timestamp in it.
 *
 * `documentId()` is appended to every single-field index automatically, so
 * this needs no composite index — which is why it works against a project whose
 * `firestore.indexes.json` knows nothing about the CLI.
 */
import type { Document } from './rest.ts';
import { timestamp, type FirestoreClient } from './rest.ts';
import {
  readFolderDocument,
  readNoteDocument,
  type SealedFolder,
  type SealedNote,
} from './notes.ts';

export const PULL_PAGE = 200;

export interface Position {
  /** `syncedAt` in epoch milliseconds. */
  at: number;
  /** The last document id consumed at that instant, or '' at the beginning. */
  id: string;
}

export interface Cursor {
  notes: Position;
  folders: Position;
}

export const CURSOR_START: Cursor = {
  notes: { at: 0, id: '' },
  folders: { at: 0, id: '' },
};

export function parseCursor(raw: unknown): Cursor {
  const position = (value: unknown): Position => {
    if (!value || typeof value !== 'object') return { at: 0, id: '' };
    const { at, id } = value as { at?: unknown; id?: unknown };
    return {
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      id: typeof id === 'string' ? id : '',
    };
  };
  if (!raw || typeof raw !== 'object') return CURSOR_START;
  const { notes, folders } = raw as { notes?: unknown; folders?: unknown };
  return { notes: position(notes), folders: position(folders) };
}

function query(
  client: FirestoreClient,
  uid: string,
  collection: 'notes' | 'folders',
  from: Position,
): unknown {
  const base = {
    from: [{ collectionId: collection }],
    orderBy: [
      { field: { fieldPath: 'syncedAt' }, direction: 'ASCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
    ],
    limit: PULL_PAGE,
  };

  // The very beginning: no filter at all, so the first run reads the account.
  if (from.at === 0 && from.id === '') return base;

  // Mid-stream: resume strictly after the exact (timestamp, id) pair. This is
  // the half that needs the id — a timestamp alone cannot separate ties.
  if (from.id !== '') {
    return {
      ...base,
      startAt: {
        values: [
          timestamp(from.at),
          { referenceValue: client.documentName(`users/${uid}/${collection}/${from.id}`) },
        ],
        before: false,
      },
    };
  }

  // A timestamp with no id: inclusive on purpose. Re-delivering a document
  // costs one read and is idempotent; skipping one loses it.
  return {
    ...base,
    where: {
      fieldFilter: {
        field: { fieldPath: 'syncedAt' },
        op: 'GREATER_THAN_OR_EQUAL',
        value: timestamp(from.at),
      },
    },
  };
}

/**
 * Advance to the page's **last** document, never to the largest timestamp seen.
 * Refuses to go backwards, which a clock-skewed write could otherwise cause.
 */
function advance(from: Position, page: Document[], read: (d: Document) => { id: string; syncedAt: number } | null): Position {
  const last = page.length > 0 ? read(page[page.length - 1]!) : null;
  if (!last) return from;
  if (last.syncedAt < from.at) return from;
  return { at: last.syncedAt, id: last.id };
}

export interface PullResult {
  notes: SealedNote[];
  folders: SealedFolder[];
  cursor: Cursor;
  hasMore: boolean;
}

export async function pullPage(
  client: FirestoreClient,
  uid: string,
  cursor: Cursor,
): Promise<PullResult> {
  const parent = `users/${uid}`;
  const [noteDocs, folderDocs] = await Promise.all([
    client.runQuery(parent, query(client, uid, 'notes', cursor.notes)),
    client.runQuery(parent, query(client, uid, 'folders', cursor.folders)),
  ]);

  const notes: SealedNote[] = [];
  for (const document of noteDocs) {
    const note = readNoteDocument(document);
    if (note) notes.push(note);
  }

  const folders: SealedFolder[] = [];
  for (const document of folderDocs) {
    const folder = readFolderDocument(document);
    if (folder) folders.push(folder);
  }

  return {
    notes,
    folders,
    cursor: {
      notes: advance(cursor.notes, noteDocs, readNoteDocument),
      folders: advance(cursor.folders, folderDocs, readFolderDocument),
    },
    // A full page from either collection means there is more of *something*.
    hasMore: noteDocs.length === PULL_PAGE || folderDocs.length === PULL_PAGE,
  };
}

/** Drain the delta completely. Bounded by pages, not by one huge query. */
export async function pullAll(
  client: FirestoreClient,
  uid: string,
  start: Cursor,
  apply: (result: PullResult) => void,
): Promise<Cursor> {
  let cursor = start;
  for (;;) {
    const result = await pullPage(client, uid, cursor);
    apply(result);

    const advanced =
      result.cursor.notes.at !== cursor.notes.at ||
      result.cursor.notes.id !== cursor.notes.id ||
      result.cursor.folders.at !== cursor.folders.at ||
      result.cursor.folders.id !== cursor.folders.id;

    cursor = result.cursor;
    // `!advanced` is the guard against a page that returns rows but cannot move
    // the cursor — without it a malformed document would spin here forever.
    if (!result.hasMore || !advanced) return cursor;
  }
}
