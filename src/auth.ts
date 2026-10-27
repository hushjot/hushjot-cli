/**
 * Firebase Authentication without the Firebase SDK.
 *
 * The app reaches Identity Toolkit through `firebase/auth`, which exists to
 * manage a session across page loads in a browser — persistence backends, an
 * observable current user, a token refresh timer. A CLI process lives for
 * eighty milliseconds and then exits. All it needs is one ID token, so the
 * whole SDK would be carried for two HTTP calls it can make itself.
 *
 * The precedent is already in the app repo: `src/adapters/firebase/shareRest.ts`
 * talks to Firestore over plain `fetch` for the share viewer, on the argument
 * that the REST endpoint *is* Firestore and the rules are enforced identically
 * either way. The same is true here.
 *
 * **The only sign-in method is email and password**, because that is the only
 * provider the project enables (`docs/firebase-setup.md`: "Do not enable any
 * other provider"), and self-signup is disabled at the API, so an account
 * exists only because the operator created one.
 *
 * **Why a refresh token is preferred to the password.** Not secrecy — both sit
 * in the same keychain — but blast radius: a refresh token can be revoked from
 * the Firebase console without the user having to change a password they may
 * have reused. The password is kept only so an expired or revoked refresh can
 * recover without prompting in the middle of an agent's loop.
 */
import type { Config } from './config.ts';
import { endpoints } from './config.ts';
import { deleteSecret, getSecret, setSecret } from './keychain.ts';

export interface Session {
  idToken: string;
  uid: string;
  email: string;
}

export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

interface IdentityError {
  error?: { message?: string };
}

/**
 * Identity Toolkit reports a wrong password and an unknown account with the
 * same `INVALID_LOGIN_CREDENTIALS` once email-enumeration protection is on,
 * which the setup guide turns on. Saying "email or password" rather than
 * guessing which is both honest and the only thing the server told us.
 */
function readableAuthFailure(code: string): string {
  switch (code) {
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
      return 'That email and password do not match an account.';
    case 'USER_DISABLED':
      return 'That account has been disabled.';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'Too many attempts. Try again later.';
    case 'TOKEN_EXPIRED':
    case 'USER_NOT_FOUND':
    case 'INVALID_REFRESH_TOKEN':
      return 'The saved session is no longer valid.';
    default:
      return code;
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new AuthError('NETWORK', `Could not reach the sign-in service: ${String(cause)}`);
  }

  const parsed: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = (parsed as IdentityError).error?.message ?? `HTTP_${response.status}`;
    throw new AuthError(code, readableAuthFailure(code));
  }
  return parsed;
}

/** Exchange an email and password for a session, and save the refresh token. */
export async function signInWithPassword(
  config: Config,
  password: string,
): Promise<{ session: Session; refreshToken: string }> {
  const { identityToolkit } = endpoints(config);
  const result = (await postJson(
    `${identityToolkit}/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`,
    { email: config.email, password, returnSecureToken: true },
  )) as { idToken?: string; refreshToken?: string; localId?: string; email?: string };

  if (!result.idToken || !result.refreshToken || !result.localId) {
    throw new AuthError('MALFORMED', 'The sign-in service returned an unexpected response.');
  }

  return {
    session: { idToken: result.idToken, uid: result.localId, email: result.email ?? config.email },
    refreshToken: result.refreshToken,
  };
}

/**
 * The secure-token endpoint is form-encoded rather than JSON, and it is the one
 * place in this file that is not `postJson`.
 */
async function exchangeRefreshToken(
  config: Config,
  refreshToken: string,
): Promise<{ idToken: string; uid: string; refreshToken: string }> {
  const { secureToken } = endpoints(config);
  let response: Response;
  try {
    response = await fetch(`${secureToken}/token?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
  } catch (cause) {
    throw new AuthError('NETWORK', `Could not reach the token service: ${String(cause)}`);
  }

  const parsed: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = (parsed as IdentityError).error?.message ?? `HTTP_${response.status}`;
    throw new AuthError(code, readableAuthFailure(code));
  }

  const result = parsed as { id_token?: string; user_id?: string; refresh_token?: string };
  if (!result.id_token || !result.user_id) {
    throw new AuthError('MALFORMED', 'The token service returned an unexpected response.');
  }
  return {
    idToken: result.id_token,
    uid: result.user_id,
    refreshToken: result.refresh_token ?? refreshToken,
  };
}

/**
 * Get a usable session, cheaply where possible.
 *
 * Refresh first, password second. A refresh that fails is not an error the user
 * should see — it is a token that aged out — so it falls through silently, and
 * the stale one is dropped so the next run does not retry it.
 */
export async function currentSession(config: Config): Promise<Session> {
  const saved = getSecret(config.email, 'refresh');
  if (saved) {
    try {
      const refreshed = await exchangeRefreshToken(config, saved);
      if (refreshed.refreshToken !== saved) {
        setSecret(config.email, 'refresh', refreshed.refreshToken);
      }
      return { idToken: refreshed.idToken, uid: refreshed.uid, email: config.email };
    } catch (error) {
      if (error instanceof AuthError && error.code === 'NETWORK') throw error;
      deleteSecret(config.email, 'refresh');
    }
  }

  const password = getSecret(config.email, 'password');
  if (!password) {
    throw new AuthError(
      'NO_CREDENTIALS',
      'No saved credentials for this account. Run `hushjot login` again.',
    );
  }

  const { session, refreshToken } = await signInWithPassword(config, password);
  setSecret(config.email, 'refresh', refreshToken);
  return session;
}
