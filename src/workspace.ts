/**
 * Everything a command needs, assembled once.
 *
 * The order is not arbitrary. Config, then a session, then the key record, then
 * the vault — each step's failure has a different remedy and a different
 * message, and collapsing them would produce the single worst error a tool like
 * this can give: "something went wrong", when the answer is "run `hushjot
 * login`" or "you are not on the allowlist yet" or "wrong passphrase".
 *
 * `refresh()` is a delta pull, not a fetch. On a warm cache it is one query per
 * collection returning zero documents, which is two billed reads plus the
 * allowlist lookup the rules perform on every request. Commands call it because
 * an agent reading a note the browser wrote a second ago should see it.
 */
import { folderPath, foldersMatching, subtreeIds, type Folder } from '@hushjot/core';

import { currentSession } from './auth.ts';
import { applyPage, loadCache, saveCache, type Cache } from './cache.ts';
import { loadConfig, type Config } from './config.ts';
import { openFolder, openNoteMeta, type OpenFolder, type SealedNote } from './notes.ts';
import { pullAll } from './pull.ts';
import { FirestoreClient } from './rest.ts';
import { fetchKeyRecord, openVault } from './vault.ts';

export interface Workspace {
  config: Config;
  uid: string;
  client: FirestoreClient;
  key: CryptoKey;
  cache: Cache;
  /** True when this invocation paid for Argon2id rather than hitting the keychain. */
  derivedKey: boolean;
}

export async function openWorkspace(options: { refresh?: boolean } = {}): Promise<Workspace> {
  const config = loadConfig();
  const session = await currentSession(config);
  const client = new FirestoreClient(config, session.idToken);

  // Reading the key record is also, incidentally, the approval check: every
  // path under `users/{uid}` is gated on the allowlist, so a refused read here
  // surfaces as SyncNotApprovedError before a passphrase is ever asked for.
  const record = await fetchKeyRecord(client, session.uid);
  const vault = await openVault(config, record);

  const workspace: Workspace = {
    config,
    uid: session.uid,
    client,
    key: vault.key,
    cache: loadCache(session.uid),
    derivedKey: vault.derived,
  };

  if (options.refresh !== false) await refresh(workspace);
  return workspace;
}

export async function refresh(workspace: Workspace): Promise<void> {
  const cursor = await pullAll(workspace.client, workspace.uid, workspace.cache.cursor, (page) =>
    applyPage(workspace.cache, page),
  );
  workspace.cache.cursor = cursor;
  saveCache(workspace.uid, workspace.cache);
}

// --- folders ---------------------------------------------------------------

export async function folders(workspace: Workspace): Promise<OpenFolder[]> {
  const out: OpenFolder[] = [];
  for (const sealed of Object.values(workspace.cache.folders)) {
    if (sealed.deleted) continue;
    out.push(await openFolder(workspace.key, sealed));
  }
  return out;
}

export class UnknownFolderError extends Error {
  /**
   * `known` is null when listing the folders would itself be a disclosure: a
   * scoped caller is told what it may see, never what exists outside.
   */
  constructor(name: string, known: readonly string[] | null) {
    super(
      known === null
        ? `No folder matching "${name}".`
        : `No folder matching "${name}". Known folders: ${known.length ? known.join(', ') : '(none)'}`,
    );
    this.name = 'UnknownFolderError';
  }
}

export class OutsideScopeError extends Error {
  constructor(wanted: string) {
    super(
      `"${wanted}" is outside the folder scope this machine is configured with. ` +
        'Only folders inside the scope can be read or written.',
    );
    this.name = 'OutsideScopeError';
  }
}

export class ScopeMissingError extends Error {
  constructor(scope: string) {
    super(
      `No folder matching "${scope}", which is configured as a folder scope. ` +
        'It may have been renamed or deleted; run `hushjot scope ls` on this machine.',
    );
    this.name = 'ScopeMissingError';
  }
}

/**
 * Resolve what a person typed to exactly one folder id.
 *
 * Accepts an id, a full path (`Code/Rust`), or a bare name when it is
 * unambiguous. A bare name matching two folders is an error rather than a
 * guess — writing a note into the wrong folder is quiet and annoying to undo.
 *
 * The matching itself is `foldersMatching` in core, shared with the app's `in:`
 * search operator, and this is the thin policy on top of it. The split is the
 * point: two implementations of "which folder did they mean" would both work
 * and disagree silently, so `in:work` could select one folder in the browser
 * and a different one in an agent's MCP call with nothing anywhere reporting a
 * problem. What differs legitimately is what to do about ambiguity — a command
 * about to act must stop and ask, while a search box narrows to all of them and
 * lets the results speak — and that is what lives here.
 *
 * No prefix matching, deliberately: resolving `--folder wo` to `Workshop` would
 * act on a folder nobody named.
 *
 * This is the unscoped resolver. Anything a scoped caller names goes through
 * `resolveInScope` instead.
 */
export function resolveFolder(all: readonly OpenFolder[], wanted: string): string {
  const needle = wanted.trim();
  if (needle === '') throw new UnknownFolderError(wanted, []);
  return pickOne(all, needle, foldersMatching(all as readonly Folder[], needle), () =>
    all.map((f) => folderPath(all as readonly Folder[], f.id, '/')),
  );
}

