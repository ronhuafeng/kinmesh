import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { LOGIN_STATE_MS } from '../src/domain/contracts.js';
import type { Feishu } from '../src/server/feishu.js';
import { fixture } from './helpers.js';
import {
  feishuPerson,
  signInAs,
  STAND_IN_NAMES,
  STAND_IN_ORGANIZATION,
  STAND_IN_PICTURE,
  standInFeishu,
  startFeishuStandIn,
} from './feishu.js';
import { rawDatabase } from './raw.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { FeishuFailure, feishuClient } from '../src/server/feishu.js';

async function hub(feishu: Feishu = standInFeishu) {
  const f = await fixture();
  const store = await f.open();
  const app = await createApp(
    f.config,
    store,
    undefined,
    undefined,
    {},
    {
      feishu,
    },
  );
  return {
    path: f.path,
    store,
    app,
    async dispose() {
      await app.close();
      await f.cleanup();
    },
  };
}
/** Begins a sign-in; its state and the browser's state cookie. */
async function begin(app: Awaited<ReturnType<typeof hub>>['app']) {
  const response = await app.inject({ url: '/login' });
  const state = new URL(String(response.headers.location)).searchParams.get(
    'state',
  );
  const cookie = response.cookies.find((c) => c.name === 'kinmesh-login');
  assert.ok(state && cookie);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.httpOnly, true);
  return { state, cookies: { [cookie.name]: cookie.value } };
}
const back = (
  app: Awaited<ReturnType<typeof hub>>['app'],
  query: string,
  cookies: Record<string, string> = {},
) => app.inject({ url: `/login/callback?${query}`, cookies });

await test('Feishu sign-in asks for the mailbox, and sends the browser back here', async () => {
  const f = await fixture();
  const store = await f.open();
  const app = await createApp(f.config, store);
  try {
    const response = await app.inject({ url: '/login' });
    assert.equal(response.statusCode, 302);
    const url = new URL(String(response.headers.location));
    assert.equal(
      url.origin + url.pathname,
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    );
    assert.equal(url.searchParams.get('client_id'), 'cli_test');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'http://127.0.0.1:3000/login/callback',
    );
    assert.match(String(url.searchParams.get('scope')), /user\.email/);
    assert.match(String(url.searchParams.get('state')), /^[\w-]{43}$/);
    // The app secret never travels through the browser.
    assert.ok(!url.href.includes('test-secret'));
  } finally {
    await app.close();
    await f.cleanup();
  }
});

await test('the first person makes the team; everyone after joins it and #general', async () => {
  const h = await hub();
  try {
    const first = await signInAs(h.app, 'Ada.Lovelace@Example.com');
    const me = await h.app.inject({ url: '/api/me', cookies: first });
    assert.equal(me.statusCode, 200);
    assert.equal(
      me.json<{ human: { username: string } }>().human.username,
      'ada-lovelace',
    );
    const team = await h.app.inject({ url: '/api/team', cookies: first });
    const second = await signInAs(h.app, 'grace@example.com');
    const theirs = await h.app.inject({ url: '/api/team', cookies: second });
    interface Team {
      team: { id: string };
      channels: { name: string }[];
    }
    assert.equal(theirs.json<Team>().team.id, team.json<Team>().team.id);
    assert.deepEqual(
      theirs.json<Team>().channels.map((c) => c.name),
      ['general'],
    );
    // Signing in again is the same person, however the mailbox is written.
    const again = await signInAs(h.app, 'ada.lovelace@example.com');
    const same = await h.app.inject({ url: '/api/me', cookies: again });
    assert.deepEqual(same.json<unknown>(), me.json<unknown>());
  } finally {
    await h.dispose();
  }
});

await test('the team is named after the organization, and a sign-in goes on without it', async () => {
  // What Feishu answers, made when asked: a refusal made ahead would go unhandled.
  let name = () => Promise.resolve('为沃科技');
  const h = await hub({ ...standInFeishu, organization: () => name() });
  try {
    const teamName = async (cookies: Record<string, string>) =>
      (await h.app.inject({ url: '/api/team', cookies })).json<{
        team: { name: string };
      }>().team.name;
    assert.equal(
      await teamName(await signInAs(h.app, 'a@example.com')),
      '为沃科技',
    );
    // Renamed in Feishu, renamed here at the next sign-in.
    name = () => Promise.resolve('  Weiwo  ');
    assert.equal(
      await teamName(await signInAs(h.app, 'b@example.com')),
      'Weiwo',
    );
    // Feishu can't say: the name stays, and so does the person.
    name = () => Promise.reject(new Error('tenant query refused'));
    assert.equal(
      await teamName(await signInAs(h.app, 'c@example.com')),
      'Weiwo',
    );
    // Nobody renames it here.
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/team',
      cookies: await signInAs(h.app, 'a@example.com'),
      payload: { name: 'Other' },
    });
    assert.equal(put.statusCode, 404);
  } finally {
    await h.dispose();
  }
});

