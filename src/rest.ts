/**
 * Firestore over REST, with no SDK.
 *
 * The rules are enforced identically either way — the REST endpoint is the same
 * Firestore the browser talks to, and `firestore.rules` never sees which
 * transport a request arrived on. What the SDK adds is a local cache, a
 * listener protocol and a write queue, none of which a process that exits in
 * eighty milliseconds can use.
 *
 * Four things here are load-bearing and each has cost somebody a day:
 *
 * **`syncedAt` must be a server transform, not a timestamp we send.** The rules
 * require `syncedAt == request.time` exactly. A client clock — even a correct
 * one — is refused. That is deliberate in the app's design: it stops a device
 * with a skewed clock from hiding its writes from another device's delta
 * cursor. It means writes go through `:commit` with an `updateTransforms`
 * entry, not through the document `PATCH` endpoint.
 *
 * **No `updateMask`.** The rules check the *resulting* document with
 * `keys().hasOnly([...])` and `keys().hasAll([...])`. A masked write produces a
 * document missing required fields and is refused, so every write is a full
 * replace.
 *
 * **Ciphertext is `bytesValue`, never `stringValue`.** The rules reject strings
 * outright, so a client that forgot to encrypt fails loudly instead of quietly
 * uploading readable notes. Over REST a `bytesValue` is standard base64 *with
 * padding* — not base64url.
 *
 * **A 403 on a write is ambiguous.** Firestore says "your revision is stale"
 * and "you may not write here" with the same status. The app's adapter
 * disambiguates by re-reading the document — reads carry no revision check, so
 * a read that is also refused means authorisation — and `docs/security.md`
 * records what happens when the two are confused: an authorisation failure read
 * as a conflict forks the note on every retry, forever. `commit` therefore
 * returns `false` on a 403 rather than throwing, and `write.ts` makes the
 * second request that decides what it meant. *
 * **Every note write carries the storage meter.** The rules will refuse a note
 * write whose commit does not move `users/{uid}/usage/current.bytes` by exactly
 * the change in charged ciphertext, and does not count one push against the
 * daily limit (`@hushjot/core`'s `sync/usage.ts` has the wire shape). So
 * `commit` takes the meter as a second write in the same request. That write is
 * the one exception to "no `updateMask`": the meter is merged into, never
 * replaced, because no client holds all of it.
 *
 * **A refused read is checked for a pause before it is believed.** The cost
 * kill switch releases rules that refuse every request, so during a lockdown
 * every read is the same 403 an account without a plan gets. The lockdown
 * ruleset allows exactly one `get`, of `LOCKDOWN_SENTINEL`, which the normal
 * rules refuse; so a refused read makes that one request, and an allowed one
 * (404 — the document does not exist) raises `SyncPausedError` instead of
 * `SyncNotApprovedError`. A refused write reaches the same place through
 * `write.ts`'s deciding read. One extra request, only on a refusal.
 */
import {
  LOCKDOWN_SENTINEL,
  SessionExpiredError,
  SyncNotApprovedError,
  SyncPausedError,
  TransientSyncError,
  fromBase64,
  toBase64,
  type Bytes,
} from '@hushjot/core';

import type { Config } from './config.ts';
import { endpoints } from './config.ts';

export type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { bytesValue: string }
  | { timestampValue: string }
  | { referenceValue: string }
  | { mapValue: { fields?: Record<string, Value> } }
  | { arrayValue: { values?: Value[] } };

export type Fields = Record<string, Value>;

export interface Document {
  /** The full resource name, `projects/…/documents/users/{uid}/notes/{id}`. */
  name: string;
  fields: Fields;
}

// --- value encoding --------------------------------------------------------

/** Firestore renders a 64-bit integer as a *string*, so that JSON keeps it. */
export const int = (n: number): Value => ({ integerValue: String(Math.trunc(n)) });
export const bool = (b: boolean): Value => ({ booleanValue: b });
export const bytes = (b: Uint8Array): Value => ({ bytesValue: toBase64(b) });
export const timestamp = (ms: number): Value => ({ timestampValue: new Date(ms).toISOString() });
export const str = (text: string): Value => ({ stringValue: text });

