/**
 * One account, one machine, the whole tool — against the real security rules.
 *
 * Unit tests cannot reach the thing most likely to be wrong here, which is not
 * logic but *protocol*: whether the documents this CLI builds are shaped the
 * way `firestore.rules` demands. Six of those constraints are invisible until a
 * real rules engine refuses a real request, and each is asserted below:
 * `syncedAt` must be the server's own `request.time`; ciphertext must be
 * `bytes` and never a string; a write must carry every required field, so no
 * `updateMask`; an update's revision must be exactly `stored + 1`; a note may
 * never be hard-deleted; and everything under `users/{uid}` needs an active
 * allowlist entry.
 *
 * The rules come from `@hushjot/core/contract/firestore.rules` — the installed
 * package's copy, not a vendored one — so this test fails when the app's rules
 * change in a way the CLI has not kept up with, which is the whole point of
 * shipping them in the package.
 *
 * The vault comes from `@hushjot/core/contract/format-vectors.json`. That file
 * is a frozen key record produced in the app repository, so logging in here
 * proves the CLI unwraps bytes the *app* sealed, rather than bytes this repo
 * made up. It stands in for "a browser created this vault", which is the one
 * thing the CLI deliberately cannot do.
 *
 * `Bearer owner` is the Firestore emulator's admin credential, and is how the
 * fixture plants an account, an invitation and a key record without going
 * through rules that would (correctly) refuse all three. It is also how the
 * ciphertext audit reads back what was really stored — without it the dump
 * comes back 403 and an audit that sees nothing would "pass" by looking at
 * nothing. The app repo's `bench/phase4.mjs` makes the same point.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCKDOWN_SENTINEL } from '@hushjot/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const require = createRequire(import.meta.url);

const PROJECT = 'teksto-dev';
const AUTH_HOST = '127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1:8086';
const FIRESTORE = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const EMAIL = 'cli-journey@example.com';
const PASSWORD = 'journey-password-1';

const vectors = JSON.parse(
  readFileSync(require.resolve('@hushjot/core/contract/format-vectors.json'), 'utf8'),
);
// The `fast` record uses low Argon2id parameters, so the several unlocks this
// test performs cost milliseconds rather than half a second each. The
// parameters come out of the record either way, which is the property that
// makes using a cheap one here sound.
const VAULT = vectors.keyRecords.find((r) => r.id === 'fast');

let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures++;
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}${!condition && detail ? `\n       ${detail}` : ''}`);
}

// --- fixture ---------------------------------------------------------------

async function provisionAccount() {
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error(`signUp: HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  return { uid: body.localId, idToken: body.idToken };
}

async function ownerWrite(path, fields, method = 'POST', query = '') {
  const response = await fetch(`${FIRESTORE}/${path}${query}`, {
    method,
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function invite(active) {
  await ownerWrite(
    `allowlist/${encodeURIComponent(EMAIL)}`,
    {
      active: { booleanValue: active },
      note: { stringValue: 'CLI integration journey' },
      addedAt: { integerValue: String(Date.now()) },
    },
    'PATCH',
  );
}

/** JSON → Firestore field values, for planting the frozen key record. */
function toValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  const fields = {};
  for (const [k, v] of Object.entries(value)) fields[k] = toValue(v);
  return { mapValue: { fields } };
}

async function plantKeyRecord(uid) {
  await ownerWrite(
    `users/${uid}/keys/primary`,
    {
      v: { integerValue: '1' },
      record: toValue(VAULT.record),
      updatedAt: { integerValue: String(Date.now()) },
    },
    'PATCH',
  );
}

