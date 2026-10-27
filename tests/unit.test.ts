/**
 * The parts the emulator journey cannot reach.
 *
 * `tests/integration/journey.mjs` proves the protocol — that the documents this
 * CLI builds are shaped the way the real security rules demand. What it cannot
 * do is force the failures: a compare-and-swap losing a race needs two writers,
 * and a delta cursor mis-advancing needs a page boundary landing on a tie. Both
 * are decisions, both have cost somebody data in the app's history, and both
 * are exercised here against stubs instead.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BASE_STORAGE_BYTES,
  DAILY_PUSH_LIMIT,
  PushLimitError,
  chargedBytes,
  meterDelta,
  FORMAT_VERSION,
  QuotaExceededError,
  RevisionConflictError,
  SyncNotApprovedError,
  SyncPausedError,
  countedNoteBytes,
  sealIdOf,
  usageMonth,
  deriveTitle,
  deserializeKeyRecord,
  excerptOf,
  fromBase64,
  fromUtf8,
  SearchIndex,
  foldersMatching,
  noteMetaJson,
  open,
  parseQuery,
  openText,
  readNoteMeta,
  subtreeIds,
  tokenize,
  unlockWithPassphrase,
  type Folder,
  type NoteMetaPayload,
} from '@hushjot/core';

import { applyPage, type Cache } from '../src/cache.ts';
import { push } from '../src/commands/push.ts';
import { DEFAULT_API_KEY, DEFAULT_PROJECT_ID, loadConfig, saveConfig } from '../src/config.ts';
import { AmbiguousNoteError, NoteNotFoundError, pickNote, type Candidate } from '../src/find.ts';
import { CURSOR_START, parseCursor } from '../src/pull.ts';
import {
  int,
  readBytes,
  readInt,
  readMap,
  readTimestamp,
  usageWrite,
  type DocumentWrite,
  type Fields,
  type UsageWrite,
} from '../src/rest.ts';
import {
  sealFolder,
  sealNote,
  type OpenFolder,
  type SealedFolder,
  type SealedNote,
} from '../src/notes.ts';
import { APPEND_ATTEMPTS, appendToNote, createNote, replaceNote } from '../src/write.ts';
import {
  OutsideScopeError,
  ScopeMissingError,
  UnknownFolderError,
  allowedFolderIds,
  resolveInScope,
  type Workspace,
} from '../src/workspace.ts';
import { FirestoreClient } from '../src/rest.ts';

const require = createRequire(import.meta.url);

// --- the contract ----------------------------------------------------------

describe('the format contract, against the published package', () => {
  // The same frozen vectors the app repo asserts against. A divergence here
  // means the two clients no longer agree about what a note looks like on
  // disk, which is the one failure that corrupts data rather than reporting it.
  const vectors = JSON.parse(
    readFileSync(require.resolve('@hushjot/core/contract/format-vectors.json'), 'utf8'),
  ) as {
    formatVersion: number;
    keyRecords: { id: string; passphrase: string; record: unknown }[];
    noteMeta: { id: string; payload: never; json: string; envelopeBase64: string }[];
    body: { id: string; text: string; envelopeBase64: string }[];
    bound: {
      id: string;
      kind: 'note-meta' | 'note-body' | 'folder' | 'share-key';
      recordId: string;
      context: string;
      plaintext: string;
      envelopeBase64: string;
    }[];
    deriveTitle: { content: string; expected: string }[];
    excerptOf: { content: string; expected: string }[];
    tokenize: { text: string; expected: string[] }[];
  };

  const fast = vectors.keyRecords.find((r) => r.id === 'fast')!;
  const key = unlockWithPassphrase(deserializeKeyRecord(fast.record), fast.passphrase);

  it('speaks the version the vectors were written at', () => {
    expect(vectors.formatVersion).toBe(FORMAT_VERSION);
  });

  it('opens every frozen meta blob to its frozen JSON', async () => {
    for (const c of vectors.noteMeta) {
      expect(fromUtf8(await open(await key, fromBase64(c.envelopeBase64)))).toBe(c.json);
      expect(noteMetaJson(c.payload)).toBe(c.json);
    }
  });

  it('opens every frozen body blob to its original text', async () => {
    for (const c of vectors.body) {
      expect(await openText(await key, fromBase64(c.envelopeBase64))).toBe(c.text);
    }
  });

  it('opens every frozen bound blob under its record, and under no other', async () => {
    const { recordContext } = await import('@hushjot/core');
    for (const c of vectors.bound) {
      expect(recordContext(c.kind, c.recordId)).toBe(c.context);
      const bytes = fromBase64(c.envelopeBase64);
      expect(fromUtf8(await open(await key, bytes, c.context))).toBe(c.plaintext);
      await expect(open(await key, bytes, recordContext(c.kind, `${c.recordId}x`))).rejects.toThrow();
    }
  });

  it('derives titles, excerpts and tokens identically to the app', () => {
    for (const c of vectors.deriveTitle) expect(deriveTitle(c.content)).toBe(c.expected);
    for (const c of vectors.excerptOf) expect(excerptOf(c.content)).toBe(c.expected);
    for (const c of vectors.tokenize) expect(tokenize(c.text)).toEqual(c.expected);
  });
});

// --- Firestore value encoding ---------------------------------------------

describe('Firestore REST values', () => {
  it('sends integers as strings, because JSON would lose a 64-bit one', () => {
    expect(int(1758500000123)).toEqual({ integerValue: '1758500000123' });
    expect(readInt({ integerValue: '42' })).toBe(42);
  });

  it('decodes bytes as standard padded base64, not base64url', () => {
    // 0xFB 0xFF encodes as "+/8=" in standard base64 and "-_8" in base64url.
    // Reading it as base64url would silently produce different bytes.
    expect(Array.from(readBytes({ bytesValue: '+/8=' })!)).toEqual([0xfb, 0xff]);
  });

  it('truncates a timestamp downwards, so a cursor resumes early rather than late', () => {
    // Firestore sends microseconds. Rounding up would step past a document and
    // lose it; rounding down re-delivers one, which is free and idempotent.
    expect(readTimestamp({ timestampValue: '2026-09-22T12:00:00.123456Z' })).toBe(
      Date.parse('2026-09-22T12:00:00.123Z'),
    );
  });

  it('flattens a nested map, which is how the key record arrives', () => {
    expect(
      readMap({
        mapValue: {
          fields: {
            version: { integerValue: '1' },
            passphrase: { mapValue: { fields: { salt: { stringValue: 'AAA=' } } } },
          },
        },
      }),
    ).toEqual({ version: 1, passphrase: { salt: 'AAA=' } });
  });
});

// --- the cursor ------------------------------------------------------------

describe('the delta cursor', () => {
  it('keeps a position per collection', () => {
    // One position for both let notes' newest timestamp carry the cursor past
    // folders that had not been delivered yet. The two queries have separate
    // page limits and do not share a server snapshot.
    expect(CURSOR_START.notes).not.toBe(CURSOR_START.folders);
    const parsed = parseCursor({ notes: { at: 5, id: 'a' }, folders: { at: 9, id: 'b' } });
    expect(parsed.notes).toEqual({ at: 5, id: 'a' });
    expect(parsed.folders).toEqual({ at: 9, id: 'b' });
  });

  it('falls back to the beginning rather than throwing on anything unexpected', () => {
    // A cursor is derived state. Restarting the delta costs reads; a crash on
    // start-up costs the user their tool.
    expect(parseCursor(null)).toEqual(CURSOR_START);
    expect(parseCursor('nonsense')).toEqual(CURSOR_START);
    expect(parseCursor({ notes: 7 })).toEqual(CURSOR_START);
    expect(parseCursor({ notes: { at: 'x', id: 4 } })).toEqual(CURSOR_START);
  });
});

// --- the cache merge -------------------------------------------------------

const sealed = (id: string, revision: number, updatedAt = 0): SealedNote => ({
  id,
  meta: 'AQE=',
  revision,
  updatedAt,
  deleted: false,
  syncedAt: updatedAt,
});

describe('folding a page into the cache', () => {
  it('ignores a stale re-delivery', () => {
    // The first page of a pull is deliberately inclusive of the cursor
    // instant, so re-delivery is normal and must not roll a note backwards.
    const cache: Cache = { version: 1, cursor: CURSOR_START, notes: {}, folders: {} };
    applyPage(cache, { notes: [sealed('n', 5)], folders: [], cursor: CURSOR_START });
    applyPage(cache, { notes: [sealed('n', 3)], folders: [], cursor: CURSOR_START });
    expect(cache.notes.n!.revision).toBe(5);
  });

  it('keeps tombstones', () => {
    // Forgetting a tombstone lets the next pull from an older cursor resurrect
    // a deleted note in a listing.
    const cache: Cache = { version: 1, cursor: CURSOR_START, notes: {}, folders: {} };
    applyPage(cache, {
      notes: [{ ...sealed('n', 2), deleted: true }],
      folders: [],
      cursor: CURSOR_START,
    });
    expect(cache.notes.n!.deleted).toBe(true);
  });
});

// --- resolving a note ------------------------------------------------------

const candidate = (id: string, title: string): Candidate => ({
  sealed: sealed(id, 1),
  title,
  folderId: null,
  pinnedAt: null,
  updatedAt: 0,
  excerpt: '',
});

describe('picking a note from what someone typed', () => {
  const all = [candidate('id-1', 'Standup'), candidate('id-2', 'Standup'), candidate('id-3', 'Shopping')];

  it('prefers an id to anything else', () => {
    expect(pickNote(all, 'id-2').sealed.id).toBe('id-2');
  });

  it('refuses to guess between two notes of the same name', () => {
    // `append` is on the other side of this function. Appending to the wrong
    // note is silent, so ambiguity is an error listing both ids.
    expect(() => pickNote(all, 'Standup')).toThrow(AmbiguousNoteError);
  });

  it('accepts an unambiguous prefix, but only after exact matches fail', () => {
    expect(pickNote(all, 'shop').sealed.id).toBe('id-3');
    expect(() => pickNote(all, 'S')).toThrow(AmbiguousNoteError);
    expect(() => pickNote(all, 'nothing like it')).toThrow(NoteNotFoundError);
  });
});

// --- the compare-and-swap --------------------------------------------------

/**
 * A client that refuses the first `refusals` commits and then accepts, and that
 * advances the stored revision each time — which is what another device writing
 * concurrently looks like from here.
 */