function pickOne(
  all: readonly OpenFolder[],
  needle: string,
  matches: readonly string[],
  known: () => readonly string[] | null,
): string {
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `"${needle}" matches ${matches.length} folders. Use the full path, for example ` +
        matches.map((id) => `"${folderPath(all as readonly Folder[], id, '/')}"`).join(' or '),
    );
  }
  throw new UnknownFolderError(needle, known());
}

/**
 * The folder ids the configured scope admits — the union of every scope
 * folder's subtree — or null when there is no scope and everything is admitted.
 *
 * A scope entry that no longer resolves is an error, never a skip: dropping it
 * would turn a two-folder scope into a one-folder scope silently, and dropping
 * the last one would turn it into the whole vault.
 */
export function allowedFolderIds(workspace: Workspace, all: readonly OpenFolder[]): Set<string> | null {
  const roots = workspace.config.folderScopes;
  if (roots.length === 0) return null;

  const ids = new Set<string>();
  for (const root of roots) {
    const matches = foldersMatching(all as readonly Folder[], root.trim());
    if (matches.length === 0) throw new ScopeMissingError(root);
    // An ambiguous scope entry is the operator's to fix, and they can see the
    // whole tree, so the full error is right here.
    const id = resolveFolder(all, root);
    for (const descendant of subtreeIds(all as readonly Folder[], id)) ids.add(descendant);
  }
  return ids;
}

/**
 * Resolve a folder named by a scoped caller — `--folder`, a tool argument —
 * to one folder inside the scope.
 *
 * Two things this must not do, and both are about an agent probing the edges:
 *
 * - **Widen.** A match outside the scope is refused, not followed. This is the
 *   check `push` was missing: resolving against every folder and writing there.
 * - **Leak.** Matching runs against the whole tree (so a full path such as
 *   `Projects/new-app/Docs` works) but candidates outside the scope are dropped
 *   *before* anything is reported, so an ambiguity error or a "not found" lists
 *   only folders the caller could already see. Otherwise asking for `Docs`
 *   would enumerate every project's `Docs` folder by path.
 *
 * Paths relative to the parent of a scope folder — `new-app/Docs` for a scope
 * of `Projects/new-app` — also resolve, because that is how a scoped caller
 * sees the tree in `ls` output and it should be able to type back what it read.
 */
export function resolveInScope(
  all: readonly OpenFolder[],
  allowed: Set<string> | null,
  wanted: string,
): string {
  if (allowed === null) return resolveFolder(all, wanted);

  const needle = wanted.trim();
  if (needle === '') throw new UnknownFolderError(wanted, null);

  const visible = all.filter((f) => allowed.has(f.id));
  const inScope = foldersMatching(all as readonly Folder[], needle).filter((id) => allowed.has(id));
  const matches = inScope.length > 0 ? inScope : foldersMatching(visible as readonly Folder[], needle);
  if (matches.length > 0) return pickOne(all, needle, matches, () => null);

  // Nothing inside matched. Say "outside the scope" only when something
  // outside did — the caller learns a folder of that name exists somewhere,
  // which is as little as can be said while still explaining the refusal.
  if (foldersMatching(all as readonly Folder[], needle).length > 0) throw new OutsideScopeError(wanted);
  throw new UnknownFolderError(
    needle,
    visible.map((f) => folderPath(all as readonly Folder[], f.id, '/')),
  );
}

/**
 * Confine this process to `wanted`, which must lie inside the configured scope.
 *
 * `hushjot mcp --scope <folder>` is how one Claude Code project gets one
 * HushJot folder while another project on the same machine gets a different
 * one, without either editing the shared config. It can only narrow: each
 * folder named must be inside what the config already admits, so a project's
 * `.mcp.json` cannot hand an agent more than the operator granted. In memory
 * only — nothing is saved.
 */
export async function narrowScope(workspace: Workspace, wanted: readonly string[]): Promise<void> {
  if (wanted.length === 0) return;
  const all = await folders(workspace);
  const allowed = allowedFolderIds(workspace, all);
  const ids = wanted.map((w) => resolveInScope(all, allowed, w));
  workspace.config = { ...workspace.config, folderScopes: ids };
}

/**
 * The notes a command may see.
 *
 * `folderScopes` in the config is the MCP server's containment: with it set, an
 * agent driving this CLI sees those folders' subtrees and nothing else.
 * `--folder` narrows further within that, and can never widen past it.
 */
export async function notesInScope(
  workspace: Workspace,
  narrowTo?: string | undefined,
): Promise<SealedNote[]> {
  const all = await folders(workspace);

  const scopeIds = allowedFolderIds(workspace, all);
  const narrowRoot = narrowTo ? resolveInScope(all, scopeIds, narrowTo) : null;
  const narrowIds =
    narrowRoot === null ? null : new Set(subtreeIds(all as readonly Folder[], narrowRoot));

  const notes: SealedNote[] = [];
  for (const sealed of Object.values(workspace.cache.notes)) {
    if (sealed.deleted) continue;
    notes.push(sealed);
  }
  if (!scopeIds && !narrowIds) return notes;

  // Filtering needs the folder id, which is inside the sealed meta — so this
  // is the one listing path that must open every note's meta. Bodies are still
  // untouched.
  const kept: SealedNote[] = [];
  for (const sealed of notes) {
    const meta = await openNoteMeta(workspace.key, sealed);
    const id = meta.folderId;
    if (id === null) continue;
    if (scopeIds && !scopeIds.has(id)) continue;
    if (narrowIds && !narrowIds.has(id)) continue;
    kept.push(sealed);
  }
  return kept;
}
