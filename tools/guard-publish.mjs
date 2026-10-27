#!/usr/bin/env node
/**
 * Refuse to publish unless a release was explicitly authorised.
 *
 * `private: true` in package.json is the first layer and npm honours it before
 * this ever runs. This is the second, and the reason it exists is that
 * `private` is a single flag: the day someone wires up a real release they will
 * flip it, and nothing about flipping it says "and also think hard about
 * whether you meant to push these bytes to a public registry forever".
 * `prepublishOnly` runs on `npm publish` and on nothing else — not on `npm
 * install`, not on `npm pack` — so it costs nothing until the moment it matters.
 *
 * Publishing is not reversible in any way that counts. npm keeps the name, the
 * version number can never be reused, and anything that was in the tarball has
 * been distributed. That asymmetry is why the default is no.
 */
import { readFileSync } from 'node:fs';

if (process.env.HUSHJOT_RELEASE !== '1') {
  console.error('');
  console.error('  Refusing to publish: releases are gated.');
  console.error('');
  console.error('  Releases are cut by the maintainers, on purpose.');
  console.error('  To publish deliberately:  HUSHJOT_RELEASE=1 npm publish');
  console.error('');
  process.exit(1);
}

// npm publishes a `file:` or `link:` dependency without a word, and it resolves
// on no machine but the one it was published from, so the package would not
// install anywhere else. Nothing else in the publish path catches it.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const local = Object.entries(pkg.dependencies ?? {})
  .filter(([, spec]) => /^(file|link|portal):/.test(spec));
if (local.length > 0) {
  console.error('');
  console.error('  Refusing to publish: a dependency points at this machine.');
  for (const [name, spec] of local) console.error(`    ${name}: ${spec}`);
  console.error('  Repoint it at a published version range first.');
  console.error('');
  process.exit(1);
}

console.error('HUSHJOT_RELEASE=1 — publish authorised, proceeding.');