await test('a person is shown by their Feishu name and picture, refreshed at each sign-in, and a picture never stops a sign-in', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 7),
  ]);
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
    Buffer.alloc(32, 1),
  ]);
  // What Feishu answers, made when asked.
  let name: unknown = '张华枫';
  let avatar: unknown = 'https://feishu.test/a.png';
  let picture = (): Promise<Buffer> => Promise.resolve(png);
  const asked: string[] = [];
  const h = await hub({
    ...standInFeishu,
    async profile(token) {
      return { ...(await standInFeishu.profile(token)), name, avatar };
    },
    picture(url) {
      asked.push(url);
      return picture();
    },
  });
  try {
    const me = async (cookies: Record<string, string>) =>
      (await h.app.inject({ url: '/api/me', cookies })).json<{
        human: {
          id: string;
          username: string;
          name: string;
          avatar: string | null;
        };
      }>().human;
    const ada = await signInAs(h.app, 'ada@example.com');
    const first = await me(ada);
    assert.equal(first.username, 'ada');
    assert.equal(first.name, '张华枫');
    assert.ok(first.avatar);
    assert.deepEqual(asked, ['https://feishu.test/a.png']);
    const team = (await h.app.inject({ url: '/api/team', cookies: ada })).json<{
      team: { id: string };
    }>().team.id;
    const url = `/api/teams/${team}/people/${first.id}/avatar`;
    // Served from here, as itself, to the people of the team.
    const got = await h.app.inject({ url, cookies: ada });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers['content-type'], 'image/png');
    assert.equal(got.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(got.rawPayload, png);
    assert.equal((await h.app.inject({ url })).statusCode, 401);

    // Someone without a name or picture in Feishu: the handle stands in.
    name = undefined;
    avatar = undefined;
    const grace = await signInAs(h.app, 'grace@example.com');
    const plain = await me(grace);
    assert.equal(plain.name, 'grace');
    assert.equal(plain.avatar, null);
    assert.equal(
      (
        await h.app.inject({
          url: `/api/teams/${team}/people/${plain.id}/avatar`,
          cookies: ada,
        })
      ).statusCode,
      404,
    );
    assert.equal(asked.length, 1);
    // The workspace shows everyone by name, with their picture's time.
    const people = WorkspaceSnapshot.parse(
      (
        await h.app.inject({ url: '/api/workspace', cookies: grace })
      ).json<unknown>(),
    ).people.map((p) => [p.name, p.avatar === null]);
    assert.deepEqual(people, [
      ['张华枫', false],
      ['grace', true],
    ]);

    // Renamed and repictured in Feishu: so here, at the next sign-in.
    name = '  Ada Lovelace ';
    avatar = 'https://feishu.test/b.webp';
    picture = () => Promise.resolve(webp);
    await signInAs(h.app, 'ada@example.com');
    const renamed = await me(ada);
    assert.equal(renamed.name, 'Ada Lovelace');
    assert.notEqual(renamed.avatar, first.avatar);
    const changed = await h.app.inject({ url, cookies: ada });
    assert.equal(changed.headers['content-type'], 'image/webp');
    // The same picture again changes nothing.
    await signInAs(h.app, 'ada@example.com');
    assert.equal((await me(ada)).avatar, renamed.avatar);

    // A picture Feishu can't give, or one that isn't a picture, leaves the
    // one before; the sign-in goes on (signInAs asserts it).
    for (const refused of [
      () => Promise.reject(new Error('cdn down')),
      () => Promise.resolve(Buffer.from('<svg/>')),
      () => Promise.resolve(Buffer.concat([png, Buffer.alloc(130 * 1024)])),
    ]) {
      picture = refused;
      await signInAs(h.app, 'ada@example.com');
      assert.equal((await me(ada)).avatar, renamed.avatar);
      assert.deepEqual(
        (await h.app.inject({ url, cookies: ada })).rawPayload,
        webp,
      );
    }
    // Feishu leaves the name out: the name before stays.
    name = undefined;
    await signInAs(h.app, 'ada@example.com');
    assert.equal((await me(ada)).name, 'Ada Lovelace');
  } finally {
    await h.dispose();
  }
});

await test('a handle is the mailbox name, numbered when taken', async () => {
  const h = await hub();
  try {
    // One after another: each handle depends on those taken before it.
    const names = [];
    for (const email of [
      'li@example.com',
      'li@sub.example.com',
      'x@example.com',
    ])
      names.push((await h.store.signIn(feishuPerson(email))).username);
    assert.deepEqual(names, ['member-li', 'member-li-2', 'member-x']);
    assert.equal(
      (await h.store.signIn(feishuPerson('a.b+c@example.com'))).username,
      'a-b-c',
    );
  } finally {
    await h.dispose();
  }
});

