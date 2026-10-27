/**
 * The write path, and the two rules that keep it from destroying anything.
 *
 * **Never assume a revision.** The wire `revision` counts writes the backend
 * has *accepted* for that document, and the rules enforce
 * `incoming.revision == stored.revision + 1` on every update. It is not the
 * app's local per-keystroke counter, and the comment around `pushOne` in the
 * app's `sync/engine.ts` spells out what happens when the two are confused:
 * assuming zero pushes revision 1, the compare-and-swap refuses it, the refusal
 * reads as a conflict, and the note forks — every note, on a loop. So a write
 * always reads the document first and sends `stored + 1`.
 *
 * **Never resolve a conflict destructively** (§16, §33.9). The app's answer is
 * to keep both versions as a conflict copy. The CLI's answer is smaller and
 * stricter, because the two verbs have different shapes:
 *
 * - `push` creates a note under a fresh UUID. There is nothing to collide with,
 *   so there is no conflict case at all. This is why it is the verb an agent
 *   should reach for.
 * - `append` is a read-modify-write. A rejected append is retried against the
 *   *re-read* body, which is correct rather than destructive — appending is
 *   order-insensitive, and the retry adds the same text to whatever the note
 *   now says. If the attempts run out it fails and says so.
 * - `replace` is the one verb that overwrites, and it earns that by two rules.
 *   It is a compare-and-swap the *caller* states: the revision it read, so an
 *   edit made on a phone since then refuses the replace instead of being
 *   flattened by it, and it is never retried. And the text it replaces is
 *   uploaded as a history version in the same atomic commit, byte for byte as
 *   stored, so the app's History panel can restore it for a month. An
 *   overwrite that could not be undone is the thing this file exists to
 *   prevent; one that can is an edit.
 *
 * Nothing here can delete. The rules refuse a hard delete outright, and the CLI
 * does not write tombstones: deleting is an app decision with a Recently
 * Deleted screen behind it, and a CLI has no business being the thing that
 * removes a note.
 *
 * **Every write moves the storage meter, in the same commit.** The delta is
 * `meterDelta(new, old)` — the change in *charged* size, each stored document
 * counting at least 1 KiB — both measured on bytes this process holds: for a
 * `push` the old size is zero, and an `append` measures the document it just
 * read, which is the one the compare-and-swap is against. So a retry measures
 * again with the re-read note, and the meter can never be moved for a write that
 * did not land, because the two are one commit.
 *
 * **Every write is also one push** against the account's daily limit
 * (`DAILY_PUSH_LIMIT`). The meter is incremented; when a refusal turns out to be
 * a full window, `commitMetered` reads the meter and tries once more as a reset,
 * which the rules take only if the window is a day old by the server's clock.
 * Refused again, the write fails with `PushLimitError` and nothing changed —
 * the CLI holds no queue, so the caller retries after the time it names.
 */
import {
  BASE_STORAGE_BYTES,
  DAILY_PUSH_LIMIT,
  HISTORY_BYTES_PER_MONTH,
  PUSH_WINDOW_MS,
  PushLimitError,
  QuotaExceededError,
  RevisionConflictError,
  SyncNotApprovedError,
  TIER_MONTH_MS,
  USAGE_DOC,
  chargedBytes,
  countedNoteBytes,
  deriveTitle,
  meterDelta,
  sealIdOf,
  usageMonth,
} from '@hushjot/core';

import {
  openNote,
  readNoteDocument,
  sealFolder,
  sealNote,
  storedBytes,
  type NoteToWrite,
} from './notes.ts';
import {
  int,
  readBytes,
  readInt,
  readTimestamp,
  str,
  timestamp,
  type DocumentWrite,
  type FirestoreClient,
  type UsageWrite,
} from './rest.ts';

/** How many times `append` will re-read and try again before giving up. */
export const APPEND_ATTEMPTS = 3;

export class WriteRefusedError extends Error {
  constructor(id: string, detail: string) {
    super(`The backend refused the write to ${id}: ${detail}`);
    this.name = 'WriteRefusedError';
  }
}

export class NoteMissingError extends Error {
  constructor(id: string) {
    super(`Note ${id} is not on the backend.`);
    this.name = 'NoteMissingError';
  }
}

/**
 * Decide what a 403 on a write actually meant, with one more request.
 *
 * A read carries no revision check. So: if the document is refused on read too,
 * the account is not on the allowlist. If it reads back and its revision has
 * already reached or passed what we tried to write, another device moved first
 * and this is a genuine conflict. If it reads back at the revision we expected,
 * the compare-and-swap would have succeeded — so the refusal was about the
 * document's *shape* or size, or the account's storage allowance, and calling
 * that a conflict (and retrying) would loop forever.
 */