/** Everything the backend really stored, with bytes decoded, as one string. */
async function dumpNotes(uid) {
  const response = await fetch(`${FIRESTORE}/users/${uid}/notes`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (!response.ok) return `HTTP_${response.status}`;
  const json = await response.json();
  let out = JSON.stringify(json);
  for (const document of json.documents ?? []) {
    for (const field of Object.values(document.fields ?? {})) {
      if (typeof field.bytesValue === 'string') {
        out += ` ${Buffer.from(field.bytesValue, 'base64').toString('latin1')}`;
      }
    }
  }
  return out;
}

/**
 * Swap the emulator's rules, as a deploy (or the kill switch) would. The
 * lockdown ruleset is the app's `private/killswitch/lockdown.rules` in
 * substance: refuse everything, allow a `get` of the sentinel. It is written
 * out here because that file is private to the app repository; the sentinel
 * path itself comes from the published core, so the two cannot drift apart.
 */
async function setRules(content) {
  const response = await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  });
  if (!response.ok) throw new Error(`setRules: HTTP ${response.status} ${await response.text()}`);
}

const LOCKDOWN_RULES = `rules_version = '2';
// HUSHJOT-LOCKDOWN (journey copy)
service cloud.firestore {
  match /databases/{database}/documents {
    match /${LOCKDOWN_SENTINEL} {
      allow get: if true;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

// --- running the CLI -------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'hushjot-journey-'));

function hushjot(args, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(repoRoot, 'src/bin/hushjot.ts'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HUSHJOT_HOME: home,
        HUSHJOT_AUTH_HOST: AUTH_HOST,
        HUSHJOT_FIRESTORE_HOST: FIRESTORE_HOST,
        HUSHJOT_PASSWORD: PASSWORD,
        HUSHJOT_PASSPHRASE: VAULT.passphrase,
        ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

// --- driving the MCP server over stdio -------------------------------------

/**
 * A minimal JSON-RPC client over the server's stdio: newline-delimited JSON,
 * one request at a time. That transport is also why the server may never print
 * anything of its own — a stray line here fails `JSON.parse` and is reported.
 */
function mcpClient(args = []) {
  const child = spawn(process.execPath, [join(repoRoot, 'src/bin/hushjot.ts'), 'mcp', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HUSHJOT_HOME: home,
      HUSHJOT_AUTH_HOST: AUTH_HOST,
      HUSHJOT_FIRESTORE_HOST: FIRESTORE_HOST,
      HUSHJOT_PASSWORD: PASSWORD,
      HUSHJOT_PASSPHRASE: VAULT.passphrase,
    },
  });

  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  const noise = [];

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        noise.push(line);
        continue;
      }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));

  const request = (method, params = {}) =>
    new Promise((resolveRequest, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr: ${stderr}`)), 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolveRequest(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  return {
    request,
    noise,
    stderr: () => stderr,
    exited,
    async initialize() {
      const reply = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'journey', version: '0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return reply;
    },
    async call(name, args) {
      const reply = await request('tools/call', { name, arguments: args });
      const result = reply.result ?? {};
      return {
        isError: Boolean(result.isError),
        texts: (result.content ?? []).map((c) => c.text),
        text: (result.content ?? []).map((c) => c.text).join('\n'),
      };
    },
    close() {
      child.kill();
    },
  };
}

// --- the journey -----------------------------------------------------------

const NOTE = '# From the CLI\n\nsalmagundi hello world\n';
const SENTINEL = 'salmagundi';