await test('only an enterprise mailbox in the organization, from a tenant, signs in', async () => {
  const eve = { union: 'u-eve', tenant: 't' };
  const profiles: Record<string, Awaited<ReturnType<Feishu['profile']>>> = {
    outside: { ...eve, enterprise: 'eve@other.com' },
    lookalike: { ...eve, enterprise: 'eve@example.com.evil' },
    tenantless: { ...eve, enterprise: 'eve@example.com', tenant: '' },
    nobody: { ...eve, union: '', enterprise: 'eve@example.com' },
    // An account with no enterprise mailbox: its own, which the person
    // sets, is never read.
    personal: { ...eve, enterprise: null },
    enterprise: { ...eve, enterprise: ' Eve.Work@Example.com ' },
  };

  const h = await hub({
    ...standInFeishu,
    exchange: (code) => Promise.resolve(code),
    profile: (token) =>
      Promise.resolve(
        profiles[token] ?? { union: null, enterprise: null, tenant: null },
      ),
  });
  try {
    for (const code of [
      'outside',
      'lookalike',
      'tenantless',
      'nobody',
      'personal',
    ]) {
      const { state, cookies } = await begin(h.app);
      const response = await back(
        h.app,
        `code=${code}&state=${state}`,
        cookies,
      );
      assert.equal(response.headers.location, '/?signin=denied', code);
      assert.equal(
        response.cookies.find((c) => c.name === 'kinmesh-session'),
        undefined,
      );
    }
    for (const [code, username] of [['enterprise', 'eve-work']] as const) {
      const { state, cookies } = await begin(h.app);
      const response = await back(
        h.app,
        `code=${code}&state=${state}`,
        cookies,
      );
      assert.equal(response.headers.location, '/');
      const session = response.cookies.find(
        (c) => c.name === 'kinmesh-session',
      );
      assert.ok(session);
      const me = await h.app.inject({
        url: '/api/me',
        cookies: { [session.name]: session.value },
      });
      assert.equal(
        me.json<{ human: { username: string } }>().human.username,
        username,
      );
    }
  } finally {
    await h.dispose();
  }
});

await test('a sign-in returns once, to the browser that began it, within ten minutes', async () => {
  const h = await hub();
  try {
    const code = 'code=ada%40example.com';
    // No cookie, or another browser's.
    const a = await begin(h.app);
    const b = await begin(h.app);
    for (const cookies of [{}, b.cookies]) {
      const response = await back(h.app, `${code}&state=${a.state}`, cookies);
      assert.equal(response.headers.location, '/?signin=expired');
    }
    // Used once, it is spent.
    const c = await begin(h.app);
    assert.equal(
      (await back(h.app, `${code}&state=${c.state}`, c.cookies)).headers
        .location,
      '/',
    );
    assert.equal(
      (await back(h.app, `${code}&state=${c.state}`, c.cookies)).headers
        .location,
      '/?signin=expired',
    );
    // Too late.
    const now = Date.now();
    const late = await h.store.logins.begin(now);
    assert.equal(
      await h.store.logins.finish(late, now + LOGIN_STATE_MS),
      false,
    );
    // Turning back at Feishu just returns home.
    const d = await begin(h.app);
    const declined = await back(
      h.app,
      `error=access_denied&state=${d.state}`,
      d.cookies,
    );
    assert.equal(declined.headers.location, '/');
    assert.equal(
      declined.cookies.find((c) => c.name === 'kinmesh-session'),
      undefined,
    );
  } finally {
    await h.dispose();
  }
});

await test('Feishu failing turns the browser back without leaking what it said', async () => {
  const h = await hub();
  try {
    const { state, cookies } = await begin(h.app);
    const response = await back(
      h.app,
      `code=fail-secret&state=${state}`,
      cookies,
    );
    assert.equal(response.headers.location, '/?signin=unavailable');
  } finally {
    await h.dispose();
  }
});

await test('people signing in at once are one team, and one person each', async () => {
  const h = await hub();
  try {
    const mailboxes = ['a1@example.com', 'a2@example.com', 'a1@example.com'];
    const sessions = await Promise.all(
      mailboxes.map((m) => signInAs(h.app, m)),
    );
    const teams = await Promise.all(
      sessions.map(async (cookies) =>
        (await h.app.inject({ url: '/api/team', cookies })).json<{
          team: { id: string };
        }>(),
      ),
    );
    assert.equal(new Set(teams.map((t) => t.team.id)).size, 1);
    const people = await Promise.all(
      sessions.map(async (cookies) =>
        (await h.app.inject({ url: '/api/me', cookies })).json<{
          human: { id: string };
        }>(),
      ),
    );
    assert.equal(people[0]?.human.id, people[2]?.human.id);
    assert.notEqual(people[0]?.human.id, people[1]?.human.id);
  } finally {
    await h.dispose();
  }
});