function racingClient(refusals: number, doc: { meta: string; body: string }) {
  let storedRevision = 1;
  let attempted = 0;
  const committed: number[] = [];

  return {
    stats: () => ({ attempted, committed, storedRevision }),
    client: {
      async get() {
        return {
          name: 'projects/p/databases/(default)/documents/users/u/notes/n',
          fields: {
            meta: { bytesValue: doc.meta },
            body: { bytesValue: doc.body },
            revision: { integerValue: String(storedRevision) },
            updatedAt: { integerValue: '0' },
            deleted: { booleanValue: false },
          },
        };
      },
      async commitAll() {
        attempted++;
        if (attempted <= refusals) {
          storedRevision++; // somebody else got there first
          return false;
        }
        committed.push(storedRevision + 1);
        return true;
      },
      documentName: (r: string) => r,
    } as unknown as FirestoreClient,
  };
}

describe('append under a compare-and-swap refusal', () => {
  /**
   * A real stored note: meta is sealed JSON and body is sealed text. They are
   * separate blobs, and conflating them is exactly the mistake the app's codec
   * seam exists to make impossible — `openNote` parses one and decodes the
   * other.
   */
  const storedNote = async (key: CryptoKey) => {
    const { seal, sealText, toBase64, utf8 } = await import('@hushjot/core');
    return {
      meta: toBase64(
        await seal(key, utf8(noteMetaJson({ title: 'First', folderId: null, pinnedAt: null }))),
      ),
      body: toBase64(await sealText(key, 'first line\n')),
    };
  };

  const vaultKey = (async () => {
    const vectors = JSON.parse(
      readFileSync(require.resolve('@hushjot/core/contract/format-vectors.json'), 'utf8'),
    ) as { keyRecords: { id: string; passphrase: string; record: unknown }[] };
    const fast = vectors.keyRecords.find((r) => r.id === 'fast')!;
    return unlockWithPassphrase(deserializeKeyRecord(fast.record), fast.passphrase);
  })();

  it('retries against the re-read body rather than overwriting', async () => {
    const key = await vaultKey;
    const { client, stats } = racingClient(1, await storedNote(key));
    const result = await appendToNote(client, 'u', key, 'n', 'second line');

    expect(result.attempts).toBe(2);
    // The second attempt must send `stored + 1` against the *new* stored
    // revision, not a remembered one. Sending a remembered value is how the
    // app's engine once forked a note on every retry.
    expect(stats().committed).toEqual([3]);
  });

  it('gives up rather than clobbering when the race never ends', async () => {
    const key = await vaultKey;
    const { client, stats } = racingClient(Number.POSITIVE_INFINITY, await storedNote(key));
    await expect(appendToNote(client, 'u', key, 'n', 'x')).rejects.toThrow(/Gave up/);
    expect(stats().attempted).toBe(APPEND_ATTEMPTS);
    expect(stats().committed).toEqual([]);
  });

  it('does not retry a refusal that is not a conflict', async () => {
    // A refusal where the stored revision is *behind* what we sent means the
    // compare-and-swap would have succeeded, so the payload was malformed.
    // Retrying it would fail identically, forever.
    const key = await vaultKey;
    const doc = await storedNote(key);
    let attempted = 0;
    const client = {
      async get() {
        return {
          name: 'n',
          fields: {
            meta: { bytesValue: doc.meta },
            body: { bytesValue: doc.body },
            revision: { integerValue: '1' },
            updatedAt: { integerValue: '0' },
            deleted: { booleanValue: false },
          },
        };
      },
      async commitAll() {
        attempted++;
        return false;
      },
      documentName: (r: string) => r,
    } as unknown as FirestoreClient;

    await expect(appendToNote(client, 'u', key, 'n', 'x')).rejects.toThrow(/refused the write/);
    expect(attempted).toBe(1);
    expect(RevisionConflictError).toBeDefined();
  });
});

