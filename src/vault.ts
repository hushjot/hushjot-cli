/**
 * Getting the data-encryption key onto this machine, and nowhere else.
 *
 * This is the module the whole product positioning rests on. The account's key
 * record — Argon2id parameters, two random salts, and the DEK wrapped twice —
 * is fetched from Firestore as ciphertext. The passphrase is typed here, the
 * derivation runs here, the unwrap happens here. The backend is handed nothing
 * it did not already have.
 *
 * **The CLI never writes `users/{uid}/keys/primary`.** It is read-only on that
 * document, always. The rules permit create *and* update there and refuse
 * delete outright, so a key record written from outside the app would be
 * permanent — and every browser device already bound to the old one would find
 * itself unable to open notes sealed under the new one. Creating a vault is the
 * app's job, on a screen that can explain what a passphrase is and hand back a
 * recovery code. If the account has no vault, this says so and stops.
 *
 * **Unwrapping is done by hand rather than through `unlockWithPassphrase`.**
 * That helper returns a *non-extractable* `CryptoKey`, which is exactly right
 * for a browser — the key cannot then be exfiltrated by injected script — and
 * exactly wrong here, because the whole point is to put the raw bytes in the OS
 * keychain so the next invocation does not pay 95 ms of Argon2id. So this calls
 * `deriveKekFromPassphrase` and `open` directly, which is the same two steps
 * the helper performs, and keeps the bytes.
 *
 * **Proving the vault is the account's.** The app has a whole apparatus for
 * this (`app:vaultAccount`, `sameKeyRecord`, `classifyVault`) because a browser
 * can hold a locally-created vault that the account has never seen, and
 * uploading notes sealed under it would put ciphertext on the account that none
 * of its other devices can open. The CLI cannot get into that state: it has no
 * local vault, and the only key it ever holds is one it unwrapped from the
 * account's own record. That is strictly stronger than what the browser can
 * prove, and it is why there is no `classifyVault` here.
 */
import { createHash } from 'node:crypto';
import {
  DecryptError,
  WrongSecretError,
  deriveKekFromPassphrase,
  deserializeKeyRecord,
  fromBase64,
  importKey,
  open,
  toBase64,
  type Bytes,
  type SerializedKeyRecord,
} from '@hushjot/core';

import type { Config } from './config.ts';
import { deleteSecret, getSecret, passphraseFromEnvironment, setSecret } from './keychain.ts';
import { promptSecret } from './prompt.ts';
import { type FirestoreClient, readMap } from './rest.ts';

export class NoVaultError extends Error {
  constructor() {
    super(
      'This account has no vault yet. Open HushJot in a browser and create one — ' +
        'the CLI deliberately cannot, because creating a vault issues a recovery ' +
        'code that has to be shown to you once.',
    );
    this.name = 'NoVaultError';
  }
}

/**
 * Names the cached key after the blob the passphrase unwraps. A passphrase
 * change on any device re-randomises the salt and rewrites that blob, so the
 * name changes and this cache misses — invalidation falls out of the format
 * instead of being a message somebody has to remember to send.
 */
function fingerprint(record: SerializedKeyRecord): string {
  return createHash('sha256').update(record.wrappedByPassphrase).digest('hex').slice(0, 32);
}

export async function fetchKeyRecord(
  client: FirestoreClient,
  uid: string,
): Promise<SerializedKeyRecord> {
  const document = await client.get(`users/${uid}/keys/primary`);
  if (!document) throw new NoVaultError();

  const record = readMap(document.fields.record);
  if (!record || typeof record !== 'object') throw new NoVaultError();
  return record as SerializedKeyRecord;
}

export interface Vault {
  key: CryptoKey;
  /** True when Argon2id actually ran, i.e. the keychain cache missed. */
  derived: boolean;
  ms: number;
}

async function unwrap(
  serialized: SerializedKeyRecord,
  passphrase: string,
): Promise<{ raw: Bytes; ms: number }> {
  const record = deserializeKeyRecord(serialized);
  // Parameters come out of the record, never out of a constant — that is what
  // lets the KDF be retuned later without invalidating existing vaults.
  const { key: kek, ms } = await deriveKekFromPassphrase(
    passphrase,
    record.passphrase.salt,
    record.passphrase,
  );

  try {
    return { raw: await open(kek, record.wrappedByPassphrase), ms };
  } catch (error) {
    // GCM's tag failing *is* the wrong-passphrase signal; there is no separate
    // verifier field, deliberately, because one would hand an offline attacker
    // a cheaper target than the real thing.
    if (error instanceof DecryptError) throw new WrongSecretError();
    throw error;
  }
}

/**
 * The account's DEK, from the keychain if it is there and from the passphrase
 * if it is not.
 *
 * `forget` drops the cached copy first, which is what `hushjot logout` and a
 * changed passphrase both want.
 */
export async function openVault(
  config: Config,
  serialized: SerializedKeyRecord,
  options: { forget?: boolean } = {},
): Promise<Vault> {
  const name = `dek:${fingerprint(serialized)}` as const;

  if (options.forget) deleteSecret(config.email, name);
  else {
    const cached = getSecret(config.email, name);
    if (cached) {
      const raw = fromBase64(cached);
      if (raw.length === 32) return { key: await importKey(raw, false), derived: false, ms: 0 };
      // A cached value of the wrong length is a corrupted item, not a wrong
      // passphrase. Drop it and derive rather than reporting a failure the
      // user cannot act on.
      deleteSecret(config.email, name);
    }
  }

  const passphrase = passphraseFromEnvironment() ?? (await promptSecret('Vault passphrase'));
  const { raw, ms } = await unwrap(serialized, passphrase);

  setSecret(config.email, name, toBase64(raw));
  const key = await importKey(raw, false);
  raw.fill(0); // best effort; JS gives no guarantee, but leaving it is worse
  return { key, derived: true, ms };
}

/** Drop every cached key for this account. Used by `hushjot logout`. */
export function forgetVault(config: Config, serialized: SerializedKeyRecord | null): void {
  if (serialized) deleteSecret(config.email, `dek:${fingerprint(serialized)}`);
  deleteSecret(config.email, 'refresh');
  deleteSecret(config.email, 'password');
}
