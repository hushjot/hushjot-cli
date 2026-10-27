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
if (process.env.HUSHJOT_RELEASE !== '1') {
  console.error('');
  console.error('  Refusing to publish: releases are gated.');
  console.error('');
  console.error('  Nothing in this project has ever been published to npm, and');
  console.error('  publishing is meant to be a deliberate, authorised act.');
  console.error('');
  console.error('  Read private/RELEASING.md first — there are unresolved');
  console.error('  blockers that would make a published package broken.');
  console.error('');
  console.error('  To authorise:  HUSHJOT_RELEASE=1 npm publish');
  console.error('');
  process.exit(1);
}

console.error('HUSHJOT_RELEASE=1 — publish authorised, proceeding.');
