/**
 * Reading note text from a pipe.
 *
 * `hushjot push` with no text argument reads stdin, because that is how a shell
 * and an agent both want to hand over a document: `git log | hushjot push`,
 * `cat draft.md | hushjot push`. The read is unbounded by design — a note is
 * capped by the rules at 900 KiB and `sealNote` reports that as its own error,
 * which is a better message than a truncated note would be.
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export const hasPipedInput = (): boolean => !process.stdin.isTTY;