async function explainDenial(
  client: FirestoreClient,
  uid: string,
  relative: string,
  noteId: string,
  attemptedRevision: number,
  delta: number,
): Promise<never> {
  let document;
  try {
    document = await client.get(relative);
  } catch (error) {
    if (error instanceof SyncNotApprovedError) throw error;
    throw error;
  }

  if (!document) {
    await refuseIfFull(client, uid, noteId, delta);
    throw new WriteRefusedError(
      noteId,
      'the document does not exist, so there was nothing to conflict with. ' +
        'The payload was malformed or over the 900 KiB limit.',
    );
  }

  const current = readInt(document.fields.revision);
  if (current !== null && current >= attemptedRevision) {
    throw new RevisionConflictError(noteId, attemptedRevision);
  }

  await refuseIfFull(client, uid, noteId, delta);

  throw new WriteRefusedError(
    noteId,
    `it is at revision ${current ?? '?'} and revision ${attemptedRevision} should have been ` +
      'accepted, so the payload was malformed or over the 900 KiB limit.',
  );
}

/**
 * Throw `QuotaExceededError` when the meter says this write would not fit.
 *
 * A growing write is the only kind the allowance can refuse. Anything that
 * cannot be read here returns quietly and lets the caller give its usual
 * answer, because this function only explains a refusal and never causes one.
 * An absent `storageBytes` is the base allowance, exactly as the rules read it.
 */
async function refuseIfFull(
  client: FirestoreClient,
  uid: string,
  noteId: string,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  let used: number;
  let quota: number;
  try {
    const [usage, plan] = await Promise.all([
      client.get(`users/${uid}/${USAGE_DOC}`),
      client.get(`entitlements/${uid}`),
    ]);
    used = (usage && readInt(usage.fields.bytes)) ?? 0;
    quota = (plan && readInt(plan.fields.storageBytes)) ?? BASE_STORAGE_BYTES;
  } catch {
    return;
  }
  if (used + delta > quota) throw new QuotaExceededError(noteId, delta, used, quota);
}

const notePath = (uid: string, id: string) => `users/${uid}/notes/${id}`;

/** The meter's half of writing `notes/{id}` (or `lastDoc`, when a version rides along). */
const meter = (uid: string, id: string, delta: number, lastDoc = `notes/${id}`): UsageWrite => ({
  path: `users/${uid}/${USAGE_DOC}`,
  lastDoc,
  delta,
  month: usageMonth(Date.now()),
});

/** The push window as the meter holds it, or null when it cannot be read. */
async function readPushWindow(
  client: FirestoreClient,
  uid: string,
): Promise<{ start: number | null; pushes: number } | null> {
  try {
    const usage = await client.get(`users/${uid}/${USAGE_DOC}`);
    return { start: readTimestamp(usage?.fields.ws), pushes: readInt(usage?.fields.pn) ?? 0 };
  } catch {
    return null;
  }
}

/**
 * `commitAll`, plus the one refusal the CLI can answer itself: a full push
 * window. Resolves false for any other refusal, for the caller's
 * `explainDenial`. A reset that is refused too means the day is not over by the
 * server's clock — unless the account is also out of space, which is the more
 * useful thing to say, so `delta` is checked first.
 */
export async function commitMetered(
  client: FirestoreClient,
  uid: string,
  id: string,
  writes: readonly DocumentWrite[],
  usage: UsageWrite,
): Promise<boolean> {
  if (await client.commitAll(writes, usage)) return true;
  const window = await readPushWindow(client, uid);
  if (!window || window.pushes < DAILY_PUSH_LIMIT) return false;
  if (await client.commitAll(writes, { ...usage, reset: true })) return true;
  await refuseIfFull(client, uid, id, usage.delta);
  throw new PushLimitError(window.start === null ? null : window.start + PUSH_WINDOW_MS);
}

/** Write a note that does not exist yet. Throws rather than returning a failure. */
async function createNoteDocument(
  client: FirestoreClient,
  uid: string,
  key: CryptoKey,
  note: NoteToWrite,
): Promise<void> {
  const relative = notePath(uid, note.id);
  const fields = await sealNote(key, note);
  // Nothing was stored before, so the whole note is new.
  const delta = meterDelta(storedBytes(fields), 0);
  // `syncedAt` is the server's; everything else is ours. See `rest.ts`.
  const accepted = await commitMetered(
    client,
    uid,
    note.id,
    [{ relative, fields, serverTimeFields: ['syncedAt'] }],
    meter(uid, note.id, delta),
  );
  if (!accepted) await explainDenial(client, uid, relative, note.id, note.revision, delta);
}

export interface CreateResult {
  id: string;
  title: string;
}

