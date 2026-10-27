/**
 * A Firestore note document, in both directions.
 *
 * The plaintext shapes are not defined here and must never be: `noteMetaJson`,
 * `readNoteMeta`, `deriveTitle` and `excerptOf` all come from `@hushjot/core`,
 * which is the same code the browser runs. Reimplementing any of them would
 * work perfectly and disagree silently — a title derived differently is written
 * to the account, read back by the app, and nothing anywhere reports a problem.
 *
 * What *is* defined here is the document envelope: which fields the rules
 * accept, in what encoding, and how a revision advances.
 *
 * Every sealed field is bound to its document with `recordContext` — the same
 * contexts the app uses — so a blob moved into another note's slot fails to
 * open rather than reading as that note. Older unbound records still open while
 * core's legacy window is open; everything written here is bound.
 */
import {
  countedNoteBytes,
  deriveTitle,
  excerptOf,
  fromUtf8,
  noteMetaJson,
  open,
  openText,
  readNoteMeta,
  recordContext,
  seal,
  sealText,
  utf8,
  type Bytes,
  type NoteMetaPayload,
} from '@hushjot/core';

import {
  bool,
  bytes,
  int,
  readBool,
  readBytes,
  readInt,
  readTimestamp,
  type Document,
  type Fields,
} from './rest.ts';

/** The rules' own ceiling: `meta.size() + body.size()` must stay under this. */
export const MAX_PAYLOAD_BYTES = 900 * 1024;

export const SCHEMA_VERSION = 1;

/** A note as it sits in Firestore and in the cache: still sealed. */
export interface SealedNote {
  id: string;
  /** Base64 of the meta envelope. Base64 rather than bytes so the cache is JSON. */
  meta: string;
  /** Absent on a tombstone — the app drops the body when it deletes. */
  body?: string;
  revision: number;
  updatedAt: number;
  deleted: boolean;
  /** Server clock. The delta cursor's first half. */
  syncedAt: number;
}

export interface SealedFolder {
  id: string;
  data: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  syncedAt: number;
}

export interface OpenNote extends NoteMetaPayload {
  id: string;
  content: string;
  revision: number;
  updatedAt: number;
  deleted: boolean;
}

export interface OpenFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

const idOf = (name: string) => name.slice(name.lastIndexOf('/') + 1);

const b64 = (value: Bytes | null) => (value ? Buffer.from(value).toString('base64') : null);

// --- reading ---------------------------------------------------------------

export function readNoteDocument(document: Document): SealedNote | null {
  const meta = b64(readBytes(document.fields.meta));
  const revision = readInt(document.fields.revision);
  if (meta === null || revision === null) return null;

  const body = b64(readBytes(document.fields.body));
  return {
    id: idOf(document.name),
    meta,
    ...(body === null ? {} : { body }),
    revision,
    updatedAt: readInt(document.fields.updatedAt) ?? 0,
    deleted: readBool(document.fields.deleted),
    syncedAt: readTimestamp(document.fields.syncedAt) ?? 0,
  };
}

export function readFolderDocument(document: Document): SealedFolder | null {
  const data = b64(readBytes(document.fields.data));
  if (data === null) return null;

  const createdAt = readInt(document.fields.createdAt) ?? 0;
  return {
    id: idOf(document.name),
    data,
    createdAt,
    // Optional in the rules so an older client is not locked out mid-rollout.
    // A folder without one has only ever been created.
    updatedAt: readInt(document.fields.updatedAt) ?? createdAt,
    deleted: readBool(document.fields.deleted),
    syncedAt: readTimestamp(document.fields.syncedAt) ?? 0,
  };
}

// --- opening ---------------------------------------------------------------

export async function openNote(key: CryptoKey, sealed: SealedNote): Promise<OpenNote> {
  const meta = await openNoteMeta(key, sealed);
  const content = sealed.body
    ? await openText(key, Buffer.from(sealed.body, 'base64'), recordContext('note-body', sealed.id))
    : '';

  return {
    ...meta,
    id: sealed.id,
    content,
    revision: sealed.revision,
    updatedAt: sealed.updatedAt,
    deleted: sealed.deleted,
  };
}

/** Title and folder only. What `ls` needs, and it skips decrypting the body. */
export async function openNoteMeta(key: CryptoKey, sealed: SealedNote): Promise<NoteMetaPayload> {
  const metaJson = fromUtf8(
    await open(key, Buffer.from(sealed.meta, 'base64'), recordContext('note-meta', sealed.id)),
  );
  return readNoteMeta(JSON.parse(metaJson) as Partial<NoteMetaPayload>);
}