/**
 * The sealed meta carries fields this CLI cannot derive from the text it is
 * given: the pin, the folder, and the created date. `sealNote` builds the
 * payload field by field, so anything a caller forgets to pass is not merely
 * missing from this write — it is *deleted* from the note, for every device,
 * permanently. The excerpt trap that `sealNote`'s own comment describes is this
 * same shape, and it happened once.
 */
describe('append preserves the meta it did not write', () => {
  const vaultKey = (async () => {
    const vectors = JSON.parse(
      readFileSync(require.resolve('@hushjot/core/contract/format-vectors.json'), 'utf8'),
    ) as { keyRecords: { id: string; passphrase: string; record: unknown }[] };
    const fast = vectors.keyRecords.find((r) => r.id === 'fast')!;
    return unlockWithPassphrase(deserializeKeyRecord(fast.record), fast.passphrase);
  })();

  /** Commit once, and hand back the meta payload that was actually sent. */
  async function appendAndReadMeta(
    key: CryptoKey,
    stored: Partial<NoteMetaPayload> & { title: string; folderId: string | null; pinnedAt: number | null },
  ): Promise<NoteMetaPayload> {
    const { fromUtf8, open, recordContext, seal, sealText, toBase64, utf8 } = await import('@hushjot/core');
    // Sealed unbound on purpose: the note was written before envelopes were
    // bound to their record, which is what every existing test vault holds.
    const doc = {
      meta: toBase64(await seal(key, utf8(noteMetaJson(stored as NoteMetaPayload)))),
      body: toBase64(await sealText(key, 'first line\n')),
    };

    let sent: Record<string, { bytesValue?: string }> | undefined;
    const client = {
      async get() {
        return {
          name: 'n',
          fields: {
            meta: { bytesValue: doc.meta },
            body: { bytesValue: doc.body },
            revision: { integerValue: '1' },
            updatedAt: { integerValue: '0' },
            deleted: { booleanValue: false },
          },
        };
      },
      async commitAll(writes: DocumentWrite[]) {
        sent = writes[0]!.fields as Record<string, { bytesValue?: string }>;
        return true;
      },
      documentName: (r: string) => r,
    } as unknown as FirestoreClient;

    await appendToNote(client, 'u', key, 'n', 'second line');
    const bytes = Buffer.from(sent!.meta!.bytesValue!, 'base64');
    // Whatever it read, what it writes back is bound to the note.
    expect(bytes[0]).toBe(2);
    return readNoteMeta(
      JSON.parse(fromUtf8(await open(key, bytes, recordContext('note-meta', 'n')))) as Partial<NoteMetaPayload>,
    );
  }

  it('carries the created date across, so the note does not look new', async () => {
    const key = await vaultKey;
    const meta = await appendAndReadMeta(key, {
      title: 'First',
      folderId: 'f-1',
      pinnedAt: 1758500000000,
      createdAt: 1700000000000,
    });
    expect(meta.createdAt).toBe(1700000000000);
    // The two this has always carried, asserted here so one test covers the
    // whole trap rather than only its newest instance.
    expect(meta.folderId).toBe('f-1');
    expect(meta.pinnedAt).toBe(1758500000000);
  });

  it('does not invent a created date for a note written before the field', async () => {
    // Absent must stay absent: the app resolves it from the note's `updatedAt`,
    // which every device agrees on. A `Date.now()` here would be a wrong date
    // and it would sync.
    const key = await vaultKey;
    const meta = await appendAndReadMeta(key, { title: 'First', folderId: null, pinnedAt: null });
    expect('createdAt' in meta).toBe(false);
  });
});