/**
 * `push` — a brand-new note.
 *
 * Revision 1, because nothing is there. The app will pick it up on its next
 * pull: no local `sync:note:<id>` anchor exists for an id it has never seen and
 * no local copy exists either, so `applyRemoteNote` writes it with no conflict.
 */
export async function createNote(
  client: FirestoreClient,
  uid: string,
  key: CryptoKey,
  content: string,
  folderId: string | null,
): Promise<CreateResult> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await createNoteDocument(client, uid, key, {
    id,
    content,
    folderId,
    pinnedAt: null,
    createdAt: now,
    revision: 1,
    updatedAt: now,
  });

  return { id, title: deriveTitle(content) };
}

export interface AppendResult {
  id: string;
  revision: number;
  attempts: number;
  bytesAdded: number;
}

/**
 * `append` — add text to the end of an existing note.
 *
 * Reads, appends, writes at `revision + 1`, and on a compare-and-swap refusal
 * does the whole thing again against the new body. Folder, pin and created date
 * are carried across from the note's current meta rather than reset: an append
 * is a change to the text, and silently unpinning a note, moving it to the root
 * or dating it today would each be a change nobody asked for.
 */
export async function appendToNote(
  client: FirestoreClient,
  uid: string,
  key: CryptoKey,
  noteId: string,
  addition: string,
  /**
   * Checked against the text as re-read on every attempt, and throws to stop.
   * `take` uses it so that "is this still ticked and not yet picked up?" is
   * asked of the same revision the compare-and-swap is against, not of a
   * cached copy a few seconds old.
   */
  guard?: (content: string) => void,
): Promise<AppendResult> {
  const relative = notePath(uid, noteId);

  for (let attempt = 1; attempt <= APPEND_ATTEMPTS; attempt++) {
    const document = await client.get(relative);
    if (!document) throw new NoteMissingError(noteId);

    const sealed = readNoteDocument(document);
    if (!sealed) throw new WriteRefusedError(noteId, 'the stored document is not a note');

    const current = await openNote(key, sealed);
    guard?.(current.content);
    // One newline between the old text and the new, and only when the old text
    // does not already end in one. Appending to an empty note must not start it
    // with a blank line, which would become its title.
    const joiner = current.content === '' || current.content.endsWith('\n') ? '' : '\n';
    const next = `${current.content}${joiner}${addition}`;

    const revision = sealed.revision + 1;
    const fields = await sealNote(key, {
      id: noteId,
      content: next,
      folderId: current.folderId,
      pinnedAt: current.pinnedAt,
      createdAt: current.createdAt,
      revision,
      updatedAt: Date.now(),
    });

    const delta = meterDelta(storedBytes(fields), storedBytes(document.fields));
    const writes = [{ relative, fields, serverTimeFields: ['syncedAt'] }];
    if (await commitMetered(client, uid, noteId, writes, meter(uid, noteId, delta))) {
      return {
        id: noteId,
        revision,
        attempts: attempt,
        bytesAdded: Buffer.byteLength(joiner + addition),
      };
    }

    try {
      await explainDenial(client, uid, relative, noteId, revision, delta);
    } catch (error) {
      // Only a real conflict is worth another go. Anything else — not
      // approved, malformed, too large, storage full, out of pushes — would
      // fail identically next time.
      if (!(error instanceof RevisionConflictError)) throw error;
    }
  }

  throw new Error(
    `Gave up appending to ${noteId} after ${APPEND_ATTEMPTS} attempts: another device ` +
      'is writing to it. Nothing was changed, and no text was lost.',
  );
}

export interface ReplaceResult {
  id: string;
  title: string;
  revision: number;
  /** The history version holding the text that was replaced, or null if the app already had one. */
  versionId: string | null;
}

/**
 * `replace` — overwrite a note's text, keeping the old text in history.
 *
 * `expectedRevision` is the revision the caller read the note at (`cat
 * --json`, or the MCP `hushjot_cat` header). A note that has moved since is a
 * `RevisionConflictError`, not a retry: unlike an append, re-applying a
 * replace to a newer text would discard whatever the newer text added, which is
 * exactly the edit made on a phone while the agent was thinking.
 *
 * The version is a copy of the stored `meta` and `body` fields, not a re-seal:
 * the same bytes the app's `history/record.ts` would have captured, named by
 * the body's nonce (`sealIdOf`) so a device that already captured this sealing
 * holds the same version id. If that version already exists it is not written
 * again — the rules allow versions to be created and never updated — and the
 * replace goes ahead with the copy that is there.
 *
 * Folder, pin and created date are carried across, as `append` does.
 */