export function readInt(value: Value | undefined): number | null {
  if (!value || !('integerValue' in value)) return null;
  return Number(value.integerValue);
}

export function readBool(value: Value | undefined): boolean {
  return Boolean(value && 'booleanValue' in value && value.booleanValue);
}

export function readBytes(value: Value | undefined): Bytes | null {
  if (!value || !('bytesValue' in value)) return null;
  return fromBase64(value.bytesValue);
}

/**
 * Timestamps come back with microsecond precision and `Date.parse` keeps
 * milliseconds. The truncation rounds *down*, which matters: a delta cursor
 * built from a truncated value resumes fractionally earlier than it should, so
 * the worst case is a document delivered twice. Rounding up would skip one, and
 * a skipped document is lost rather than delayed.
 */
export function readTimestamp(value: Value | undefined): number | null {
  if (!value || !('timestampValue' in value)) return null;
  const parsed = Date.parse(value.timestampValue);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A map field, which is how the key record is stored. Returned as plain JSON. */
export function readMap(value: Value | undefined): unknown {
  if (!value) return null;
  if ('mapValue' in value) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.mapValue.fields ?? {})) out[k] = readMap(v);
    return out;
  }
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(readMap);
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('timestampValue' in value) return value.timestampValue;
  return null;
}

// --- the storage meter -----------------------------------------------------

/** The meter's half of a note write. See `sync/usage.ts` in core. */
export interface UsageWrite {
  /** `users/{uid}/usage/current`, relative to `documents/`. */
  path: string;
  /**
   * The document this commit changes, relative to `users/{uid}`: `notes/{id}`,
   * `folders/{id}`, or `notes/{id}/versions/{versionId}` when the commit also
   * uploads that version (a `replace`).
   */
  lastDoc: string;
  /** The change in charged bytes, `meterDelta(new, old)`. May be negative or zero. */
  delta: number;
  /** `usageMonth(now)`, the bucket the push is counted in. */
  month: string;
  /**
   * Charged bytes of the one history version uploaded in the same commit,
   * added to this month's `hist` figure. The rules accept a version only when
   * that figure rises by exactly its charge, in the commit that creates it.
   */
  history?: number | undefined;
  /**
   * Start a new push window (`ws` = the server's time, `pn` = 1) instead of
   * counting into the current one. Sent only after a refusal showed the window
   * full; the rules take it only if that window is over a day old.
   */
  reset?: boolean | undefined;
}

/**
 * A merge into the meter. Increments rather than values, so two writers at once
 * both land. The month is backtick-quoted because a field path segment may not
 * start with a digit.
 */
export function usageWrite(name: string, usage: UsageWrite): unknown {
  return {
    update: {
      name,
      fields: { lastDoc: { stringValue: usage.lastDoc }, ...(usage.reset ? { pn: int(1) } : {}) },
    },
    updateMask: { fieldPaths: usage.reset ? ['lastDoc', 'pn'] : ['lastDoc'] },
    updateTransforms: [
      { fieldPath: 'bytes', increment: int(usage.delta) },
      usage.reset
        ? { fieldPath: 'ws', setToServerValue: 'REQUEST_TIME' }
        : { fieldPath: 'pn', increment: int(1) },
      { fieldPath: `pushes.\`${usage.month}\``, increment: int(1) },
      ...(usage.history
        ? [{ fieldPath: `hist.\`${usage.month}\``, increment: int(usage.history) }]
        : []),
    ],
  };
}

// --- the client ------------------------------------------------------------

/** One full-replace document write: see the header on why there is no mask. */
export interface DocumentWrite {
  relative: string;
  fields: Fields;
  /** Fields the server fills with `request.time`, which the rules demand. */
  serverTimeFields: readonly string[];
}

export class FirestoreClient {
  readonly #config: Config;
  readonly #idToken: string;
  readonly #base: string;

  constructor(config: Config, idToken: string) {
    this.#config = config;
    this.#idToken = idToken;
    this.#base = endpoints(config).firestore;
  }