export async function openFolder(key: CryptoKey, sealed: SealedFolder): Promise<OpenFolder> {
  const json = fromUtf8(
    await open(key, Buffer.from(sealed.data, 'base64'), recordContext('folder', sealed.id)),
  );
  const payload = JSON.parse(json) as { name?: string; parentId?: string | null };
  return {
    id: sealed.id,
    name: payload.name ?? '',
    parentId: payload.parentId ?? null,
    createdAt: sealed.createdAt,
    updatedAt: sealed.updatedAt,
    deleted: sealed.deleted,
  };
}

// --- writing ---------------------------------------------------------------

/**
 * What a note document costs against the storage allowance, by core's
 * definition: the stored `meta` plus `body`. Works on what was read back and on
 * what `sealNote` is about to send, because both are `Fields`.
 */
export function storedBytes(fields: Fields): number {
  return countedNoteBytes(readBytes(fields.meta), readBytes(fields.body));
}

export class PayloadTooLarge extends Error {
  constructor(id: string, size: number) {
    super(
      `Note ${id} is ${Math.round(size / 1024)} KiB sealed, over the ${MAX_PAYLOAD_BYTES / 1024} KiB ` +
        'per-document limit the security rules enforce.',
    );
    this.name = 'PayloadTooLarge';
  }
}

export interface NoteToWrite {
  id: string;
  content: string;
  folderId: string | null;
  pinnedAt: number | null;
  /**
   * When the note was created, sealed into the meta like the pin.
   *
   * Optional, and for one reason: a note written before the field existed has
   * none, and an append must not invent one. Omitted, it stays absent and the
   * app resolves it from the note's `updatedAt` on read (`loadAllMeta`), which
   * is the same answer every device reaches. Writing `0` or `Date.now()` here
   * instead would be a wrong created date, permanently, and it would sync.
   */
  createdAt?: number | undefined;
  /** The backend revision to write. Always `whatever is stored` + 1. */
  revision: number;
  updatedAt: number;
}

/**
 * Seal a note and shape it as the document the rules will accept.
 *
 * Title and excerpt are derived from the content here, at the only point that
 * holds it — the same place `noteRepository.ts` does it in the app. The excerpt
 * is the trap: it is a field *inside* the sealed meta, so a writer that omits
 * it blanks the second line of the note's row on a phone. `createdAt` is the
 * same trap and worse — it is not derivable from anything this function holds,
 * so a caller that drops it resets the note's created date across every device,
 * and the app's "Date created" sort moves the note. Both must be carried in by
 * whoever read the note.
 */
export async function sealNote(key: CryptoKey, note: NoteToWrite): Promise<Fields> {
  const excerpt = excerptOf(note.content);
  const meta = await seal(
    key,
    utf8(
      noteMetaJson({
        title: deriveTitle(note.content),
        folderId: note.folderId,
        pinnedAt: note.pinnedAt,
        ...(excerpt ? { excerpt } : {}),
        ...(note.createdAt === undefined ? {} : { createdAt: note.createdAt }),
      }),
    ),
    recordContext('note-meta', note.id),
  );
  const body = await sealText(key, note.content, recordContext('note-body', note.id));

  if (meta.length + body.length > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLarge(note.id, meta.length + body.length);
  }

  return {
    v: int(SCHEMA_VERSION),
    meta: bytes(meta),
    body: bytes(body),
    revision: int(note.revision),
    updatedAt: int(note.updatedAt),
    deleted: bool(false),
    // `syncedAt` is deliberately absent: it is filled by the server transform
    // in `FirestoreClient.commit`, because the rules demand `request.time` and
    // refuse anything a client sends.
  };
}

export interface FolderToWrite {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Seal a folder as the document the rules accept. Name and parent are the
 * sealed payload, bound to the folder's id, exactly as the app's encrypted
 * codec writes them (`encodeFolder`), so the app opens it like one of its own.
 */
export async function sealFolder(key: CryptoKey, folder: FolderToWrite): Promise<Fields> {
  const data = await seal(
    key,
    utf8(JSON.stringify({ name: folder.name, parentId: folder.parentId })),
    recordContext('folder', folder.id),
  );
  return {
    v: int(SCHEMA_VERSION),
    data: bytes(data),
    createdAt: int(folder.createdAt),
    updatedAt: int(folder.updatedAt),
    deleted: bool(false),
    // `syncedAt` is the server's, as for notes.
  };
}
