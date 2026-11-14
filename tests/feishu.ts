import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Feishu } from '../src/server/feishu.js';

/**
 * Who a stand-in code names: `mailbox`, or `union|mailbox` for a person whose
 * mailbox is not the one they started with.
 */
function who(code: string) {
  const [union, mailbox] = code.includes('|')
    ? code.split('|')
    : [`u-${code.trim().toLowerCase()}`, code];
  return { union: union ?? '', mailbox: mailbox ?? '' };
}
/** The identity the stand-ins give a mailbox, for writing to the store directly. */
export const feishuPerson = (mailbox: string) => ({
  feishuId: who(mailbox).union,
  email: mailbox.trim().toLowerCase(),
});

/**
 * Feishu for tests: the person chooses who to be at "Feishu" (see `who`),
 * the code says so, and the profile vouches for it. Codes starting with
 * "fail" make Feishu refuse the exchange.
 */
export const standInFeishu: Feishu = {
  authorizeUrl(state, redirectUri) {
    const url = new URL('https://feishu.test/authorize');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.href;
  },
  exchange(code) {
    if (code.startsWith('fail')) return Promise.reject(new Error('refused'));
    return Promise.resolve(`token:${code}`);
  },
  profile(token) {
    const { union, mailbox } = who(token.slice('token:'.length));
    return Promise.resolve({
      union,
      enterprise: mailbox,
      tenant: 'stand-in',
    });
  },
};

/** Signs in through /login as the given mailbox; the session's cookies. */
export async function signInAs(app: FastifyInstance, mailbox: string) {
  const begin = await app.inject({ url: '/login' });
  assert.equal(begin.statusCode, 302);
  const state = new URL(String(begin.headers.location)).searchParams.get(
    'state',
  );
  const cookie = begin.cookies.find((c) => c.name === 'kinmesh-login');
  assert.ok(state && cookie);
  const back = await app.inject({
    url: `/login/callback?code=${encodeURIComponent(mailbox)}&state=${state}`,
    cookies: { [cookie.name]: cookie.value },
  });
  assert.equal(back.headers.location, '/');
  const session = back.cookies.find((c) => c.name === 'kinmesh-session');
  assert.ok(session);
  return { [session.name]: session.value };
}

/**
 * The same stand-in over HTTP, for a hub in its own process
 * (KINMESH_FEISHU_URL). Its authorize page asks which mailbox to be; a client
 * may also name it as `mailbox` in the authorize URL.
 */
export async function startFeishuStandIn() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stand-in');
    if (url.pathname === '/open-apis/authen/v1/authorize') {
      const mailbox = url.searchParams.get('mailbox');
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      if (mailbox) {
        const back = new URL(redirect);
        back.searchParams.set('code', mailbox);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { location: back.href }).end();
        return;
      }
      const hidden = [...url.searchParams]
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`,
        )
        .join('');
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><title>Feishu</title><form>${hidden}<input name="mailbox" aria-label="Mailbox"><button>Continue</button></form>`,
        );
      return;
    }
    if (url.pathname === '/oauth/v3/token' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const { code } = z.object({ code: z.string() }).parse(JSON.parse(body));
        if (code.startsWith('fail')) {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ code: 20003, msg: 'invalid code' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            code: 0,
            access_token: Buffer.from(code).toString('base64url'),
          }),
        );
      });
      return;
    }
    if (url.pathname === '/open-apis/authen/v1/user_info') {
      const token = (request.headers.authorization ?? '').replace(
        /^Bearer /,
        '',
      );
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          code: 0,
          data: {
            union_id: who(Buffer.from(token, 'base64url').toString()).union,
            enterprise_email: who(Buffer.from(token, 'base64url').toString())
              .mailbox,
            tenant_key: 'stand-in',
          },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const { port } = address;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Signs in to a hub in its own process; the session's Cookie header. */
export async function signInOver(endpoint: string, mailbox: string) {
  const begin = await fetch(`${endpoint}/login`, { redirect: 'manual' });
  const cookie = begin.headers.getSetCookie().map((c) => c.split(';')[0]);
  const authorize = new URL(String(begin.headers.get('location')));
  authorize.searchParams.set('mailbox', mailbox);
  const chosen = await fetch(authorize, { redirect: 'manual' });
  const back = await fetch(String(chosen.headers.get('location')), {
    redirect: 'manual',
    headers: { cookie: cookie.join('; ') },
  });
  assert.equal(back.headers.get('location'), '/');
  const session = back.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith('kinmesh-session='));
  assert.ok(session);
  return session;
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
