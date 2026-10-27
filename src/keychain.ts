/**
 * Secrets, in the operating system's own store.
 *
 * Three things are kept here and nothing else is:
 *
 * - `password` — the Firebase account password, used to mint the first ID token.
 * - `refresh`  — the refresh token, so most invocations skip a password round trip.
 * - `dek:<fingerprint>` — the raw 32-byte data-encryption key, base64.
 *
 * **Why the DEK is cached.** Argon2id at the vault's parameters costs about
 * 95 ms on a laptop, and an agent calling `hushjot cat` in a loop pays it every
 * time. The browser has the same problem and answers it the same way — "Stay
 * unlocked on this device" keeps the DEK in IndexedDB as a non-extractable
 * `CryptoKey`. The OS keychain is a strictly better home than that: it is
 * encrypted at rest, gated by the login session, and not readable by a script
 * that merely has the user's browser profile.
 *
 * **Why the fingerprint is part of the name.** It is a SHA-256 of the key
 * record's `wrappedByPassphrase`. Changing the passphrase on *any* device
 * re-randomises the passphrase salt and rewrites that blob, so the fingerprint
 * changes, so this cache misses and the CLI derives again. Invalidation is
 * therefore a consequence of the format rather than a message anybody has to
 * remember to send.
 *
 * **No native module.** §28 of the spec says prefer platform capabilities, and
 * the platforms already have this: `security` on macOS, `secret-tool` on Linux,
 * Credential Manager on Windows. `keytar` and friends are a compiler and a
 * prebuild matrix for something the OS ships. Calls go through `execFile` with
 * an argument array, never a shell, so nothing lands in shell history.
 *
 * **Windows goes through Windows PowerShell 5.1**, which every Windows 10 and
 * 11 ships, calling `CredReadW`/`CredWriteW` in advapi32 via `Add-Type`. Not
 * `cmdkey`: it can write a credential but never read one back, and it takes
 * the secret as an argument. Not WinRT's `PasswordVault`: it needs no compile,
 * but Microsoft documents a limit of 20 credentials per app, and every
 * unpackaged program on the machine plausibly counts as the same app. The
 * script is passed with `-EncodedCommand` and the secret on stdin, base64 both
 * ways so no console code page can mangle a non-ASCII password — which makes
 * Windows the one platform where the secret is never in an argv. The price is
 * starting PowerShell and compiling a small type on each call, around a second;
 * a CLI command makes two reads, the MCP server makes them once at startup.
 * Items are `Generic` credentials named `hushjot:<email>:<name>`, persisted to
 * this machine only (never roamed with the user's profile), which is what
 * Credential Manager shows under Windows Credentials.
 *
 * The one thing this cannot hide: on macOS the secret is an argv to `security`,
 * so it is briefly visible to `ps` on a shared machine. There is no stdin mode
 * for `security add-generic-password` to use instead. It is written down here
 * rather than left to be discovered.
 *
 * **Where there is no store at all** — a container, CI, a headless Linux box
 * with no Secret Service — the `environment` backend persists nothing. The
 * password comes from `HUSHJOT_PASSWORD` on every run, the refresh token is
 * simply not kept (each run signs in again), and the DEK is derived again from
 * `HUSHJOT_PASSPHRASE` each time, ~95 ms. That is slower and weaker, and
 * `hushjot status` says so, but it works, where throwing would leave those
 * machines with no way in at all.
 */
import { execFileSync } from 'node:child_process';

const SERVICE = 'hushjot';

export type SecretName = 'password' | 'refresh' | `dek:${string}`;

export type Backend = 'macos-keychain' | 'libsecret' | 'windows-credential' | 'environment';

const BACKENDS: readonly Backend[] = ['macos-keychain', 'libsecret', 'windows-credential', 'environment'];

const ENV_FOR: Record<string, string> = {
  password: 'HUSHJOT_PASSWORD',
  refresh: 'HUSHJOT_REFRESH_TOKEN',
  passphrase: 'HUSHJOT_PASSPHRASE',
};

function tryExec(command: string, args: string[], input?: string): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      ...(input === undefined ? {} : { input }),
    });
  } catch {
    return null;
  }
}

function has(command: string): boolean {
  return tryExec('/usr/bin/which', [command]) !== null;
}

let cached: Backend | undefined;

/**
 * Which store this machine will use. `environment` is the fallback rather than
 * a choice: it is what a container, a CI run, or a platform with no backend
 * gets, and `hushjot status` reports it so it is never a surprise.
 *
 * `HUSHJOT_SECRET_STORE` names one explicitly, and is read on every call like
 * the other overrides. It is for a Linux box that has `secret-tool` installed
 * but no keyring daemon to answer it, and for tests.
 */
export function backend(): Backend {
  const forced = process.env.HUSHJOT_SECRET_STORE;
  if (forced) {
    if (!(BACKENDS as readonly string[]).includes(forced)) {
      throw new Error(`HUSHJOT_SECRET_STORE must be one of ${BACKENDS.join(', ')}.`);
    }
    return forced as Backend;
  }
  if (cached) return cached;
  if (process.platform === 'win32') cached = 'windows-credential';
  else if (process.platform === 'darwin' && has('security')) cached = 'macos-keychain';
  else if (has('secret-tool')) cached = 'libsecret';
  else cached = 'environment';
  return cached;
}

const accountKey = (account: string, name: SecretName) => `${account}:${name}`;

/**
 * Environment variables win when they are set, because the alternative is a
 * test or a container silently reading a developer's real keychain. They cover
 * only the two named secrets; a cached DEK is never taken from the environment,
 * since deriving it again is cheap enough and a raw key in an environment
 * variable is the one place it should not be.
 */