describe('the search grammar, shared with the app', () => {
  const folders: Folder[] = [
    { id: 'work', name: 'Work', parentId: null, createdAt: 0, updatedAt: 0 },
    { id: 'infra', name: 'Infra', parentId: 'work', createdAt: 0, updatedAt: 0 },
    { id: 'personal', name: 'Personal', parentId: null, createdAt: 0, updatedAt: 0 },
  ];

  /** What `search.ts` does: resolve `in:` values to ids, descendants included. */
  const scopeIds = (paths: readonly string[]): Set<string | null> | undefined => {
    if (paths.length === 0) return undefined;
    const out = new Set<string | null>();
    for (const path of paths) {
      if (path === '/') {
        out.add(null);
        continue;
      }
      for (const id of foldersMatching(folders, path)) {
        for (const d of subtreeIds(folders, id)) out.add(d);
      }
    }
    return out;
  };

  const indexOf = (notes: { id: string; content: string; folderId: string | null }[]) => {
    const index = new SearchIndex();
    let stamp = 0;
    for (const n of notes) {
      index.add({
        id: n.id,
        title: n.id,
        content: n.content,
        updatedAt: stamp++,
        folderId: n.folderId,
      });
    }
    return index;
  };

  it('scopes in: to a folder and everything under it', () => {
    const index = indexOf([
      { id: 'a', content: 'deploy notes', folderId: 'infra' },
      { id: 'b', content: 'deploy notes', folderId: 'personal' },
    ]);
    const parsed = parseQuery('deploy in:Work');
    const hits = index.searchParsed(parsed, { folderIds: scopeIds(parsed.folders) });
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  /**
   * The containment the MCP server depends on. `notesInScope` decides what is
   * indexed at all, so a query naming a folder outside the operator's scope
   * matches nothing — not because a check refused it, but because no such note
   * was ever put in the index. Widening past `folderScope` through a query
   * string would hand an agent the whole vault.
   */
  it('cannot widen past the scope the index was built from', () => {
    // Only the in-scope note is indexed, exactly as `notesInScope` returns.
    const index = indexOf([{ id: 'inside', content: 'secret deploy notes', folderId: 'infra' }]);

    const parsed = parseQuery('deploy in:Personal');
    const hits = index.searchParsed(parsed, { folderIds: scopeIds(parsed.folders) });
    expect(hits).toEqual([]);

    // And a query naming no folder still only reaches what was indexed.
    expect(index.searchParsed(parseQuery('deploy'), {}).map((h) => h.id)).toEqual(['inside']);
  });

  it('excludes with -, over words, tags and folders', () => {
    const index = indexOf([
      { id: 'a', content: 'deploy notes #draft', folderId: 'infra' },
      { id: 'b', content: 'deploy notes', folderId: 'infra' },
      { id: 'c', content: 'deploy notes', folderId: 'personal' },
    ]);
    expect(index.search('deploy -#draft').map((h) => h.id).sort()).toEqual(['b', 'c']);

    const parsed = parseQuery('deploy -in:Personal');
    const hits = index.searchParsed(parsed, { notFolderIds: scopeIds(parsed.notFolders) });
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b']);
  });

  it('agrees with the app about what a quoted phrase is', () => {
    // The parse is the shared one; only verification differs between clients,
    // because here the bodies are already open.
    const parsed = parseQuery('"connection pool" -"draft copy"');
    expect(parsed.phrases).toEqual(['connection pool']);
    expect(parsed.notPhrases).toEqual(['draft copy']);
  });
});

/**
 * The storage meter rides in the same commit as the note, and its delta is the
 * change in stored ciphertext. Once the rules enforce it they refuse any commit
 * whose delta is wrong, so a wrong delta here means every CLI write fails then,
 * and nothing before that would notice.
 */
describe('the storage meter', () => {
  const vaultKey = (async () => {
    const vectors = JSON.parse(
      readFileSync(require.resolve('@hushjot/core/contract/format-vectors.json'), 'utf8'),
    ) as { keyRecords: { id: string; passphrase: string; record: unknown }[] };
    const fast = vectors.keyRecords.find((r) => r.id === 'fast')!;
    return unlockWithPassphrase(deserializeKeyRecord(fast.record), fast.passphrase);
  })();

  const sizeOf = (f: Record<string, { bytesValue?: string }>) =>
    Buffer.from(f.meta!.bytesValue!, 'base64').length + Buffer.from(f.body!.bytesValue!, 'base64').length;

  type Sent = { relative: string; fields: Record<string, { bytesValue?: string }>; usage?: UsageWrite };

  /** A client holding one stored note (or none), recording each commit. */
  function meteredClient(
    stored: { meta: string; body: string } | null,
    o: {
      accept?: boolean | ((usage: UsageWrite | undefined) => boolean);
      used?: number;
      quota?: number;
      window?: { start: number; pushes: number };
    } = {},
  ) {
    const sent: Sent[] = [];
    const client = {
      async get(relative: string) {
        if (relative.endsWith('/usage/current')) {
          if (o.used === undefined && o.window === undefined) return null;
          return {
            name: relative,
            fields: {
              bytes: int(o.used ?? 0),
              ...(o.window
                ? { ws: { timestampValue: new Date(o.window.start).toISOString() }, pn: int(o.window.pushes) }
                : {}),
            },
          };
        }
        if (relative.startsWith('entitlements/')) {
          return o.quota === undefined ? null : { name: relative, fields: { storageBytes: int(o.quota) } };
        }
        if (!stored) return null;
        return {
          name: relative,
          fields: {
            meta: { bytesValue: stored.meta },
            body: { bytesValue: stored.body },
            revision: { integerValue: '1' },
            updatedAt: { integerValue: '0' },
            deleted: { booleanValue: false },
          },
        };
      },
      async commitAll(writes: DocumentWrite[], usage?: UsageWrite) {
        const [{ relative, fields }] = writes as [DocumentWrite];
        sent.push({ relative, fields: fields as Sent['fields'], ...(usage ? { usage } : {}) });
        if (typeof o.accept === 'function') return o.accept(usage);
        return o.accept ?? true;
      },
      documentName: (r: string) => r,
    } as unknown as FirestoreClient;
    return { client, sent };
  }

  const storedNote = async (key: CryptoKey, text: string) => {
    const { seal, sealText, toBase64, utf8 } = await import('@hushjot/core');
    return {
      meta: toBase64(await seal(key, utf8(noteMetaJson({ title: 'First', folderId: null, pinnedAt: null })))),
      body: toBase64(await sealText(key, text)),
    };
  };

  it('counts the whole note on a push', async () => {
    const { client, sent } = meteredClient(null);
    const { id } = await createNote(client, 'u', await vaultKey, 'hello\nworld', null);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.usage).toEqual({
      path: 'users/u/usage/current',
      lastDoc: `notes/${id}`,
      delta: meterDelta(sizeOf(sent[0]!.fields), 0),
      month: usageMonth(Date.now()),
    });
    // A short note is charged the 1 KiB minimum, as the rules charge it.
    expect(sizeOf(sent[0]!.fields)).toBeLessThan(1024);
    expect(sent[0]!.usage!.delta).toBe(1024);
  });

  it('counts only the growth on an append', async () => {
    const key = await vaultKey;
    const doc = await storedNote(key, 'first line\n');
    const { client, sent } = meteredClient(doc);
    await appendToNote(client, 'u', key, 'n', 'second line');
    const before = Buffer.from(doc.meta, 'base64').length + Buffer.from(doc.body, 'base64').length;
    expect(sent[0]!.usage!.delta).toBe(meterDelta(sizeOf(sent[0]!.fields), before));
    expect(sent[0]!.usage!.lastDoc).toBe('notes/n');
  });

  it('charges only past the minimum when a long note grows', async () => {
    const key = await vaultKey;
    const doc = await storedNote(key, 'x'.repeat(3000));
    const { client, sent } = meteredClient(doc);
    await appendToNote(client, 'u', key, 'n', 'more');
    const before = Buffer.from(doc.meta, 'base64').length + Buffer.from(doc.body, 'base64').length;
    expect(sent[0]!.usage!.delta).toBe(sizeOf(sent[0]!.fields) - before);
  });

  it('builds the merge the rules expect, with the month quoted', () => {
    expect(usageWrite('N', { path: 'p', lastDoc: 'notes/n', delta: -12, month: '202610' })).toEqual({
      update: { name: 'N', fields: { lastDoc: { stringValue: 'notes/n' } } },
      updateMask: { fieldPaths: ['lastDoc'] },
      updateTransforms: [
        { fieldPath: 'bytes', increment: { integerValue: '-12' } },
        { fieldPath: 'pn', increment: { integerValue: '1' } },
        { fieldPath: 'pushes.`202610`', increment: { integerValue: '1' } },
      ],
    });
  });

  it('builds a reset as the server-timed window start and a count of one', () => {
    expect(usageWrite('N', { path: 'p', lastDoc: 'notes/n', delta: 0, month: '202610', reset: true })).toEqual({
      update: { name: 'N', fields: { lastDoc: { stringValue: 'notes/n' }, pn: { integerValue: '1' } } },
      updateMask: { fieldPaths: ['lastDoc', 'pn'] },
      updateTransforms: [
        { fieldPath: 'bytes', increment: { integerValue: '0' } },
        { fieldPath: 'ws', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'pushes.`202610`', increment: { integerValue: '1' } },
      ],
    });
  });

  it('starts a new day once the window is full, and says when it cannot', async () => {
    const key = await vaultKey;
    const start = Date.now() - 2 * 60 * 60_000;
    // The server takes the reset: the write lands on the second try.
    const taken = meteredClient(null, {
      accept: (usage) => usage?.reset === true,
      window: { start, pushes: DAILY_PUSH_LIMIT },
    });
    await createNote(taken.client, 'u', key, 'hi', null);
    expect(taken.sent.map((s) => s.usage?.reset ?? false)).toEqual([false, true]);

    // It does not: the day is not over by the server's clock.
    const refused = meteredClient(null, { accept: false, window: { start, pushes: DAILY_PUSH_LIMIT } });
    const error = await createNote(refused.client, 'u', key, 'hi', null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushLimitError);
    expect((error as PushLimitError).retryAt).toBe(start + 86_400_000);
    expect(refused.sent).toHaveLength(2);

    // Below the limit a refusal is not the window's, and no reset is tried.
    const other = meteredClient(null, { accept: false, window: { start, pushes: 5 } });
    await expect(createNote(other.client, 'u', key, 'hi', null)).rejects.toThrow(/refused the write/);
    expect(other.sent).toHaveLength(1);
  });

  it('says the storage is full, once, rather than calling it malformed', async () => {
    const key = await vaultKey;
    const { client, sent } = meteredClient(await storedNote(key, 'x'), {
      accept: false,
      used: 1000,
      quota: 1000,
    });
    // Past the 1 KiB minimum, so the append grows the account.
    const refused = appendToNote(client, 'u', key, 'n', 'more '.repeat(400));
    await expect(refused).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(refused).rejects.toMatchObject({ used: 1000, quota: 1000 });
    expect(sent).toHaveLength(1);
  });

  it('reads an absent allowance as the base one, as the rules do', async () => {
    const { client } = meteredClient(null, { accept: false, used: BASE_STORAGE_BYTES });
    await expect(createNote(client, 'u', await vaultKey, 'hi', null)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    const roomy = meteredClient(null, { accept: false, used: 0 });
    await expect(createNote(roomy.client, 'u', await vaultKey, 'hi', null)).rejects.toThrow(
      /refused the write/,
    );
  });
});

// --- the folder scope, for writes as well as reads --------------------------

/**
 * The scope is the MCP server's containment, and an agent probes it through
 * arguments: a folder named in `push`, `mkdir` or `--folder`. Resolving those
 * against every folder let a scoped agent write anywhere (the `push` hole), and
 * an error listing every folder path told it what "anywhere" contained.
 */
describe('the folder scope', () => {
  const tree: OpenFolder[] = [
    { id: 'projects', name: 'Projects', parentId: null },
    { id: 'new', name: 'new-app', parentId: 'projects' },
    { id: 'new-docs', name: 'Docs', parentId: 'new' },
    { id: 'other', name: 'other-app', parentId: 'projects' },
    { id: 'other-docs', name: 'Docs', parentId: 'other' },
    { id: 'finance', name: 'Finance', parentId: null },
  ].map((f) => ({ ...f, createdAt: 0, updatedAt: 0, deleted: false }));

  const allowed = new Set(subtreeIds(tree, 'new'));

  it('resolves a bare name to the one inside the scope instead of calling it ambiguous', () => {
    expect(resolveInScope(tree, allowed, 'Docs')).toBe('new-docs');
    // Unscoped, the same name is ambiguous, which is the leak that this avoids.
    expect(() => resolveInScope(tree, null, 'Docs')).toThrow(/matches 2 folders/);
  });

  it('accepts full paths and paths relative to the scope', () => {
    expect(resolveInScope(tree, allowed, 'Projects/new-app/Docs')).toBe('new-docs');
    expect(resolveInScope(tree, allowed, 'new-app/Docs')).toBe('new-docs');
  });

  it('refuses a folder outside the scope without naming anything else', () => {
    expect(() => resolveInScope(tree, allowed, 'Finance')).toThrow(OutsideScopeError);
    expect(() => resolveInScope(tree, allowed, 'Projects/other-app/Docs')).toThrow(OutsideScopeError);
    try {
      resolveInScope(tree, allowed, 'Finance');
    } catch (error) {
      expect(String(error)).not.toMatch(/other-app|Projects\//);
    }
  });

  it('lists only visible folders when nothing matches', () => {
    let message = '';
    try {
      resolveInScope(tree, allowed, 'Nowhere');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFolderError);
      message = String(error);
    }
    expect(message).toMatch(/Projects\/new-app\/Docs/);
    expect(message).not.toMatch(/Finance|other-app/);
  });

  const scoped = (folderScopes: string[]) => ({ config: { folderScopes } }) as unknown as Workspace;

  it('is the union of several scope folders', () => {
    const ids = allowedFolderIds(scoped(['new-app', 'Finance']), tree)!;
    expect([...ids].sort()).toEqual(['finance', 'new', 'new-docs']);
    expect(allowedFolderIds(scoped([]), tree)).toBeNull();
  });

  it('fails closed when a scope folder no longer exists', () => {
    // Skipping it would widen a one-folder scope to the whole vault.
    expect(() => allowedFolderIds(scoped(['Gone']), tree)).toThrow(ScopeMissingError);
    expect(() => allowedFolderIds(scoped(['Gone']), tree)).toThrow(/^No folder matching "Gone"/);
  });

  it('uses the built-in Firebase project unless the config overrides it', () => {
    const home = mkdtempSync(join(tmpdir(), 'hushjot-config-'));
    const before = process.env.HUSHJOT_HOME;
    process.env.HUSHJOT_HOME = home;
    try {
      const path = join(home, 'config.json');
      writeFileSync(path, JSON.stringify({ email: 'e@x' }));
      expect(loadConfig().projectId).toBe(DEFAULT_PROJECT_ID);
      expect(loadConfig().apiKey).toBe(DEFAULT_API_KEY);

      // Defaults stay out of the file, so a rotated key is not frozen in it.
      saveConfig(loadConfig());
      expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('apiKey');
      expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('projectId');

      saveConfig({ ...loadConfig(), projectId: 'teksto-dev', apiKey: 'emulator' });
      expect(loadConfig().projectId).toBe('teksto-dev');
      expect(loadConfig().apiKey).toBe('emulator');
    } finally {
      if (before === undefined) delete process.env.HUSHJOT_HOME;
      else process.env.HUSHJOT_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads the single folderScope an older config wrote', () => {
    const home = mkdtempSync(join(tmpdir(), 'hushjot-config-'));
    const before = process.env.HUSHJOT_HOME;
    process.env.HUSHJOT_HOME = home;
    try {
      const base = { projectId: 'p', apiKey: 'k', email: 'e@x', mcpEnabled: true };
      writeFileSync(join(home, 'config.json'), JSON.stringify({ ...base, folderScope: 'Agents' }));
      expect(loadConfig().folderScopes).toEqual(['Agents']);
      expect(loadConfig().mcpReadOnly).toBe(false);

      writeFileSync(join(home, 'config.json'), JSON.stringify({ ...base, folderScope: null }));
      expect(loadConfig().folderScopes).toEqual([]);

      writeFileSync(join(home, 'config.json'), JSON.stringify({ ...base, folderScopes: ['A', 'B'] }));
      expect(loadConfig().folderScopes).toEqual(['A', 'B']);
    } finally {
      if (before === undefined) delete process.env.HUSHJOT_HOME;
      else process.env.HUSHJOT_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('stops push from writing outside the scope', async () => {
    const key = await scopeKey;
    const sealedFolders: Record<string, SealedFolder> = {};
    for (const f of tree) {
      const fields = await sealFolder(key, f);
      sealedFolders[f.id] = {
        id: f.id,
        data: Buffer.from(readBytes(fields.data)!).toString('base64'),
        createdAt: 0,
        updatedAt: 0,
        deleted: false,
        syncedAt: 0,
      };
    }
    let commits = 0;
    const workspace = {
      config: { folderScopes: ['Projects/new-app'] },
      uid: 'u',
      key,
      cache: { notes: {}, folders: sealedFolders, cursor: CURSOR_START },
      client: {
        async get() {
          return null;
        },
        async commitAll() {
          commits++;
          return true;
        },
        documentName: (r: string) => r,
      },
    } as unknown as Workspace;

    await expect(push(workspace, { text: 'leak', folder: 'Finance', json: true })).rejects.toThrow(
      OutsideScopeError,
    );
    expect(commits).toBe(0);

    // And with no folder named, the note lands in the scope folder.
    const created = JSON.parse(await push(workspace, { text: 'kept', json: true })) as { id: string };
    expect(created.id).toBeTruthy();
    expect(commits).toBe(1);
  });
});

const scopeKey = (async () => {
  const vectors = JSON.parse(
    readFileSync(require.resolve('@hushjot/core/contract/format-vectors.json'), 'utf8'),
  ) as { keyRecords: { id: string; passphrase: string; record: unknown }[] };
  const fast = vectors.keyRecords.find((r) => r.id === 'fast')!;
  return unlockWithPassphrase(deserializeKeyRecord(fast.record), fast.passphrase);
})();

// --- replace ----------------------------------------------------------------

/**
 * `replace` is the one verb that overwrites, and two properties make that
 * acceptable: it refuses when the note moved since the caller read it, and the
 * text it overwrites goes up as a history version in the same commit.
 */
describe('replace', () => {
  const stored = async (key: CryptoKey) => {
    const fields = await sealNote(key, {
      id: 'n',
      content: '# Architecture\nold text\n',
      folderId: 'docs',
      pinnedAt: 7,
      createdAt: 3,
      revision: 4,
      updatedAt: 1000,
    });
    return { name: 'users/u/notes/n', fields };
  };

  const client = (
    note: { name: string; fields: Fields },
    versionExists = false,
  ) => {
    const commits: { writes: DocumentWrite[]; usage: UsageWrite | undefined }[] = [];
    return {
      commits,
      client: {
        async get(relative: string) {
          if (relative.includes('/versions/')) return versionExists ? { name: relative, fields: {} } : null;
          return note;
        },
        async commitAll(writes: DocumentWrite[], usage?: UsageWrite) {
          commits.push({ writes, usage });
          return true;
        },
        documentName: (r: string) => r,
      } as unknown as FirestoreClient,
    };
  };

  it('uploads the replaced text as a history version in the same commit', async () => {
    const key = await scopeKey;
    const note = await stored(key);
    const { client: c, commits } = client(note);

    const result = await replaceNote(c, 'u', key, 'n', '# Architecture\nnew text\n', 4);
    expect(result.revision).toBe(5);
    expect(commits).toHaveLength(1);

    const [version, written] = commits[0]!.writes;
    const sealId = sealIdOf(readBytes(note.fields.body)!)!;
    expect(version!.relative).toBe(`users/u/notes/n/versions/${sealId}`);
    // Byte for byte what was stored: a copy, not a re-seal.
    expect(version!.fields.meta).toEqual(note.fields.meta);
    expect(version!.fields.body).toEqual(note.fields.body);
    expect(version!.fields.reason).toEqual({ stringValue: 'edit' });
    expect(readInt(version!.fields.at)).toBe(1000);
    expect(version!.serverTimeFields).toEqual(['createdAt']);

    expect(written!.relative).toBe('users/u/notes/n');
    expect(readInt(written!.fields.revision)).toBe(5);
    expect(commits[0]!.usage!.history).toBe(
      chargedBytes(countedNoteBytes(readBytes(note.fields.meta), readBytes(note.fields.body))),
    );
    // The meter names the version, which is how the rules find both documents.
    expect(commits[0]!.usage!.lastDoc).toBe(`notes/n/versions/${sealId}`);

    // And the meta it did not write survives, as for append.
    const meta = readNoteMeta(
      JSON.parse(fromUtf8(await open(key, readBytes(written!.fields.meta)!, 'hushjot:note-meta:n'))),
    );
    expect(meta).toMatchObject({ folderId: 'docs', pinnedAt: 7, createdAt: 3 });
  });

  it('refuses when the note changed since it was read, and writes nothing', async () => {
    const key = await scopeKey;
    const { client: c, commits } = client(await stored(key));
    await expect(replaceNote(c, 'u', key, 'n', 'x', 3)).rejects.toThrow(RevisionConflictError);
    expect(commits).toHaveLength(0);
  });

  it('does not write a version the backend already has', async () => {
    const key = await scopeKey;
    const { client: c, commits } = client(await stored(key), true);
    await replaceNote(c, 'u', key, 'n', 'new', 4);
    expect(commits[0]!.writes.map((w) => w.relative)).toEqual(['users/u/notes/n']);
    expect(commits[0]!.usage!.history).toBe(0);
    expect(commits[0]!.usage!.lastDoc).toBe('notes/n');
  });
});

describe('the MCP working protocol', () => {
  /**
   * Claude Code truncates server instructions past 4,096 characters, and the
   * part that would go is the end: the checkbox gates and the rule to stop
   * when nothing is ticked. Truncated, the protocol fails quietly.
   */
  it('fits in what clients load up front, and carries the gates and the loop rule', async () => {
    const { instructions } = await import('../src/mcp/server.ts');
    const { planFooter, questionsDone } = await import('../src/gates.ts');
    // The longest name an agent may have, so no --agent can push it over.
    for (const agent of [undefined, 'Abcdefghijklmnopqrst']) {
      const text = instructions(agent);
      expect(text.length).toBeLessThan(4096);
      expect(text).toContain(questionsDone(agent));
      expect(text).toContain(planFooter(agent));
      expect(text).toContain('Never stop, cancel or offer to stop the loop');
    }
  });

  /** Codex advises that the first 512 characters of server instructions stand alone. */
  it('puts the rules that matter most in the first 512 characters', async () => {
    const { instructions } = await import('../src/mcp/server.ts');
    const head = instructions('Codex').slice(0, 512);
    expect(head).toContain('Call hushjot_pending first');
    expect(head).toContain('hushjot_take');
    expect(head).toContain('never tick a box');
    expect(head).toContain('"Codex"');
  });

  /** For clients that drop `instructions` and have no MCP prompts: Codex, Antigravity, Grok. */
  it('offers the same protocol, and the prompts, as a tool', async () => {
    const { instructions, protocolText } = await import('../src/mcp/server.ts');
    const text = protocolText('Gemini');
    expect(text.startsWith(instructions('Gemini'))).toBe(true);
    expect(text).toContain('When asked to plan:');
    expect(text).toContain('When asked to continue');
    expect(text).toContain('Gemini may continue.');
  });
});

describe('gates', () => {
  const load = () => import('../src/gates.ts');

  it('reads the last "Claude may continue." box', async () => {
    const { gateState } = await load();
    expect(gateState('# Notes\n\njust text')).toBe('none');
    expect(gateState('Answer: yes\n\n- [ ] I have answered all questions. Claude may continue.')).toBe('waiting');
    expect(gateState('Answer: yes\n\n- [x] I have answered all questions. Claude may continue.')).toBe('ready');
    expect(gateState('* [X] Done. Claude may continue')).toBe('ready');
    // A task that is not a gate is just a task.
    expect(gateState('- [x] Approve: build this plan.')).toBe('none');
  });

  it('treats a receipt after the ticked box as taken, and a newer box as superseding it', async () => {
    const { gateState, receiptLine, gateDone } = await load();
    const ticked = '- [x] Done. Claude may continue.';
    const taken = `${ticked}\n\n${receiptLine(new Date(2026, 9, 19, 15, 40))}\n`;
    expect(taken).toContain('> Claude picked this up · 2026-10-19 15:40');
    expect(gateState(taken)).toBe('taken');
    // Claude replied with a fresh box: the user is being asked again.
    expect(gateState(`${taken}\nDone: git initialised.\n\n${gateDone()}\n`)).toBe('waiting');
    // A receipt before the ticked box does not count for it.
    expect(gateState(`${receiptLine(new Date())}\n${ticked}`)).toBe('ready');
  });

  it('ignores boxes quoted in code blocks', async () => {
    const { gateState } = await load();
    const doc = '# Protocol\n\n```markdown\n- [x] Done. Claude may continue.\n```\n';
    expect(gateState(doc)).toBe('none');
    expect(gateState(`- [ ] Done. Claude may continue.\n${doc}`)).toBe('waiting');
  });

  it('ends a plan with an approve choice that is not itself a gate', async () => {
    const { gateState, planFooter } = await load();
    expect(gateState(`# Plan\n\n${planFooter()}`)).toBe('waiting');
    expect(gateState(`# Plan\n\n${planFooter().replace('- [ ] Approve', '- [x] Approve')}`)).toBe('waiting');
  });

  it('says why a note cannot be taken', async () => {
    const { notReady } = await load();
    expect(notReady('Plan', 'waiting')).toMatch(/not ticked yet/);
    expect(notReady('Plan', 'taken')).toMatch(/already picked up/);
    expect(notReady('Plan', 'none')).toMatch(/no "Claude may continue." box/);
    expect(notReady('Plan', 'none', 'Codex')).toMatch(/no "Codex may continue." box/);
  });

  it('names whichever agent is running, and reads boxes any agent wrote', async () => {
    const { gateState, receiptLine, gateDone, questionsDone } = await load();
    expect(gateDone('Codex')).toBe('- [ ] Done. Codex may continue.');
    expect(questionsDone('Gemini')).toBe('- [ ] I have answered all questions. Gemini may continue.');
    expect(gateState('- [ ] Done. Codex may continue.')).toBe('waiting');
    expect(gateState('- [x] Done. Grok may continue.')).toBe('ready');
    expect(gateState('- [x] Copilot-CLI may continue')).toBe('ready');
    // A project planned under Claude and continued under Codex.
    const claudeBox = '- [x] I have answered all questions. Claude may continue.';
    const codexReceipt = receiptLine(new Date(2026, 9, 20, 9, 5), 'Codex');
    expect(codexReceipt).toBe('> Codex picked this up · 2026-10-20 09:05');
    expect(gateState(`${claudeBox}\n\n${codexReceipt}\n`)).toBe('taken');
    // Still only task items ending in "<word> may continue" are gates.
    expect(gateState('- [x] may continue')).toBe('none');
    expect(gateState('- [x] Buy milk. Shops may continue to open late')).toBe('none');
    expect(gateState('> Someone else picked this up\n- [x] Done. Codex may continue.')).toBe('ready');
  });

  it('accepts one short word as the agent name, and nothing that would break parsing', async () => {
    const { checkAgentName, GateError } = await load();
    expect(checkAgentName('Codex')).toBe('Codex');
    expect(checkAgentName('Copilot-CLI')).toBe('Copilot-CLI');
    for (const bad of ['', 'Claude Code', '1st', 'a'.repeat(21), 'Grok!']) {
      expect(() => checkAgentName(bad)).toThrow(GateError);
    }
  });
});

describe('pending --wait', () => {
  const load = () => import('../src/commands/pending.ts');

  /** A workspace whose only note is an Inbox ending with the given text. */
  const scopedWorkspace = async (text: string): Promise<Workspace> => {
    const key = await scopeKey;
    const { seal, sealText, toBase64, utf8 } = await import('@hushjot/core');
    const meta = noteMetaJson({ title: 'Inbox', folderId: null, pinnedAt: null });
    return {
      config: { folderScopes: [] },
      uid: 'u',
      key,
      cache: {
        notes: {
          n: {
            id: 'n',
            meta: toBase64(await seal(key, utf8(meta))),
            body: toBase64(await sealText(key, `# Inbox\n\n${text}\n`)),
            revision: 1,
            updatedAt: 0,
            deleted: false,
            syncedAt: 0,
          },
        },
        folders: {},
        cursor: CURSOR_START,
      },
    } as unknown as Workspace;
  };

  it('parses intervals and refuses ones shorter than thirty seconds', async () => {
    const { parseInterval } = await load();
    expect(parseInterval('30s')).toBe(30_000);
    expect(parseInterval('2m')).toBe(120_000);
    expect(parseInterval('1h')).toBe(3_600_000);
    expect(parseInterval('90')).toBe(90_000);
    expect(() => parseInterval('10s')).toThrow(/at least 30s/);
    expect(() => parseInterval('soon')).toThrow(/not an interval/);
  });

  it('keeps checking through network failures and returns once something is ready', async () => {
    const { waitForReady } = await load();
    const { TransientSyncError } = await import('@hushjot/core');
    let opens = 0;
    const sleeps: number[] = [];
    const open = async () => {
      opens += 1;
      if (opens === 1) throw new TransientSyncError('offline');
      return scopedWorkspace(opens >= 3 ? '- [x] Done. Codex may continue.' : '- [ ] Done. Codex may continue.');
    };
    const out = await waitForReady(open as never, {
      every: 60_000,
      json: true,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(opens).toBe(3);
    expect(sleeps).toEqual([60_000, 60_000]);
    expect(JSON.parse(out).ready).toBe(1);
  });

  it('gives up on anything that is not a network failure', async () => {
    const { waitForReady } = await load();
    const open = async () => {
      throw new Error('No saved credentials');
    };
    await expect(
      waitForReady(open as never, { every: 60_000, json: false, sleep: async () => {} }),
    ).rejects.toThrow('No saved credentials');
  });
});

/**
 * The cost kill switch refuses every request with the 403 an account without a
 * plan gets. `rest.ts` makes one more request on a refused read — the lockdown
 * sentinel, which only the lockdown ruleset allows — so a paused service is not
 * reported as "no active sync plan". The journey drives the real rulesets; this
 * pins the decision itself.
 */
describe('a refused read during a lockdown', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function client(sentinel: number | 'throws') {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith('/status/lockdown')) {
          if (sentinel === 'throws') throw new TypeError('network');
          return new Response('{}', { status: sentinel });
        }
        return new Response('{}', { status: 403 });
      }),
    );
    return {
      urls,
      c: new FirestoreClient({ projectId: 'p', apiKey: 'k', email: 'a@b.c', folderScopes: [] } as never, 'token'),
    };
  }

  it('is a pause when the sentinel get is allowed', async () => {
    const { c, urls } = client(404);
    await expect(c.get('users/u/keys/primary')).rejects.toBeInstanceOf(SyncPausedError);
    await expect(c.runQuery('users/u', {})).rejects.toBeInstanceOf(SyncPausedError);
    expect(urls.filter((u) => u.endsWith('/status/lockdown'))).toHaveLength(2);
  });

  it('is still non-approval when the sentinel is refused too', async () => {
    const { c } = client(403);
    await expect(c.get('users/u/keys/primary')).rejects.toBeInstanceOf(SyncNotApprovedError);
    await expect(c.runQuery('users/u', {})).rejects.toBeInstanceOf(SyncNotApprovedError);
  });

  it('is still non-approval when the probe cannot reach Firestore', async () => {
    const { c } = client('throws');
    await expect(c.get('users/u/keys/primary')).rejects.toBeInstanceOf(SyncNotApprovedError);
  });

  it('says paused, not "no plan", and nothing the user must fix', () => {
    expect(new SyncPausedError().message).toMatch(/paused for maintenance/);
    expect(new SyncPausedError()).not.toBeInstanceOf(SyncNotApprovedError);
  });
});