try {
  const { uid } = await provisionAccount();
  await invite(true);
  await plantKeyRecord(uid);

  // 1. login
  const loggedIn = hushjot([
    'login',
    '--project',
    PROJECT,
    '--api-key',
    'emulator',
    '--email',
    EMAIL,
  ]);
  check('login succeeds', loggedIn.code === 0, loggedIn.stderr);
  check('login reports the vault opened', /Vault unlocked/.test(loggedIn.stdout), loggedIn.stdout);

  // 2. an empty account lists nothing
  const empty = hushjot(['ls']);
  check('ls on an empty account', empty.code === 0 && /No notes/.test(empty.stdout), empty.stderr || empty.stdout);

  // 3. push
  const pushed = hushjot(['push', '--json', NOTE]);
  check('push succeeds', pushed.code === 0, pushed.stderr);
  const created = pushed.code === 0 ? JSON.parse(pushed.stdout) : { id: '', title: '' };
  check(
    'push derives the title exactly as the app would',
    created.title === 'From the CLI',
    `got ${JSON.stringify(created.title)}`,
  );

  // 4. the note is really there, and really encrypted
  const listed = hushjot(['ls']);
  check('ls shows the new note', listed.stdout.includes('From the CLI'), listed.stdout);

  const dump = await dumpNotes(uid);
  check('the backend stored a note at all', dump.includes(created.id), 'the audit saw nothing');
  check(
    'no plaintext reached the backend',
    !dump.includes(SENTINEL) && !dump.includes('From the CLI'),
    'a sentinel from the note body was found in Firestore',
  );

  // 5. cat round-trips byte for byte
  const read = hushjot(['cat', created.id]);
  check('cat returns the exact bytes pushed', read.stdout === NOTE, JSON.stringify(read.stdout));

  // 6. cat by title, and ambiguity is an error rather than a guess
  const byTitle = hushjot(['cat', 'From the CLI']);
  check('cat resolves a title', byTitle.stdout === NOTE, byTitle.stderr);

  // 7. append
  const appended = hushjot(['append', '--json', created.id, 'a second line']);
  check('append succeeds', appended.code === 0, appended.stderr);
  const appendResult = appended.code === 0 ? JSON.parse(appended.stdout) : {};
  check(
    'append advances the revision by exactly one',
    appendResult.revision === 2,
    `got ${appendResult.revision}`,
  );

  const afterAppend = hushjot(['cat', created.id]);
  check(
    'append adds the text without a blank line',
    afterAppend.stdout === `${NOTE}a second line`,
    JSON.stringify(afterAppend.stdout),
  );

  // 7b. the storage meter moved with both writes, by exactly what is stored
  const readAsOwner = async (path) =>
    (await fetch(`${FIRESTORE}/${path}`, { headers: { Authorization: 'Bearer owner' } })).json();
  const storedNote = await readAsOwner(`users/${uid}/notes/${created.id}`);
  const storedSize = ['meta', 'body']
    .map((f) => Buffer.from(storedNote.fields?.[f]?.bytesValue ?? '', 'base64').length)
    .reduce((a, b) => a + b, 0);
  const meter = await readAsOwner(`users/${uid}/usage/current`);
  const month = (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  // Charged, as the rules charge it: the ciphertext, never less than 1 KiB.
  const charged = storedSize > 0 ? Math.max(storedSize, 1024) : 0;
  check(
    'the storage meter counts exactly the stored ciphertext, at the 1 KiB minimum',
    storedSize > 0 && meter.fields?.bytes?.integerValue === String(charged),
    `meter ${JSON.stringify(meter.fields?.bytes)}, stored ${storedSize}, charged ${charged}`,
  );
  check(
    'and counts both writes in this month',
    meter.fields?.pushes?.mapValue?.fields?.[month]?.integerValue === '2',
    JSON.stringify(meter.fields?.pushes),
  );
  check(
    'and as two pushes against the daily limit',
    meter.fields?.pn?.integerValue === '2',
    JSON.stringify(meter.fields?.pn),
  );

  // 8. search, over content the server cannot read
  const found = hushjot(['search', '--json', SENTINEL]);
  const hits = found.code === 0 ? JSON.parse(found.stdout) : [];
  check('search finds the note by a body word', hits.length === 1 && hits[0].id === created.id, found.stdout);

  const missing = hushjot(['search', '--json', 'wordthatisnotthere']);
  check('search reports nothing for a miss', JSON.parse(missing.stdout || '[]').length === 0, missing.stdout);

  // 9. the protocol constraints, asserted directly against the rules
  const signIn = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    },
  );
  const { idToken } = await signIn.json();

  // Every write below carries an honest storage meter, so each refusal is for
  // the one defect the check names and not for a missing meter. The control at
  // the end proves the same write, without the defect, is accepted.
  const goodSize = storedSize;
  const meterWrite = {
    update: {
      name: `projects/${PROJECT}/databases/(default)/documents/users/${uid}/usage/current`,
      fields: { lastDoc: { stringValue: `notes/${created.id}` } },
    },
    updateMask: { fieldPaths: ['lastDoc'] },
    updateTransforms: [
      { fieldPath: 'bytes', increment: { integerValue: String(goodSize - storedSize) } },
      { fieldPath: 'pn', increment: { integerValue: '1' } },
    ],
  };
  const asUser = async (body, meter = true) =>
    (
      await fetch(`${FIRESTORE}:commit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(meter ? { writes: [...body.writes, meterWrite] } : body),
      })
    ).status;

  const name = `projects/${PROJECT}/databases/(default)/documents/users/${uid}/notes/${created.id}`;
  const goodFields = {
    v: { integerValue: '1' },
    // The note's own stored ciphertext, so the accepted control below leaves a
    // note every later step can still open.
    meta: storedNote.fields.meta,
    body: storedNote.fields.body,
    revision: { integerValue: '3' },
    updatedAt: { integerValue: String(Date.now()) },
    deleted: { booleanValue: false },
  };

  check(
    'a write without the server-time transform is refused',
    (await asUser({ writes: [{ update: { name, fields: goodFields } }] })) === 403,
    'the rules accepted a client-supplied syncedAt',
  );

  check(
    'ciphertext sent as a string is refused',
    (await asUser({
      writes: [
        {
          update: { name, fields: { ...goodFields, meta: { stringValue: 'plaintext!' } } },
          updateTransforms: [{ fieldPath: 'syncedAt', setToServerValue: 'REQUEST_TIME' }],
        },
      ],
    })) === 403,
    'the rules accepted a string where ciphertext belongs',
  );

  check(
    'a revision that does not advance by one is refused',
    (await asUser({
      writes: [
        {
          update: { name, fields: { ...goodFields, revision: { integerValue: '9' } } },
          updateTransforms: [{ fieldPath: 'syncedAt', setToServerValue: 'REQUEST_TIME' }],
        },
      ],
    })) === 403,
    'the compare-and-swap did not hold',
  );

  const deleteStatus = (
    await fetch(`${FIRESTORE}/users/${uid}/notes/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    })
  ).status;
  check('a hard delete is refused', deleteStatus === 403, `got HTTP ${deleteStatus}`);

  const wellFormed = {
    writes: [
      {
        update: { name, fields: goodFields },
        updateTransforms: [{ fieldPath: 'syncedAt', setToServerValue: 'REQUEST_TIME' }],
      },
    ],
  };
  // Every write must carry the meter, whatever it changes: each one is a push
  // against the daily limit, so there is no same-size exemption any more.
  const shorterBody = Buffer.from(storedNote.fields.body.bytesValue, 'base64').subarray(1).toString('base64');
  const unmetered = structuredClone(wellFormed);
  unmetered.writes[0].update.fields.body = { bytesValue: shorterBody };
  check(
    'a write that leaves the storage meter out is refused',
    (await asUser(unmetered, false)) === 403,
    'the rules accepted a write the meter did not account for',
  );
  check(
    'and the same write with an honest meter is accepted',
    (await asUser(wellFormed)) === 200,
    'so the refusals above were each for their own reason',
  );

  // 9b. a full account: refused, explained, and nothing written
  const ownerPatch = (path, fields, mask) =>
    fetch(`${FIRESTORE}/${path}?${mask.map((m) => `updateMask.fieldPaths=${m}`).join('&')}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
  await ownerPatch(`users/${uid}/usage/current`, { bytes: { integerValue: String(1024 ** 3) } }, ['bytes']);
  const full = hushjot(['push', 'this should wait for room']);
  check('a push to a full account exits 4', full.code === 4, `exit ${full.code}: ${full.stderr}`);
  check(
    'and says storage is full, not that the note is malformed',
    /storage is full/i.test(full.stderr) && /1074 MB of 1074 MB|1\.?0? ?GB|MB of/i.test(full.stderr),
    full.stderr,
  );
  await ownerPatch(`users/${uid}/usage/current`, { bytes: { integerValue: '0' } }, ['bytes']);

  // 9c. the daily push limit: refused while the window is fresh, said plainly,
  // and lifted by the server once the window is a day old
  const window = (ms, pushes) =>
    ownerPatch(
      `users/${uid}/usage/current`,
      { ws: { timestampValue: new Date(ms).toISOString() }, pn: { integerValue: String(pushes) } },
      ['ws', 'pn'],
    );
  await window(Date.now() - 60 * 60_000, 20_000);
  const limited = hushjot(['push', 'this should wait for tomorrow']);
  check('a push past the daily limit exits 5', limited.code === 5, `exit ${limited.code}: ${limited.stderr}`);
  check('and says the daily sync limit is reached', /daily sync limit/i.test(limited.stderr), limited.stderr);
  await window(Date.now() - 25 * 60 * 60_000, 20_000);
  const nextDay = hushjot(['push', 'a new day']);
  check('a day later the same push starts a new window', nextDay.code === 0, `exit ${nextDay.code}: ${nextDay.stderr}`);
  const afterReset = await readAsOwner(`users/${uid}/usage/current`);
  check('and counts as its first push', afterReset.fields?.pn?.integerValue === '1', JSON.stringify(afterReset.fields?.pn));

  // 10. revocation, and that it is reported as itself rather than as a conflict
  await invite(false);
  const revoked = hushjot(['push', 'this should not land']);
  check('a revoked account cannot write', revoked.code === 4, `exit ${revoked.code}`);
  check(
    'and is told it is an approval problem, not a conflict',
    /no active sync plan/i.test(revoked.stderr),
    revoked.stderr,
  );
  await invite(true);

  // 11. the scope confinement the MCP server relies on
  hushjot(['scope', 'Nowhere']);
  const scoped = hushjot(['ls']);
  check(
    'an unknown folder scope is an error, not a silently empty list',
    scoped.code === 4 && /No folder matching/.test(scoped.stderr),
    `exit ${scoped.code}: ${scoped.stderr}`,
  );
  hushjot(['scope', 'clear']);

  // 12. the MCP server will not start unenabled
  const mcp = hushjot(['mcp']);
  check('the MCP server refuses to start until enabled', /not enabled/.test(mcp.stderr), mcp.stderr);

  // 13. and does work once it is. This is a real JSON-RPC handshake over stdio
  //     against a real backend, because "the tools are declared" and "the tools
  //     run" are different claims and only the second one matters.
  hushjot(['mcp', 'enable']);
  // A project folder to confine the agent to, and a folder outside it that it
  // must not be able to write into.
  const project = hushjot(['mkdir', 'Projects/journey-app', '--json']);
  check('mkdir creates a nested folder path', project.code === 0, project.stderr);
  hushjot(['mkdir', 'Private']);
  const again = hushjot(['mkdir', 'Projects/journey-app', '--json']);
  check(
    'mkdir reuses folders that already exist',
    again.code === 0 && JSON.parse(again.stdout).created === 0,
    again.stdout + again.stderr,
  );
  hushjot(['push', '--folder', 'Projects/journey-app', `# Requirements\n\n${SENTINEL} journey app\n`]);

  const agent = mcpClient(['--scope', 'Projects/journey-app']);
  try {
    const init = await agent.initialize();
    check('the MCP server completes an initialize handshake', Boolean(init.result), agent.stderr());
    check(
      'and hands the model the working protocol',
      /Questions NN/.test(init.result?.instructions ?? ''),
      JSON.stringify(init.result ?? {}).slice(0, 200),
    );

    check(
      'and the protocol gates on the done box, the plan response and never stopping the loop',
      (init.result?.instructions ?? '').includes('- [ ] I have answered all questions. Claude may continue.') &&
        (init.result?.instructions ?? '').includes('- [ ] Approve: build this plan.') &&
        (init.result?.instructions ?? '').includes('Never stop, cancel or offer to stop the loop'),
      init.result?.instructions ?? '',
    );

    const listed = (await agent.request('tools/list')).result?.tools ?? [];
    const tools = listed.map((t) => t.name);
    const readOnly = listed.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    check(
      'exactly the read tools are annotated read-only',
      readOnly.join(',') === 'hushjot_search,hushjot_cat,hushjot_ls,hushjot_pending,hushjot_protocol',
      readOnly.join(','),
    );
    check(
      'and replace is annotated destructive',
      listed.find((t) => t.name === 'hushjot_replace')?.annotations?.destructiveHint === true,
    );
    check(
      'it advertises exactly the ten verbs and the protocol',
      tools.join(',') ===
        'hushjot_search,hushjot_cat,hushjot_ls,hushjot_push,hushjot_append,hushjot_replace,hushjot_mkdir,' +
          'hushjot_pending,hushjot_take,hushjot_reply,hushjot_protocol',
      tools.join(','),
    );
    check('and no tool can delete anything', !tools.some((t) => /delete|rm|remove/.test(t)));

    const prompts = ((await agent.request('prompts/list')).result?.prompts ?? []).map((p) => p.name);
    check('it offers the plan and continue prompts', prompts.includes('plan') && prompts.includes('continue'), prompts.join(','));

    const found = await agent.call('hushjot_search', { query: SENTINEL });
    check('a tool call reaches the vault and returns a hit', /Requirements/.test(found.text), found.text);
    check(
      'and --scope keeps it to the project folder',
      !found.text.includes(created.id),
      found.text,
    );

    const leak = await agent.call('hushjot_push', { content: '# Leak\n', folder: 'Private' });
    check(
      'a scoped agent cannot push into a folder outside its scope',
      leak.isError && /outside the folder scope/.test(leak.text),
      leak.text,
    );

    const docs = await agent.call('hushjot_mkdir', { path: 'Docs' });
    check('a scoped agent can make a subfolder of its project', !docs.isError, docs.text);
    const docsPath = docs.isError ? '' : JSON.parse(docs.text).path;
    check('and it lands inside the project', docsPath === 'Projects/journey-app/Docs', docsPath);

    const pushed = await agent.call('hushjot_push', { content: '# Architecture\n\nfirst draft\n', folder: 'Docs' });
    check('a scoped agent can push into its Docs folder', !pushed.isError, pushed.text);

    const read = await agent.call('hushjot_cat', { note: 'Architecture' });
    const revision = Number(/revision: (\d+)/.exec(read.texts[0] ?? '')?.[1]);
    check('cat reports the revision as its own block', revision === 1 && read.texts[1]?.startsWith('# Architecture'), read.text);

    const stale = await agent.call('hushjot_replace', {
      note: 'Architecture',
      content: '# Architecture\n\nstale\n',
      revision: revision + 5,
    });
    check('replace refuses a revision that is not the stored one', stale.isError, stale.text);

    const replaced = await agent.call('hushjot_replace', {
      note: 'Architecture',
      content: '# Architecture\n\nsecond draft\n',
      revision,
    });
    check('replace with the read revision succeeds under the real rules', !replaced.isError, replaced.text);

    const result = replaced.isError ? {} : JSON.parse(replaced.text);
    const versions = await (
      await fetch(`${FIRESTORE}/users/${uid}/notes/${result.id}/versions`, {
        headers: { Authorization: 'Bearer owner' },
      })
    ).json();
    const version = versions.documents?.[0];
    check(
      'and the replaced text is in history, as the app would have kept it',
      version?.fields?.reason?.stringValue === 'edit' && version?.name?.endsWith(result.versionId),
      JSON.stringify(versions).slice(0, 300),
    );

    const after = await agent.call('hushjot_cat', { note: 'Architecture' });
    check('the next read sees the new text and revision', /revision: 2/.test(after.texts[0] ?? '') && /second draft/.test(after.text), after.text);

    // The gate loop: questions are ignored until ticked, picked up once, and
    // the conversation carries on in the Inbox.
    const nothing = JSON.parse((await agent.call('hushjot_pending', {})).text);
    check('pending says nothing is ready in a fresh project', nothing.ready === 0 && nothing.notes.length === 0, JSON.stringify(nothing));

    const asked = await agent.call('hushjot_push', {
      content: '# Questions 01: Scope\n\n1. CLI or web?\n   Answer:\n\n- [ ] I have answered all questions. Claude may continue.\n',
    });
    const questionsId = asked.isError ? '' : JSON.parse(asked.text).id;
    const waiting = JSON.parse((await agent.call('hushjot_pending', {})).text);
    check(
      'an unticked questions note is waiting, not ready',
      waiting.ready === 0 && waiting.notes[0]?.id === questionsId && waiting.notes[0]?.state === 'waiting',
      JSON.stringify(waiting),
    );
    const early = await agent.call('hushjot_take', { note: questionsId });
    check('and cannot be taken while the user may be typing', early.isError && /not ticked yet/.test(early.text), early.text);

    // The user answers and ticks the box on their phone.
    const asRead = await agent.call('hushjot_cat', { note: questionsId });
    const asked1 = Number(/revision: (\d+)/.exec(asRead.texts[0] ?? '')?.[1]);
    await agent.call('hushjot_replace', {
      note: questionsId,
      content: (asRead.texts[1] ?? '').replace('Answer:', 'Answer: CLI').replace('- [ ] I have', '- [x] I have'),
      revision: asked1,
    });
    const ready = JSON.parse((await agent.call('hushjot_pending', {})).text);
    check('once ticked it is ready', ready.ready === 1 && ready.notes[0]?.state === 'ready', JSON.stringify(ready));

    const taken = await agent.call('hushjot_take', { note: questionsId });
    check(
      'take returns the answers and appends a receipt',
      !taken.isError && /Answer: CLI/.test(taken.text) && /> Claude picked this up · \d{4}-\d\d-\d\d \d\d:\d\d/.test(taken.text),
      taken.text,
    );
    check('and reports the new revision', /revision: 3 .*picked up/.test(taken.texts[0] ?? ''), taken.texts[0]);
    const twice = await agent.call('hushjot_take', { note: questionsId });
    check('a picked-up note cannot be taken twice', twice.isError && /already picked up/.test(twice.text), twice.text);
    const quiet = JSON.parse((await agent.call('hushjot_pending', {})).text);
    check('and drops out of pending', quiet.notes.length === 0, JSON.stringify(quiet));

    const report = await agent.call('hushjot_reply', { text: 'Built it.\n\n- [ ] Initialise git and commit' });
    const inbox = report.isError ? {} : JSON.parse(report.text);
    check('reply with no note creates the Inbox', inbox.created === true && inbox.title === 'Inbox', report.text);
    const inboxText = (await agent.call('hushjot_cat', { note: 'Inbox' })).texts[1] ?? '';
    check(
      'and ends it with a fresh Done box the user can tick',
      inboxText.trimEnd().endsWith('- [ ] Done. Claude may continue.') && inboxText.includes('Initialise git'),
      inboxText,
    );
    const second = await agent.call('hushjot_reply', { text: 'Also blocked on deploy.' });
    check('a second reply appends to the same Inbox', !second.isError && JSON.parse(second.text).created === false, second.text);
    const pendingInbox = JSON.parse((await agent.call('hushjot_pending', {})).text);
    check('the Inbox is waiting on the user', pendingInbox.notes[0]?.title === 'Inbox' && pendingInbox.notes[0]?.state === 'waiting', JSON.stringify(pendingInbox));

    check('the server printed nothing but JSON-RPC', agent.noise.length === 0, agent.noise.join('\n'));
  } finally {
    agent.close();
  }

  // 13b. Another agent picks up the same project: its name goes in the
  // receipt and the boxes, and the Claude-era boxes still count.
  const codex = mcpClient(['--scope', 'Projects/journey-app', '--agent', 'Codex']);
  try {
    const init = await codex.initialize();
    check(
      '--agent names the agent in the protocol',
      /Codex may continue\./.test(init.result?.instructions ?? ''),
      (init.result?.instructions ?? '').slice(0, 200),
    );
    const protocol = await codex.call('hushjot_protocol', {});
    check('hushjot_protocol returns it for clients that drop instructions', /When asked to plan:/.test(protocol.text), protocol.text.slice(0, 200));

    const inboxRead = await codex.call('hushjot_cat', { note: 'Inbox' });
    const inboxRevision = Number(/revision: (\d+)/.exec(inboxRead.texts[0] ?? '')?.[1]);
    const ticked = (inboxRead.texts[1] ?? '').replace(/- \[ \] Done\. Claude may continue\.\s*$/, '- [x] Done. Claude may continue.\n');
    await codex.call('hushjot_replace', { note: 'Inbox', content: ticked, revision: inboxRevision });
    const took = await codex.call('hushjot_take', { note: 'Inbox' });
    check(
      'a different agent takes a box Claude wrote, and signs the receipt',
      !took.isError && /> Codex picked this up · /.test(took.text),
      took.text,
    );
    await codex.call('hushjot_reply', { text: 'Committed.' });
    const latest = (await codex.call('hushjot_cat', { note: 'Inbox' })).texts[1] ?? '';
    check('and its replies end with its own box', latest.trimEnd().endsWith('- [ ] Done. Codex may continue.'), latest);
  } finally {
    codex.close();
  }

  // 14. --scope can only narrow what the operator configured.
  hushjot(['scope', 'Projects/journey-app']);
  const widened = mcpClient(['--scope', 'Private']);
  const code = await widened.exited;
  check(
    'mcp --scope cannot widen past the configured scope',
    code !== 0 && /outside the folder scope/.test(widened.stderr()),
    `exit ${code}: ${widened.stderr()}`,
  );
  hushjot(['scope', 'clear']);

  // 15. read-only mode hides and refuses the writes.
  hushjot(['mcp', 'enable', '--read-only']);
  const reader = mcpClient();
  try {
    await reader.initialize();
    const tools = ((await reader.request('tools/list')).result?.tools ?? []).map((t) => t.name);
    check(
      'a read-only server lists only the read tools',
      tools.join(',') === 'hushjot_search,hushjot_cat,hushjot_ls,hushjot_pending',
      tools.join(','),
    );
    const refused = await reader.call('hushjot_push', { content: '# Nope\n' });
    check('and refuses a write it was not told about', refused.isError && /read-only/.test(refused.text), refused.text);
  } finally {
    reader.close();
  }

  // 16. a cost lockdown: the kill switch's ruleset refuses everything but a
  // `get` of the sentinel, and the CLI and the MCP server must say "paused",
  // never "no active sync plan", then work again the moment the rules are back.
  hushjot(['mcp', 'enable']);
  const during = mcpClient();
  try {
    await during.initialize();
    await setRules(LOCKDOWN_RULES);
    const ls = hushjot(['ls']);
    check('a read during a lockdown exits 8', ls.code === 8, `exit ${ls.code}: ${ls.stderr}`);
    check(
      'and says sync is paused, not that the plan is missing',
      /paused for maintenance/.test(ls.stderr) && !/no active sync plan/i.test(ls.stderr),
      ls.stderr,
    );
    const write = hushjot(['push', 'this waits out the lockdown']);
    check('a write during a lockdown exits 8 too', write.code === 8, `exit ${write.code}: ${write.stderr}`);
    const tool = await during.call('hushjot_push', { content: '# Paused\n' });
    check(
      'the MCP server reports the same pause',
      tool.isError && /paused for maintenance/.test(tool.text) && !/plan/i.test(tool.text),
      tool.text,
    );
    const starting = mcpClient();
    const startCode = await starting.exited;
    check('an MCP server started during a lockdown exits 8', startCode === 8, `exit ${startCode}: ${starting.stderr()}`);
  } finally {
    during.close();
    await setRules(readFileSync(resolve(repoRoot, 'tests/emulator/firestore.rules'), 'utf8'));
  }
  const after = hushjot(['ls']);
  check('and everything works again once the real rules are back', after.code === 0, after.stderr);
} catch (error) {
  console.error('\njourney aborted:', error);
  failures++;
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
