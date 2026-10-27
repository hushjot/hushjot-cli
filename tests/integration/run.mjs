/**
 * Start the emulators and run the journey inside them.
 *
 * The rules are copied out of the installed `@hushjot/core` first, so the test
 * always runs against what the package shipped rather than a copy in this repo
 * that can fall behind. That copy is gitignored for the same reason: there must
 * be exactly one source of truth for the rules, and it is the app repository.
 *
 * `emulators:exec` starts Firestore and Auth, runs the command, and tears them
 * down, so nothing has to be running first and nothing is left behind.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const emulatorDir = resolve(repoRoot, 'tests/emulator');
const require = createRequire(import.meta.url);

copyFileSync(
  require.resolve('@hushjot/core/contract/firestore.rules'),
  resolve(emulatorDir, 'firestore.rules'),
);

try {
  execFileSync(
    'firebase',
    [
      'emulators:exec',
      '--only', 'firestore,auth',
      '--project', 'teksto-dev',
      `node ${resolve(here, 'journey.mjs')}`,
    ],
    { cwd: emulatorDir, stdio: 'inherit' },
  );
} catch (error) {
  process.exit(error.status ?? 1);
}