await test('a person is their Feishu identity, whatever happens to their mailbox', async () => {
  const h = await hub();
  try {
    const me = async (code: string) => {
      const cookies = await signInAs(h.app, code);
      return (await h.app.inject({ url: '/api/me', cookies })).json<{
        human: { id: string; username: string };
      }>().human;
    };
    const ada = await me('u-ada|ada@example.com');
    // A renamed mailbox is still Ada.
    assert.deepEqual(await me('u-ada|lovelace@example.com'), ada);
    // Her old mailbox, handed to someone new, is someone new.
    const next = await me('u-next|ada@example.com');
    assert.notEqual(next.id, ada.id);
  } finally {
    await h.dispose();
  }
});

await test('a person from before Feishu is linked to their mailbox and signs in as themself', async () => {
  const h = await hub();
  try {
    const raw = rawDatabase(h.path);
    const team = await h.store.teamFor(
      (await h.store.signIn(feishuPerson('first@example.com'))).id,
    );
    assert.ok(team);
    await raw
      .prepare('INSERT INTO humans (id, username) VALUES (?, ?)')
      .run('00000000-0000-4000-8000-000000000001', 'old-timer');
    await raw
      .prepare('INSERT INTO memberships VALUES (?, ?)')
      .run('00000000-0000-4000-8000-000000000001', team.team.id);
    await raw.close();
    // Not a mailbox someone else holds; not a person who does not exist.
    await assert.rejects(async () => {
      await h.store.linkMailbox('old-timer', 'first@example.com');
    });
    await assert.rejects(async () => {
      await h.store.linkMailbox('nobody', 'n@example.com');
    });
    await h.store.linkMailbox('old-timer', 'old@example.com');
    const old = await signInAs(h.app, 'u-old|old@example.com');
    const them = await h.app.inject({ url: '/api/me', cookies: old });
    assert.equal(
      them.json<{ human: { username: string } }>().human.username,
      'old-timer',
    );
    // Once they have signed in with Feishu, their identity is settled.
    await assert.rejects(async () => {
      await h.store.linkMailbox('old-timer', 'other@example.com');
    });
  } finally {
    await h.dispose();
  }
});

await test('passwords and first-owner setup are gone', async () => {
  const h = await hub();
  try {
    for (const [method, url] of [
      ['POST', '/api/login'],
      ['POST', '/api/setup'],
      ['GET', '/api/setup/status'],
      ['POST', '/api/me/password'],
    ] as const) {
      const response = await h.app.inject({ method, url, payload: {} });
      assert.ok([401, 404].includes(response.statusCode), url);
    }
  } finally {
    await h.dispose();
  }
});

await test('the Feishu client reads a profile that leaves fields out, and names a failure without its content', async () => {
  const stand = await startFeishuStandIn();
  try {
    const feishu = feishuClient({
      appId: 'cli_test',
      appSecret: 'test-secret',
      emailDomain: 'example.com',
      standIn: stand.url,
    });
    const profile = await feishu.profile(
      await feishu.exchange(
        'ada@example.com',
        'http://127.0.0.1:3000/login/callback',
      ),
    );
    assert.deepEqual(profile, {
      union: 'u-ada@example.com',
      enterprise: 'ada@example.com',
      tenant: 'stand-in',
      name: undefined,
      avatar: undefined,
    });
    // A name and a picture, which is fetched from where Feishu says.
    const named = await feishu.profile(
      await feishu.exchange(
        'grace@example.com',
        'http://127.0.0.1:3000/login/callback',
      ),
    );
    assert.equal(named.name, STAND_IN_NAMES['grace@example.com']);
    assert.ok(typeof named.avatar === 'string');
    assert.deepEqual(await feishu.picture(named.avatar), STAND_IN_PICTURE);
    // Only over HTTPS (or from the stand-in), and never with credentials.
    for (const address of [
      'http://example.com/a.png',
      'https://user:pass@example.com/a.png',
      'file:///etc/passwd',
    ])
      await assert.rejects(
        feishu.picture(address),
        (error: unknown) =>
          error instanceof FeishuFailure &&
          error.message === 'feishu_picture_0',
      );
    assert.equal(await feishu.organization(), STAND_IN_ORGANIZATION);
    // Feishu's own error envelope, with a 200, is still a refusal.
    await assert.rejects(
      feishu.exchange('fail-secret-code', 'x'),
      (error: unknown) =>
        error instanceof FeishuFailure && error.message === 'feishu_token_200',
    );
  } finally {
    await stand.close();
  }
});
