/**
 * The secret store, with the OS binaries stubbed out.
 *
 * A file of its own because `node:child_process` is mocked for the whole module,
 * and nothing in `unit.test.ts` should run against a fake `execFileSync`. The
 * backend is chosen with `HUSHJOT_SECRET_STORE`, so the Windows path is driven on
 * any machine: what is asserted is the shape of the call — which binary, and
 * that the secret travels on stdin rather than in argv — not Credential Manager.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => ({ execFileSync }));

const { backend, canKeepPassword, deleteSecret, getSecret, setSecret } = await import('../src/keychain.ts');

const decodeScript = (args: string[]) => Buffer.from(args[args.length - 1]!, 'base64').toString('utf16le');

beforeEach(() => {
  execFileSync.mockReset();
  vi.stubEnv('HUSHJOT_PASSWORD', '');
  vi.stubEnv('HUSHJOT_REFRESH_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the environment backend', () => {
  beforeEach(() => vi.stubEnv('HUSHJOT_SECRET_STORE', 'environment'));

  it('persists nothing and does not throw for the refresh token or a DEK', () => {
    expect(backend()).toBe('environment');
    setSecret('a@example.com', 'refresh', 'token');
    setSecret('a@example.com', 'dek:abc', 'key');
    expect(getSecret('a@example.com', 'refresh')).toBeNull();
    expect(getSecret('a@example.com', 'dek:abc')).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('keeps the password only by reading it from HUSHJOT_PASSWORD', () => {
    expect(canKeepPassword()).toBe(false);
    expect(() => setSecret('a@example.com', 'password', 'pw')).toThrow(/HUSHJOT_PASSWORD/);

    vi.stubEnv('HUSHJOT_PASSWORD', 'pw');
    expect(canKeepPassword()).toBe(true);
    expect(() => setSecret('a@example.com', 'password', 'pw')).not.toThrow();
    expect(getSecret('a@example.com', 'password')).toBe('pw');
  });

  it('rejects a store name it does not know', () => {
    vi.stubEnv('HUSHJOT_SECRET_STORE', 'wallet');
    expect(() => backend()).toThrow(/HUSHJOT_SECRET_STORE/);
  });
});

describe('the Windows backend', () => {
  beforeEach(() => vi.stubEnv('HUSHJOT_SECRET_STORE', 'windows-credential'));

  it('writes through PowerShell with the secret on stdin, never in argv', () => {
    execFileSync.mockReturnValue('ok');
    const secret = 'pässwörd with spaces';
    setSecret('a@example.com', 'password', secret);

    const [command, args, options] = execFileSync.mock.calls[0]!;
    expect(command).toMatch(/powershell\.exe$/i);
    expect(args).toContain('-EncodedCommand');
    expect(JSON.stringify(args)).not.toContain(secret);
    expect(decodeScript(args)).not.toContain(secret);
    expect(options.input).toBe(Buffer.from(secret, 'utf8').toString('base64'));
    expect(decodeScript(args)).toContain('CredWriteW');
  });

  it('decodes what a read prints, and names the item hushjot:<email>:<name>', () => {
    execFileSync.mockReturnValue(Buffer.from('rëfresh', 'utf8').toString('base64'));
    expect(getSecret('a@example.com', 'refresh')).toBe('rëfresh');

    const script = decodeScript(execFileSync.mock.calls[0]![1]);
    const target = Buffer.from('hushjot:a@example.com:refresh', 'utf8').toString('base64');
    expect(script).toContain(target);
  });

  it('reads a missing item as null', () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('exit 3'), { status: 3 });
    });
    expect(getSecret('a@example.com', 'dek:abc')).toBeNull();
  });

  it('reports a failed write', () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('exit 4'), { status: 4 });
    });
    expect(() => setSecret('a@example.com', 'refresh', 't')).toThrow(/Credential Manager/);
  });

  it('deletes without complaint when there is nothing to delete', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(() => deleteSecret('a@example.com', 'password')).not.toThrow();
  });
});
