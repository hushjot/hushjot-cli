/**
 * Turning what someone typed into one note.
 *
 * An id is a UUID nobody memorises, so every command that takes a note also
 * takes a title. That makes ambiguity possible, and the rule throughout is the
 * same as for folders: **never guess**. Two notes called "Notes" produce an
 * error listing both ids, not a coin flip — because the commands on the other
 * side of this include `append`, and appending to the wrong note is silent.
 *
 * Matching is: exact id, then exact title (case-insensitive), then unique
 * prefix of a title. The prefix step is what makes the tool usable by hand; it
 * is last so it can never beat an exact match.
 */
import { orderForList } from '@hushjot/core';

import { openNoteMeta, type SealedNote } from './notes.ts';
import type { Workspace } from './workspace.ts';

export interface Candidate {
  sealed: SealedNote;
  title: string;
  folderId: string | null;
  /** Pin time, or null. `orderForList` sorts on this. */
  pinnedAt: number | null;
  /** Carried up from the sealed row so `orderForList` can break ties on it. */
  updatedAt: number;
  excerpt: string;
}

/** Opens every note's *meta* — never a body. Bodies are read on demand. */
export async function describeAll(
  workspace: Workspace,
  notes: readonly SealedNote[],
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const sealed of notes) {
    const meta = await openNoteMeta(workspace.key, sealed);
    out.push({
      sealed,
      title: meta.title,
      folderId: meta.folderId,
      pinnedAt: meta.pinnedAt,
      updatedAt: sealed.updatedAt,
      excerpt: meta.excerpt ?? '',
    });
  }
  // Pins first, by pin time, then by recency — the same order every list view
  // in the app uses, so a note at the top here is at the top there.
  return [...orderForList(out)];
}

export class NoteNotFoundError extends Error {
  constructor(wanted: string) {
    super(`No note matching "${wanted}".`);
    this.name = 'NoteNotFoundError';
  }
}

export class AmbiguousNoteError extends Error {
  constructor(wanted: string, matches: readonly Candidate[]) {
    super(
      `"${wanted}" matches ${matches.length} notes:\n` +
        matches.map((m) => `  ${m.sealed.id}  ${m.title}`).join('\n') +
        '\nUse the id.',
    );
    this.name = 'AmbiguousNoteError';
  }
}

export function pickNote(candidates: readonly Candidate[], wanted: string): Candidate {
  const needle = wanted.trim();
  if (needle === '') throw new NoteNotFoundError(wanted);

  const byId = candidates.find((c) => c.sealed.id === needle);
  if (byId) return byId;

  const lower = needle.toLowerCase();

  const exact = candidates.filter((c) => c.title.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new AmbiguousNoteError(wanted, exact);

  const prefix = candidates.filter((c) => c.title.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) throw new AmbiguousNoteError(wanted, prefix);

  throw new NoteNotFoundError(wanted);
}
