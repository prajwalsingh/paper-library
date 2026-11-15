// Microsoft sign-in for OneDrive (personal and work/school accounts).
//
// Same idea as the Google sign-in in auth.js (chrome.identity.launchWebAuthFlow
// with the user's own app registration), but Microsoft wants the
// "authorization code + PKCE" flow instead of handing out tokens directly:
//   1. We make a random secret (the "code verifier") and send only its SHA-256
//      hash (the "challenge") with the sign-in page.
//   2. Microsoft redirects back to https://<extension-id>.chromiumapp.org/?code=…
//   3. We swap the code for tokens, proving with the original secret that we
//      are the same app that started the sign-in. No client secret is needed,
//      which is why the redirect URI is registered as a "Single-page application".
//
// Access tokens live ~1 hour. The refresh token (24 h for this app type) and
// the access token are kept in chrome.storage.session, which Chrome clears
// when the browser closes. After that, a silent sign-in (prompt=none) renews
// them as long as you are still signed in to Microsoft in this browser.

import { AuthError } from './auth.js';

export { AuthError };

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
// Files.ReadWrite: open and save any PDF in your OneDrive (like Drive's full scope).
// User.Read: show which account is signed in. offline_access: a refresh token.
const SCOPES = 'Files.ReadWrite User.Read offline_access';

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function getClientId() {
  const { msClientId } = await chrome.storage.local.get('msClientId');
  return (msClientId || '').trim();
}

export async function setClientId(id) {
  await chrome.storage.local.set({ msClientId: id.trim() });
  await chrome.storage.session.remove('msAuth');
}

export function redirectUri() {
  return chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: await getClientId(), scope: SCOPES, ...params }),
    });
  } catch (e) {
    // The request never got an answer: blocked by Chrome (network lock / site access), offline, or a firewall.
    throw new AuthError(
      `Microsoft accepted the sign-in, but Chrome could not reach login.microsoftonline.com to finish it (${e.message}). ` +
        'Open DevTools (F12) → Console for the exact reason.',
      'failed'
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new AuthError(body.error_description?.split('\r\n')[0] || body.error || `Token request failed (${res.status})`, 'needs-sign-in');
  }
  const msAuth = {
    token: body.access_token,
    expires: Date.now() + Number(body.expires_in || 3600) * 1000,
    refresh: body.refresh_token || null,
  };
  await chrome.storage.session.set({ msAuth });
  return msAuth.token;
}

async function launch(interactive) {
  const clientId = await getClientId();
  if (!clientId) throw new AuthError('Microsoft app (client) ID is not set up yet.', 'no-client-id');

  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  const { msLoginHint } = await chrome.storage.local.get('msLoginHint');
  const url = new URL(`${AUTHORITY}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: interactive ? 'select_account' : 'none',
    ...(msLoginHint ? { login_hint: msLoginHint } : {}),
  }).toString();

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: url.toString(),
      interactive,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 8000,
    });
  } catch (e) {
    throw new AuthError(e.message || String(e), interactive ? 'failed' : 'needs-sign-in');
  }
  const params = new URL(responseUrl).searchParams;
  if (params.get('error')) {
    const msg = params.get('error_description') || params.get('error');
    throw new AuthError(msg, interactive ? 'failed' : 'needs-sign-in');
  }
  if (params.get('state') !== state) throw new AuthError('Sign-in response did not match the request.', 'failed');
  const code = params.get('code');
  if (!code) throw new AuthError('No authorization code returned.', 'failed');
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
}

/**
 * Returns a valid access token (same contract as auth.getToken):
 * interactive=false only uses the cache, the refresh token or a silent sign-in.
 */
export async function getToken({ interactive = false } = {}) {
  const { msAuth } = await chrome.storage.session.get('msAuth');
  if (msAuth?.token && msAuth.expires - Date.now() > 60_000) return msAuth.token;
  if (msAuth?.refresh) {
    try {
      return await tokenRequest({ grant_type: 'refresh_token', refresh_token: msAuth.refresh });
    } catch {}
  }
  try {
    return await launch(false);
  } catch (e) {
    if (!interactive || e.code === 'no-client-id') throw e;
    return launch(true);
  }
}

export async function invalidateToken() {
  const { msAuth } = await chrome.storage.session.get('msAuth');
  // Keep the refresh token: it can still get a fresh access token.
  if (msAuth) await chrome.storage.session.set({ msAuth: { ...msAuth, token: null, expires: 0 } });
}

export async function rememberAccount(email) {
  if (email) await chrome.storage.local.set({ msLoginHint: email });
}

export async function signOut() {
  await chrome.storage.session.remove('msAuth');
  await chrome.storage.local.remove('msLoginHint');
}
