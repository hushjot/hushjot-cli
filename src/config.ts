/**
 * Where the CLI keeps the things that are not secret.
 *
 * The app's configuration convention is `VITE_*` environment variables baked in
 * at build time, which is a Vite idea and does not exist for a long-lived
 * process a user installs once. So this is a file: `~/.hushjot/config.json`.
 *
 * Nothing in it is confidential. The email address is the account's, and it is
 * already in the token. The Firebase project id and web API key are not asked
 * for at all: there is one production project, so they are the constants
 * below, and the file only carries them when something overrides them (the
 * emulator journey logs in with `--project` / `--api-key`). Leaving the
 * defaults out of the file means a rotated key reaches every install with the
 * next release instead of being frozen in each config. The secrets — account password, refresh token, and the
 * derived data key — live in the OS keychain instead (`keychain.ts`).
 *
 * The environment overrides exist for two callers that cannot use a home
 * directory: the emulator-backed integration tests, and a container. They are
 * read every time rather than cached, so a test can move the whole world
 * between cases.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The one production Firebase project. Both values are public by design —
 * `docs/firebase-setup.md` in the app repo says so, and they match
 * `VITE_FIREBASE_*` in `hushjot/.env.production`. The key authorises nothing;
 * every access decision is made by `firestore.rules` against the caller's ID
 * token. If the key is ever rotated, this is the place to change it.
 */
export const DEFAULT_PROJECT_ID = 'hushjot';
export const DEFAULT_API_KEY = 'AIzaSyDzR7lXm7zcxpfmTTQDxYs_qXusLKMSdNQ'; // gitleaks:allow (public by design, above)

export interface Config {
  /** Firebase project id, e.g. `hushjot`. */
  projectId: string;
  /** Firebase web API key. Public; identifies the project, authorises nothing. */
  apiKey: string;
  /** The account signed in with. Also the allowlist document id, lowercased. */
  email: string;
  /**
   * When non-empty, every command and every MCP tool sees only these folders'
   * subtrees, reading *and* writing. The point is the MCP server: handing a
   * model the whole vault is a different decision from handing it a project
   * folder, and this is how the smaller one is made. Empty means the whole
   * vault.
   *
   * A list rather than one folder because the workflow it serves is one folder
   * per project, and someone with two projects on the go should not have to
   * choose between re-scoping on every switch and scoping to a common parent
   * that also holds everything else. Entries are what the person typed (a
   * name, path or id) and are resolved on every use, so renaming or deleting a
   * scope folder fails closed rather than silently widening.
   *
   * Written as `folderScope` (one string or null) before multiple scopes
   * existed; `loadConfig` still reads that key so an upgrade keeps its scope.
   */
  folderScopes: string[];
  /**
   * The MCP server refuses to start until this is true. An MCP server exposes
   * every note to whatever model is driving it, which is worth one deliberate
   * action rather than being a side effect of installing a CLI.
   */
  mcpEnabled: boolean;
  /**
   * The MCP server advertises only the read tools. For someone who wants an
   * agent to look things up and nothing more — the behaviour before the server
   * could write — without trusting the model to leave the write tools alone.
   */
  mcpReadOnly: boolean;
}

export interface Endpoints {
  identityToolkit: string;
  secureToken: string;
  firestore: string;
}

/** `~/.hushjot`, or wherever `HUSHJOT_HOME` says. */
export function stateDir(): string {
  return process.env.HUSHJOT_HOME ?? join(homedir(), '.hushjot');
}

export function configPath(): string {
  return join(stateDir(), 'config.json');
}

/**
 * Where the ciphertext cache lives, per account. Keyed by uid rather than by
 * email so that a renamed account does not orphan its cache, and so two
 * accounts on one machine cannot read each other's rows.
 */
export function cacheDir(uid: string): string {
  return join(stateDir(), 'cache', uid);
}

/**
 * Emulator support, and the only reason these are not constants. Both take a
 * `host:port` and switch the scheme to http, because `firebase emulators:exec`
 * serves plain HTTP on loopback.
 */
export function endpoints(config: Config): Endpoints {
  const authHost = process.env.HUSHJOT_AUTH_HOST;
  const firestoreHost = process.env.HUSHJOT_FIRESTORE_HOST;

  return {
    // The emulator mounts the Identity Toolkit API under its own host at the
    // same path, which is why this is a prefix swap rather than a different
    // code path.
    identityToolkit: authHost
      ? `http://${authHost}/identitytoolkit.googleapis.com/v1`
      : 'https://identitytoolkit.googleapis.com/v1',
    secureToken: authHost
      ? `http://${authHost}/securetoken.googleapis.com/v1`
      : 'https://securetoken.googleapis.com/v1',
    firestore: firestoreHost
      ? `http://${firestoreHost}/v1/projects/${config.projectId}/databases/(default)/documents`
      : `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`,
  };
}

export class NotConfiguredError extends Error {
  constructor() {
    super('No HushJot account configured on this machine. Run `hushjot login` first.');
    this.name = 'NotConfiguredError';
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${configPath()}: "${field}" is missing or not a string`);
  }
  return value;
}

export function loadConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch {
    throw new NotConfiguredError();
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    projectId: orDefault(parsed.projectId, DEFAULT_PROJECT_ID),
    apiKey: orDefault(parsed.apiKey, DEFAULT_API_KEY),
    email: asString(parsed.email, 'email'),
    folderScopes: readScopes(parsed),
    mcpEnabled: parsed.mcpEnabled === true,
    mcpReadOnly: parsed.mcpReadOnly === true,
  };
}

function orDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** `folderScopes`, or the single `folderScope` an older version wrote. */
function readScopes(parsed: Record<string, unknown>): string[] {
  if (Array.isArray(parsed.folderScopes)) {
    return parsed.folderScopes.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  }
  return typeof parsed.folderScope === 'string' && parsed.folderScope.trim() !== ''
    ? [parsed.folderScope]
    : [];
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 0600: it holds no secret, but it names the account, and a config a second
  // user on the box can rewrite is a config that can point this CLI at someone
  // else's project.
  const { projectId, apiKey, ...rest } = config;
  const stored = {
    ...(projectId === DEFAULT_PROJECT_ID ? {} : { projectId }),
    ...(apiKey === DEFAULT_API_KEY ? {} : { apiKey }),
    ...rest,
  };
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}