export async function replaceNote(
  client: FirestoreClient,
  uid: string,
  key: CryptoKey,
  noteId: string,
  content: string,
  expectedRevision: number,
): Promise<ReplaceResult> {
  const relative = notePath(uid, noteId);
  const document = await client.get(relative);
  if (!document) throw new NoteMissingError(noteId);

  const sealed = readNoteDocument(document);
  if (!sealed || sealed.deleted) throw new NoteMissingError(noteId);
  if (sealed.revision !== expectedRevision) {
    throw new RevisionConflictError(noteId, expectedRevision + 1);
  }

  const current = await openNote(key, sealed);
  const revision = sealed.revision + 1;
  const now = Date.now();
  const fields = await sealNote(key, {
    id: noteId,
    content,
    folderId: current.folderId,
    pinnedAt: current.pinnedAt,
    createdAt: current.createdAt,
    revision,
    updatedAt: now,
  });

  const storedMeta = readBytes(document.fields.meta);
  const storedBody = readBytes(document.fields.body);
  const sealId = storedBody ? sealIdOf(storedBody) : null;
  const writes: DocumentWrite[] = [];
  let history = 0;
  let versionId: string | null = null;
  // The meter names the version when one rides along: a commit may carry one
  // version, and the rules find it — and the note beside it — through `lastDoc`.
  let lastDoc = `notes/${noteId}`;

  if (sealId && storedMeta && storedBody) {
    const versionRelative = `${relative}/versions/${sealId}`;
    versionId = sealId;
    if (!(await client.get(versionRelative))) {
      history = chargedBytes(countedNoteBytes(storedMeta, storedBody));
      lastDoc = `notes/${noteId}/versions/${sealId}`;
      writes.push({
        relative: versionRelative,
        fields: {
          v: int(1),
          meta: document.fields.meta!,
          body: document.fields.body!,
          at: int(sealed.updatedAt),
          reason: str('edit'),
          // Inside the rules' 31-day ceiling, and the tier the app gives the
          // first capture of a day — an overwrite by an agent is worth keeping
          // as long as anything history keeps.
          expireAt: timestamp(now + TIER_MONTH_MS),
        },
        serverTimeFields: ['createdAt'],
      });
    }
  }
  writes.push({ relative, fields, serverTimeFields: ['syncedAt'] });

  const delta = meterDelta(storedBytes(fields), storedBytes(document.fields));
  const usage = { ...meter(uid, noteId, delta, lastDoc), history };
  if (await commitMetered(client, uid, noteId, writes, usage)) {
    return { id: noteId, title: deriveTitle(content), revision, versionId };
  }

  await refuseIfHistoryFull(client, uid, noteId, history);
  return explainDenial(client, uid, relative, noteId, revision, delta);
}

/** Over this month's history upload budget, a replace cannot keep its copy, so it does not happen. */
async function refuseIfHistoryFull(
  client: FirestoreClient,
  uid: string,
  noteId: string,
  history: number,
): Promise<void> {
  if (history === 0) return;
  let used: number;
  try {
    const usage = await client.get(`users/${uid}/${USAGE_DOC}`);
    const hist = usage?.fields.hist;
    const month = hist && 'mapValue' in hist ? hist.mapValue.fields?.[usageMonth(Date.now())] : undefined;
    used = readInt(month) ?? 0;
  } catch {
    return;
  }
  if (used + history > HISTORY_BYTES_PER_MONTH) {
    throw new WriteRefusedError(
      noteId,
      "this month's history allowance is used up, and a replace is only made together with a " +
        'history copy of the text it replaces. Nothing was changed. Append, or push a new note.',
    );
  }
}

export interface FolderResult {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * `mkdir` — one new folder under `parentId` (null is the top level).
 *
 * Folders have no revision and no compare-and-swap in the rules, so there is
 * nothing to collide with on a fresh UUID. The meter moves by the sealed size's
 * charge, as the app's `pushFolder` moves it.
 */
export async function createFolderRecord(
  client: FirestoreClient,
  uid: string,
  key: CryptoKey,
  name: string,
  parentId: string | null,
): Promise<FolderResult> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const fields = await sealFolder(key, { id, name, parentId, createdAt: now, updatedAt: now });
  const relative = `users/${uid}/folders/${id}`;
  const delta = meterDelta(readBytes(fields.data)!.length, 0);
  const accepted = await commitMetered(client, uid, id, [{ relative, fields, serverTimeFields: ['syncedAt'] }], {
    path: `users/${uid}/${USAGE_DOC}`,
    lastDoc: `folders/${id}`,
    delta,
    month: usageMonth(Date.now()),
  });
  if (!accepted) {
    await refuseIfFull(client, uid, id, delta);
    throw new WriteRefusedError(id, 'the folder record was refused.');
  }
  return { id, name, parentId };
}
