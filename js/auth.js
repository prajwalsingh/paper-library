// Google sign-in for the extension.
//
// We use chrome.identity.launchWebAuthFlow with Google's OAuth "token" flow:
// Chrome opens Google's consent page, Google redirects back to
// https://<extension-id>.chromiumapp.org/#access_token=..., and Chrome hands
// that URL to us. Unlike chrome.identity.getAuthToken, this works with ANY
// Google account (e.g. your institute account) even if Chrome itself is
// signed in with a different one.
//
// Tokens live ~1 hour. We cache them in chrome.storage.session (cleared when
// the browser closes) and renew silently (prompt=none) when they expire.

const SCOPES = [
  // Full Drive access is required to read and overwrite PDFs that this app did
  // not create itself (the narrower drive.file scope only covers app-created files).
  'https://www.googleapis.com/auth/drive',
];

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'no-client-id' | 'needs-sign-in' | 'failed'
  }
}

export async function getClientId() {
  const { oauthClientId } = await chrome.storage.local.get('oauthClientId');
  return (oauthClientId || '').trim();
}

export async function setClientId(id) {
  await chrome.storage.local.set({ oauthClientId: id.trim() });
  await chrome.storage.session.remove('authToken');
}

export function redirectUri() {
  return chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
}

async function launch(interactive) {
  const clientId = await getClientId();
  if (!clientId) throw new AuthError('OAuth client ID is not set up yet.', 'no-client-id');

  const { loginHint } = await chrome.storage.local.get('loginHint');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: redirectUri(),
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: url.toString(),
      interactive,
      // Google's silent flow redirects via JavaScript, so let the hidden page
      // finish loading instead of aborting on first load.
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 8000,
    });
  } catch (e) {
    throw new AuthError(e.message || String(e), interactive ? 'failed' : 'needs-sign-in');
  }
  const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  if (params.get('error')) {
    throw new AuthError(params.get('error'), interactive ? 'failed' : 'needs-sign-in');
  }
  const token = params.get('access_token');
  const expiresIn = Number(params.get('expires_in') || 3600);
  if (!token) throw new AuthError('No access token returned.', 'failed');
  const authToken = { token, expires: Date.now() + expiresIn * 1000 };
  await chrome.storage.session.set({ authToken });
  return token;
}

/**
 * Returns a valid access token.
 * interactive=false: only uses the cache or a silent renewal; throws
 * AuthError('needs-sign-in') if the user must click "Sign in".
 */
export async function getToken({ interactive = false } = {}) {
  const { authToken } = await chrome.storage.session.get('authToken');
  if (authToken && authToken.expires - Date.now() > 60_000) return authToken.token;
  try {
    return await launch(false);
  } catch (e) {
    if (!interactive || e.code === 'no-client-id') throw e;
    return launch(true);
  }
}

export async function invalidateToken() {
  await chrome.storage.session.remove('authToken');
}

export async function rememberAccount(email) {
  if (email) await chrome.storage.local.set({ loginHint: email });
}

export async function signOut() {
  const { authToken } = await chrome.storage.session.get('authToken');
  await chrome.storage.session.remove('authToken');
  await chrome.storage.local.remove('loginHint');
  if (authToken) {
    // Revoke so the next sign-in asks for an account again.
    fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(authToken.token), {
      method: 'POST',
    }).catch(() => {});
  }
}