function fromEnvironment(name: SecretName): string | null {
  const variable = ENV_FOR[name];
  if (!variable) return null;
  return process.env[variable] ?? null;
}

// --- Windows ----------------------------------------------------------------

/** Absolute, so a `powershell.exe` earlier on PATH is never the one handed a secret. */
function powershell(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
}

const CRED_TYPE = String.raw`
using System;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
public static class HushjotCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (b.Length > 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return b;
    } finally { CredFree(p); }
  }
  public static bool Write(string target, byte[] blob) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = "hushjot"; c.Persist = 2;
    c.CredentialBlobSize = blob.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(blob.Length, 1));
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      return CredWriteW(ref c, 0);
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, 1, 0); }
}
`;

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/**
 * One call into Credential Manager. Type 1 is `CRED_TYPE_GENERIC`, persist 2 is
 * `CRED_PERSIST_LOCAL_MACHINE`. A read prints the blob as base64 and exits 3
 * when there is no such item; a write reads base64 from stdin.
 */
function windowsCredential(op: 'read' | 'write' | 'delete', target: string, secret?: string): string | null {
  const action = {
    read: '$b = [HushjotCred]::Read($t); if ($null -eq $b) { exit 3 }; [Console]::Out.Write([Convert]::ToBase64String($b))',
    write:
      '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); if (-not [HushjotCred]::Write($t, $b)) { exit 4 }; [Console]::Out.Write("ok")',
    delete: '[void][HushjotCred]::Delete($t)',
  }[op];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition @'\n${CRED_TYPE}\n'@`,
    `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(target)}'))`,
    action,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = tryExec(
    powershell(),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    secret === undefined ? '' : b64(secret),
  );
  if (out === null || op !== 'read') return out;
  return Buffer.from(out.trim(), 'base64').toString('utf8');
}

const windowsTarget = (key: string) => `${SERVICE}:${key}`;

// --- the three operations ---------------------------------------------------

export function getSecret(account: string, name: SecretName): string | null {
  const fromEnv = fromEnvironment(name);
  if (fromEnv) return fromEnv;

  const key = accountKey(account, name);
  switch (backend()) {
    case 'macos-keychain': {
      const out = tryExec('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w']);
      return out === null ? null : out.replace(/\n$/, '');
    }
    case 'libsecret': {
      const out = tryExec('secret-tool', ['lookup', 'service', SERVICE, 'account', key]);
      return out === null || out === '' ? null : out;
    }
    case 'windows-credential': {
      const out = windowsCredential('read', windowsTarget(key));
      return out === null || out === '' ? null : out;
    }
    case 'environment':
      return null;
  }
}

/**
 * Whether `login` can keep this machine signed in. Asked before anything is
 * saved, so a login that cannot persist the password fails without leaving a
 * config behind that points at credentials nobody stored.
 */
export function canKeepPassword(): boolean {
  return backend() !== 'environment' || Boolean(process.env[ENV_FOR.password!]);
}

export function noStoreError(): Error {
  return new Error(
    'No OS keychain on this machine (looked for `security` and `secret-tool`). ' +
      `Set ${ENV_FOR.password} and ${ENV_FOR.passphrase} in the environment instead — ` +
      'and be aware that is the weaker option: an environment variable is readable ' +
      'by every process you start, including an agent.',
  );
}

export function setSecret(account: string, name: SecretName, secret: string): void {
  const key = accountKey(account, name);
  switch (backend()) {
    case 'macos-keychain': {
      // -U updates in place; without it a second login leaves a duplicate item
      // and `find-generic-password` returns whichever the keychain prefers.
      const out = tryExec('security', [
        'add-generic-password',
        '-U',
        '-s',
        SERVICE,
        '-a',
        key,
        '-w',
        secret,
      ]);
      if (out === null) throw new Error(`could not write "${name}" to the macOS keychain`);
      return;
    }
    case 'libsecret': {
      const out = tryExec(
        'secret-tool',
        ['store', '--label', `HushJot ${name}`, 'service', SERVICE, 'account', key],
        secret,
      );
      if (out === null) {
        throw new Error(
          `could not write "${name}" via secret-tool — is a keyring (GNOME Keyring, KWallet) running ` +
            'and unlocked? Without one, set HUSHJOT_SECRET_STORE=environment.',
        );
      }
      return;
    }
    case 'windows-credential': {
      const out = windowsCredential('write', windowsTarget(key), secret);
      if (out === null) throw new Error(`could not write "${name}" to Windows Credential Manager`);
      return;
    }
    case 'environment':
      // Nothing is persisted. A refresh token is not kept (the next run signs
      // in again), a DEK is derived again, and the password must already be
      // in the environment — `canKeepPassword` is how login checks that.
      if (name === 'password' && !canKeepPassword()) throw noStoreError();
      return;
  }
}

export function deleteSecret(account: string, name: SecretName): void {
  const key = accountKey(account, name);
  switch (backend()) {
    case 'macos-keychain':
      tryExec('security', ['delete-generic-password', '-s', SERVICE, '-a', key]);
      return;
    case 'libsecret':
      tryExec('secret-tool', ['clear', 'service', SERVICE, 'account', key]);
      return;
    case 'windows-credential':
      windowsCredential('delete', windowsTarget(key));
      return;
    case 'environment':
      return;
  }
}

/** The passphrase is read, never written: `login` takes it and derives with it. */
export function passphraseFromEnvironment(): string | null {
  return process.env[ENV_FOR.passphrase!] ?? null;
}
