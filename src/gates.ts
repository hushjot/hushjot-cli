/**
 * Gates: the checkbox a person ticks in a note to say "I'm done, carry on".
 *
 * The agent workflow runs on notes a person edits on a phone while an agent
 * polls them from a desk. HushJot autosaves as they type, so a note is never
 * "submitted": an agent reading it may see half an answer. A gate is the
 * submit button. Any task-list line whose text ends "Claude may continue." is
 * one, so the wording before it can suit the note:
 *
 *     - [ ] I have answered all questions. Claude may continue.
 *     - [ ] Done. Claude may continue.
 *
 * Only the **last** gate in a note counts. A thread such as the Inbox
 * accumulates them — each reply from the agent ends with a fresh one — and
 * the newest is the one the person is answering.
 *
 * **Why this is parsed here and not left to the model.** The model could read
 * the checkbox itself, and did in the first demo. What it cannot do reliably is
 * remember which ticks it has already acted on across a `/loop` that fires
 * every fifteen minutes, or across two sessions. So the acknowledgement is a
 * line in the note, a receipt appended straight after the ticked gate by
 * `take`. That makes the state visible on the phone ("Claude picked this up"),
 * survives restarts, and needs no state on this machine. And because it is an
 * append, the agent never rewrites a note the person may be typing in.
 *
 * Lines inside fenced code blocks are not gates or receipts: documentation the
 * agent writes may quote the protocol, and a quoted example must not be read
 * as a live question.
 *
 * **The name in the box is the agent's, and any one word is accepted.** The
 * server is not only driven by Claude Code: `hushjot mcp --agent Codex` writes
 * "Codex may continue." and "> Codex picked this up", so the person reads the
 * name of whatever is actually on the other end. Parsing accepts any single
 * word there rather than only the configured name, because the notes outlive
 * the session: a project planned under Claude and continued under Codex must
 * still see its old boxes and receipts, and test users already have notes
 * that say "Claude".
 */

/** Who the boxes and receipts name when nobody says otherwise. */
export const DEFAULT_AGENT = 'Claude';

/**
 * A name that can go in a box. One word, so the parser can find it without
 * knowing it; short, because it is printed on a phone under every answer.
 */
const AGENT_NAME = /^[A-Za-z][A-Za-z0-9-]{0,19}$/;

/** The ending that makes a task-list line a gate: one word, then "may continue". */
const GATE_ENDING = /(?:^|\s)[a-z][a-z0-9-]*\s+may continue$/i;

/** What a receipt starts with, whichever agent wrote it. */
const RECEIPT = /^>\s*[A-Za-z][A-Za-z0-9-]*\s+picked this up\b/;

/** A Markdown task-list item: indent, bullet, box, text. */
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*?)\s*$/;

const FENCE = /^\s*(```|~~~)/;

export function checkAgentName(name: string): string {
  if (!AGENT_NAME.test(name)) {
    throw new GateError(
      `"${name}" cannot be used as the agent name: use one word of letters, digits or hyphens, ` +
        'up to 20 characters, starting with a letter (for example Codex).',
    );
  }
  return name;
}

/** The gate that ends every questions note, and every plan. */
export const questionsDone = (agent = DEFAULT_AGENT): string =>
  `- [ ] I have answered all questions. ${agent} may continue.`;

/** The gate that ends every reply in a thread such as the Inbox. */
export const gateDone = (agent = DEFAULT_AGENT): string => `- [ ] Done. ${agent} may continue.`;

/**
 * A plan's choice. It is a task item but not a gate: ticking it alone does
 * nothing until the gate below it is ticked too, so a mis-tap cannot start a
 * build, and leaving it unticked with changes written is how to ask for a
 * revised plan.
 */
export const PLAN_APPROVE = '- [ ] Approve: build this plan.';

/** The section that ends every plan. */
export const planFooter = (agent = DEFAULT_AGENT): string =>
  [
    '## Your response',
    '',
    PLAN_APPROVE,
    '',
    'Changes or questions (write below):',
    '',
    '',
    questionsDone(agent),
  ].join('\n');

/**
 * - `none`: no gate; the note is not waiting on anyone.
 * - `waiting`: the last gate is unticked; the person may be mid-sentence.
 * - `ready`: ticked and not yet picked up.
 * - `taken`: ticked, and a receipt follows it.
 */
export type GateState = 'none' | 'waiting' | 'ready' | 'taken';

export function gateState(markdown: string): GateState {
  let inFence = false;
  let state: GateState = 'none';

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const task = TASK.exec(line);
    if (task && isGateText(task[2]!)) {
      // A later gate supersedes everything before it, receipts included.
      state = task[1] === ' ' ? 'waiting' : 'ready';
      continue;
    }
    if (state === 'ready' && RECEIPT.test(line.trimStart())) state = 'taken';
  }
  return state;
}

function isGateText(text: string): boolean {
  return GATE_ENDING.test(text.replace(/[.!\s]+$/, ''));
}

/** `> Claude picked this up · 2026-10-19 15:40`, in this machine's local time. */
export function receiptLine(at: Date, agent = DEFAULT_AGENT): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `> ${agent} picked this up · ${stamp}`;
}

/** A note that is not in the state an operation needs. Exit code: user error. */
export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

/** Why a note cannot be taken, in words the model can act on. */
export function notReady(title: string, state: GateState, agent = DEFAULT_AGENT): string {
  switch (state) {
    case 'none':
      return `"${title}" has no "${agent} may continue." box, so it is not waiting on you.`;
    case 'waiting':
      return (
        `"${title}" is not ticked yet. The user may still be typing; ignore its contents ` +
        'and check again later.'
      );
    case 'taken':
      return `"${title}" was already picked up. Wait for the user to tick a newer box.`;
    case 'ready':
      return `"${title}" is ready.`;
  }
}