  /** The resource name a `referenceValue` needs, for a path below `documents/`. */
  documentName(relative: string): string {
    return `projects/${this.#config.projectId}/databases/(default)/documents/${relative}`;
  }

  async #request(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#idToken}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    } catch (cause) {
      throw new TransientSyncError(`could not reach Firestore: ${String(cause)}`);
    }
  }

  /**
   * Everything but 403 is decided here. 403 is handed back to the caller,
   * because on a write it has two meanings and only a second request can tell
   * them apart.
   */
  #classify(response: Response, context: string): never {
    if (response.status === 401) throw new SessionExpiredError();
    if (response.status === 429 || response.status >= 500) {
      throw new TransientSyncError(`${context}: HTTP ${response.status}`);
    }
    throw new Error(`${context}: HTTP ${response.status}`);
  }

  /**
   * A read was refused: either this account may not sync, or every client is
   * refused for now. See the header. A probe that cannot reach Firestore says
   * nothing, so the refusal stands as it was.
   */
  async #refused(): Promise<never> {
    let paused = false;
    try {
      const probe = await this.#request(`${this.#base}/${LOCKDOWN_SENTINEL}`);
      paused = probe.status === 404 || probe.ok;
    } catch {
      paused = false;
    }
    throw paused ? new SyncPausedError() : new SyncNotApprovedError();
  }

  /** A single document, or null when it is absent — or refused, on a read. */
  async get(relative: string): Promise<Document | null> {
    const response = await this.#request(`${this.#base}/${relative}`);
    if (response.status === 404) return null;
    if (response.status === 403) return this.#refused();
    if (!response.ok) this.#classify(response, `GET ${relative}`);
    const body = (await response.json()) as { name?: string; fields?: Fields };
    if (!body.name) return null;
    return { name: body.name, fields: body.fields ?? {} };
  }

  /**
   * A structured query. `parent` is relative to `documents/` and names the
   * *document* a collection hangs off — `users/{uid}` for `users/{uid}/notes`.
   */
  async runQuery(parent: string, structuredQuery: unknown): Promise<Document[]> {
    const url = parent ? `${this.#base}/${parent}:runQuery` : `${this.#base}:runQuery`;
    const response = await this.#request(url, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery }),
    });
    if (response.status === 403) return this.#refused();
    if (!response.ok) this.#classify(response, `runQuery ${parent}`);

    const rows = (await response.json()) as { document?: Document }[];
    const out: Document[] = [];
    for (const row of rows) {
      if (row.document?.name) out.push({ name: row.document.name, fields: row.document.fields ?? {} });
    }
    return out;
  }

  /**
   * One write, with `syncedAt` (or whatever `serverTimeFields` names) filled in
   * by the server. Returns false on 403 so the caller can disambiguate.
   */
  async commit(
    relative: string,
    fields: Fields,
    serverTimeFields: readonly string[],
    usage?: UsageWrite,
  ): Promise<boolean> {
    return this.commitAll([{ relative, fields, serverTimeFields }], usage);
  }

  /**
   * Several documents and the meter, all or nothing. `replace` needs this: the
   * history copy of the old text and the new text must land together, or a
   * refusal between them would leave an overwrite with nothing to restore.
   */
  async commitAll(documents: readonly DocumentWrite[], usage?: UsageWrite): Promise<boolean> {
    const writes: unknown[] = documents.map(({ relative, fields, serverTimeFields }) => ({
      update: { name: this.documentName(relative), fields },
      updateTransforms: serverTimeFields.map((fieldPath) => ({
        fieldPath,
        setToServerValue: 'REQUEST_TIME',
      })),
    }));
    if (usage) writes.push(usageWrite(this.documentName(usage.path), usage));
    const relative = documents.map((d) => d.relative).join(', ');

    const response = await this.#request(`${this.#base}:commit`, {
      method: 'POST',
      body: JSON.stringify({ writes }),
    });

    if (response.status === 403) return false;
    if (!response.ok) this.#classify(response, `commit ${relative}`);
    return true;
  }
}
