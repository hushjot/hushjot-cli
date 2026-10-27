/**
 * `hushjot login` — the only command that asks for anything.
 *
 * It does four things in an order chosen so that each failure is reported
 * before the next question is asked. Being told the passphrase is wrong after
 * discovering the account has no sync plan is a worse experience than it
 * sounds, because the two have completely different remedies — one is a
 * passphrase, the other is a purchase at hushjot.com/account.
 *
 * 1. Sign in. Wrong password stops here.
 * 2. Read the key record. This *is* the plan check — every path under
 *    `users/{uid}` is gated on `approved()` (a paid plan or an invitation), so
 *    an account with neither is refused here rather than needing a probe.
 * 3. Unwrap with the passphrase. Wrong passphrase stops here.
 * 4. Save: config to disk, secrets to the keychain.
 *
 * It deliberately cannot create a vault. The app's create screen issues a
 * recovery code that has to be shown to someone exactly once, and a tool that
 * prints one into a terminal scrollback — or worse, into an agent's transcript
 * — is not the right place for that.
 */
import { signInWithPassword } from '../auth.ts';
import { DEFAULT_API_KEY, DEFAULT_PROJECT_ID, saveConfig, type Config } from '../config.ts';
import { backend, canKeepPassword, noStoreError, setSecret } from '../keychain.ts';
import { promptLine, promptSecret } from '../prompt.ts';
import { FirestoreClient } from '../rest.ts';
import { fetchKeyRecord, openVault } from '../vault.ts';

export interface LoginOptions {
  /** Overrides for the emulator and tests; a real login uses the built-in project. */
  project?: string | undefined;
  apiKey?: string | undefined;
  email?: string | undefined;
  folderScope?: string | undefined;
}

export async function login(options: LoginOptions): Promise<string> {
  const projectId = options.project ?? DEFAULT_PROJECT_ID;
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  // Before any question: a machine with no secret store and no
  // HUSHJOT_PASSWORD could sign in now but never again, so say so up front.
  if (!canKeepPassword()) throw noStoreError();
  const email = (options.email ?? (await promptLine('Account email'))).trim().toLowerCase();

  const config: Config = {
    projectId,
    apiKey,
    email,
    folderScopes: options.folderScope ? [options.folderScope] : [],
    // Never enabled by login. Exposing every note to a model is its own
    // decision, made once, by `hushjot mcp enable`.
    mcpEnabled: false,
    mcpReadOnly: false,
  };

  const password =
    process.env.HUSHJOT_PASSWORD ?? (await promptSecret(`Password for ${email}`));

  const { session, refreshToken } = await signInWithPassword(config, password);
  const client = new FirestoreClient(config, session.idToken);

  // Step 2. A SyncNotApprovedError here means the account exists but has no
  // plan or invitation; the message the dispatcher prints says so.
  const record = await fetchKeyRecord(client, session.uid);

  // Step 3. `forget: true` so a re-login after a passphrase change does not
  // hand back a stale cached key and declare success.
  const vault = await openVault(config, record, { forget: true });

  // Step 4. Only now is anything written.
  saveConfig(config);
  setSecret(email, 'password', password);
  setSecret(email, 'refresh', refreshToken);

  const where = {
    'macos-keychain': 'the macOS keychain',
    libsecret: 'the system keyring',
    'windows-credential': 'Windows Credential Manager',
    environment: null,
  }[backend()];

  return [
    `Signed in as ${email}.`,
    where === null
      ? `Vault unlocked in ${vault.ms} ms. No OS keychain, so nothing was stored: every command ` +
        'reads HUSHJOT_PASSWORD and HUSHJOT_PASSPHRASE from the environment (see the README).'
      : `Vault unlocked in ${vault.ms} ms; the key is cached in ${where}.`,
    'The passphrase itself was not stored, and never left this machine.',
  ].join('\n');
}
