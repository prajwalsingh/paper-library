// Tests the Microsoft sign-in (PKCE, silent renewal, refresh tokens) with a fake chrome.identity.
//   node dev/tests/ms-auth.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const mem = { local: { msClientId: '11111111-2222-3333-4444-555555555555' }, session: {} };
const area = (o) => ({ async get(k) { return k in o ? { [k]: o[k] } : {}; }, async set(v) { Object.assign(o, v); }, async remove(k) { delete o[k]; } });
let challenge, flows = [], tokenCalls = [];
globalThis.chrome = {
  storage: { local: area(mem.local), session: area(mem.session) },
  identity: {
    getRedirectURL: () => 'https://hadmfffnocpeglonjioajbpdfbkbjekf.chromiumapp.org/',
    async launchWebAuthFlow({ url, interactive }) {
      const u = new URL(url); flows.push({ interactive, prompt: u.searchParams.get('prompt') });
      assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('response_type'), 'code');
      challenge = u.searchParams.get('code_challenge');
      if (!interactive) return `https://hadmfffnocpeglonjioajbpdfbkbjekf.chromiumapp.org/?error=login_required&error_description=AADSTS50058`;
      return `https://hadmfffnocpeglonjioajbpdfbkbjekf.chromiumapp.org/?code=C1&state=${u.searchParams.get('state')}`;
    },
  },
};
globalThis.fetch = async (url, init) => {
  const b = new URLSearchParams(init.body); tokenCalls.push(b.get('grant_type'));
  assert.equal(url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(b.get('client_id'), mem.local.msClientId);
  if (b.get('grant_type') === 'authorization_code') {
    const expect = createHash('sha256').update(b.get('code_verifier')).digest('base64url');
    assert.equal(expect, challenge, 'PKCE verifier matches challenge');
    return Response.json({ access_token: 'AT1', expires_in: 3600, refresh_token: 'RT1' });
  }
  if (b.get('refresh_token') === 'RT1') return Response.json({ access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2' });
  return Response.json({ error: 'invalid_grant' }, { status: 400 });
};
const a = await import(new URL('../../js/ms-auth.js', import.meta.url));
await assert.rejects(a.getToken(), (e) => e.code === 'needs-sign-in', 'silent fails → needs sign-in');
assert.equal(await a.getToken({ interactive: true }), 'AT1');
assert.equal(await a.getToken(), 'AT1', 'cached');
await a.invalidateToken();
assert.equal(await a.getToken(), 'AT2', 'refresh token used');
assert.equal(mem.session.msAuth.refresh, 'RT2', 'rotated refresh token stored');
mem.session.msAuth.expires = 0; mem.session.msAuth.refresh = 'bad';
await assert.rejects(a.getToken(), (e) => e.code === 'needs-sign-in', 'bad refresh → silent → needs sign-in');
delete mem.local.msClientId;
await assert.rejects(a.getToken({ interactive: true }), (e) => e.code === 'no-client-id');
console.log('MS AUTH TESTS PASSED', tokenCalls.join(','), JSON.stringify(flows.map(f=>f.prompt)));
