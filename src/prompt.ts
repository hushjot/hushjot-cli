/**
 * Reading a secret from a terminal without echoing it.
 *
 * `readline` has no "don't echo" mode, so this drops to raw mode on the TTY and
 * handles the four keys that matter. It is small enough to be worth writing —
 * the alternative is a dependency whose entire job is this (§28).
 *
 * It refuses to run when stdin is not a TTY rather than silently reading a pipe:
 * a passphrase arriving on stdin would be a passphrase in a shell history or a
 * script, and the supported non-interactive path is `HUSHJOT_PASSPHRASE`.
 */
import { stdin, stdout } from 'node:process';

export class NotATerminalError extends Error {
  constructor(what: string) {
    super(
      `Cannot ask for ${what}: this is not an interactive terminal. ` +
        'Set HUSHJOT_PASSPHRASE (or HUSHJOT_PASSWORD) in the environment instead.',
    );
    this.name = 'NotATerminalError';
  }
}

export function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY) throw new NotATerminalError(label);

  return new Promise((resolve, reject) => {
    stdout.write(`${label}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const finish = (err: Error | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        switch (ch) {
          case '\r':
          case '\n':
            finish(null);
            return;
          case '': // Ctrl-C
            finish(new Error('cancelled'));
            return;
          case '': // Backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            // Ignore the rest of the C0 range: arrow keys arrive as escape
            // sequences and would otherwise be typed into the passphrase.
            if (ch >= ' ') value += ch;
        }
      }
    };

    stdin.on('data', onData);
  });
}

/** Visible input, for things that are not secret — an email address. */
export function promptLine(label: string): Promise<string> {
  if (!stdin.isTTY) throw new NotATerminalError(label);

  return new Promise((resolve) => {
    stdout.write(`${label}: `);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      stdin.removeListener('data', onData);
      stdin.pause();
      resolve(chunk.replace(/[\r\n]+$/, ''));
    };
    stdin.on('data', onData);
  });
}
