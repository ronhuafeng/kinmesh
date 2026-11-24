// The space provisioner: makes a channel's folder in the space a T3 project,
// and keeps each agent's own Codex home, for the hub (contract in
// docs/operations.md#the-space). T3 creates projects
// over MCP only for a Full access client, and Kinmesh only finds projects, so
// this runs beside T3 and uses its CLI. It ships in the kinmesh-t3 image and
// runs with Node alone (`node space.ts`): no dependencies, erasable types only.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** Lowercase letters, digits and `-`: never a path, never leaving the space. */
const DIRECTORY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const BODY_LIMIT = 4096;

export interface SpaceOptions {
  /** The space: every channel's folder is directly inside it. */
  space: string;
  /** The bearer token the hub presents. */
  token: string;
  /** T3's CLI. */
  t3: string;
  /** Where each agent's own provider homes are kept. */
  agents?: string;
  /**
   * This machine's Codex sign-in, which every agent's Codex home shares;
   * null when Codex is not signed in here.
   */
  codexAuth?: string | null;
}

/** An agent's ID, as Kinmesh makes them. */
const AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODEX = /^\/agents\/([^/]+)\/codex$/;
/** A Team MCP credential, as Kinmesh issues them. */
const CREDENTIAL = /^[A-Za-z0-9_-]{8,256}$/;
/** The agent's own Codex home: T3's Codex provider for it points here. */
const codexHome = (options: SpaceOptions, agent: string) =>
  join(
    resolve(options.agents ?? join(homedir(), '.kinmesh', 'agents')),
    agent,
    'codex',
  );
/**
 * Writes the agent's Codex configuration: Kinmesh's Team MCP at `url` as
 * the agent (`token`), its tools let through without asking a person, and
 * this machine's Codex sign-in. The file is Kinmesh's, written whole.
 */
function writeCodex(
  options: SpaceOptions,
  agent: string,
  url: string,
  token: string,
) {
  const home = codexHome(options, agent);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const auth = join(home, 'auth.json');
  const signIn = options.codexAuth ?? join(homedir(), '.codex', 'auth.json');
  let linked = true;
  try {
    lstatSync(auth);
  } catch {
    linked = false;
  }
  if (!linked && options.codexAuth !== null && existsSync(signIn))
    symlinkSync(signIn, auth);
  const file = join(home, 'config.toml');
  const temporary = join(home, `.config.${randomBytes(6).toString('hex')}`);
  // A JSON string is a TOML basic string.
  writeFileSync(
    temporary,
    [
      '# Written by Kinmesh for this agent; it is replaced when Kinmesh',
      '# connects the agent again.',
      'cli_auth_credentials_store = "file"',
      '',
      '[mcp_servers.kinmesh]',
      `url = ${JSON.stringify(url)}`,
      `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`,
      'default_tools_approval_mode = "approve"',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  renameSync(temporary, file);
  return home;
}
/** `{url, token}` from a request body, or null when it is not one. */
function codexInputOf(body: string): { url: string; token: string } | null {
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return null;
  }
  if (input === null || typeof input !== 'object') return null;
  const url = 'url' in input ? input.url : undefined;
  const token = 'token' in input ? input.token : undefined;
  if (typeof url !== 'string' || typeof token !== 'string') return null;
  if (url.length > 2048 || !CREDENTIAL.test(token)) return null;
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return { url, token };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

async function provision(
  options: SpaceOptions,
  directory: string,
  title: string,
) {
  const space = resolve(options.space);
  const root = resolve(space, directory);
  if (!root.startsWith(space + sep)) throw new Error('outside the space');
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, '.git'))) {
    const git = (...args: string[]) =>
      run(
        'git',
        [
          '-c',
          'user.name=Kinmesh',
          '-c',
          'user.email=kinmesh@localhost',
          ...args,
        ],
        { cwd: root },
      );
    await git('init', '-q', '-b', 'main');
    const readme = join(root, 'README.md');
    if (!existsSync(readme)) writeFileSync(readme, `# ${title}\n`);
    await git('add', 'README.md');
    await git('commit', '-q', '-m', 'Start the channel');
  }
  try {
    await run(options.t3, ['project', 'add', '--title', title, root]);
  } catch (error) {
    // Already a project: nothing to do. T3 says why on its output.
    const said =
      error !== null && typeof error === 'object'
        ? `${String('stdout' in error ? error.stdout : '')}${String('stderr' in error ? error.stderr : '')}`
        : '';
    if (!said.includes('already exists')) throw error;
  }
  return root;
}

/** `{directory, title}` from a request body, or null when it is not one. */
function inputOf(body: string): { directory: string; title: string } | null {
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return null;
  }
  if (input === null || typeof input !== 'object') return null;
  const directory = 'directory' in input ? input.directory : undefined;
  const raw = 'title' in input ? input.title : undefined;
  if (typeof directory !== 'string' || !DIRECTORY.test(directory)) return null;
  const title =
    typeof raw === 'string'
      ? raw
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 80)
      : '';
  return title === '' ? null : { directory, title };
}

/** A file the hub places at most: 200 MB, as Kinmesh attaches. */
const FILE_LIMIT = 200 * 1024 * 1024;
const ATTACHMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLACE = /^\/projects\/([^/]+)\/attachments\/([^/]+)$/;
/**
 * A file name kept inside `attachments/`: its last segment, letters,
 * digits, `.`, `_`, `-` and spaces, no leading dot, at most 100 characters
 * with its extension kept.
 */
export function placedName(id: string, name: string) {
  const last = name.split(/[/\\]/).at(-1) ?? '';
  let clean = last
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^[. ]+/, '')
    .trim();
  if (clean === '') clean = 'file';
  if (clean.length > 100) {
    const dot = clean.lastIndexOf('.');
    const extension =
      dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
    clean = clean.slice(0, 100 - extension.length) + extension;
  }
  return `${id.slice(0, 8)}-${clean}`;
}
/** The channel's folder, when it is one this provisioner made. */
function folderOf(options: SpaceOptions, directory: string) {
  if (!DIRECTORY.test(directory)) return null;
  const space = resolve(options.space);
  const root = resolve(space, directory);
  if (!root.startsWith(space + sep) || !existsSync(join(root, '.git')))
    return null;
  return root;
}
/** `attachments/` stays out of the folder's git status, diffs and commits. */
function excluded(root: string) {
  const info = join(root, '.git', 'info');
  mkdirSync(info, { recursive: true });
  const exclude = join(info, 'exclude');
  const kept = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!kept.split('\n').includes('attachments/'))
    writeFileSync(
      exclude,
      kept +
        (kept === '' || kept.endsWith('\n') ? '' : '\n') +
        'attachments/\n',
    );
}
/** What is already placed for an attachment, by its ID's start. */
function placedFor(folder: string, id: string) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(
    (name) =>
      name.startsWith(id.slice(0, 8) + '-') && !name.endsWith('.partial'),
  );
}
/**
 * Places received bytes (`partial`, already in `attachments/`, whose SHA-256
 * is `hash`) as an attachment, whole or not at all. The same ID with the
 * same bytes again changes nothing; with other bytes it is a conflict.
 */
function place(
  root: string,
  id: string,
  name: string,
  partial: string,
  hash: string,
) {
  const folder = join(root, 'attachments');
  const [there] = placedFor(folder, id);
  if (there !== undefined) {
    rmSync(partial, { force: true });
    const path = join(folder, there);
    return hashOf(path) === hash ? path : null;
  }
  const path = join(folder, placedName(id, name));
  renameSync(partial, path);
  return path;
}
/** A file's SHA-256, read a megabyte at a time. */
function hashOf(path: string) {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let read; (read = readSync(fd, chunk)) > 0;)
      hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}
/**
 * Receives an attachment's bytes into a new file in the folder's
 * `attachments/`, hashing them as they come: its path and SHA-256, or null
 * when they are more than allowed or the request ends early.
 */
async function receive(root: string, req: IncomingMessage) {
  excluded(root);
  const folder = join(root, 'attachments');
  mkdirSync(folder, { recursive: true });
  const partial = join(folder, `.${randomBytes(8).toString('hex')}.partial`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > FILE_LIMIT) throw new Error('too large');
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
  } catch {
    rmSync(partial, { force: true });
    return null;
  }
  return { partial, hash: hash.digest('hex') };
}
function unplace(root: string, id: string) {
  const folder = join(root, 'attachments');
  for (const name of placedFor(folder, id))
    rmSync(join(folder, name), { force: true });
}

export function spaceServer(options: SpaceOptions): Server {
  const expected = digest(options.token);
  // One at a time: two topics of a channel may ask at once.
  let queue = Promise.resolve();
  return createServer((req, res) => {
    const answer = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? '';
    if (
      !auth.startsWith('Bearer ') ||
      !timingSafeEqual(digest(auth.slice(7)), expected)
    ) {
      answer(401, { error: 'unauthorized' });
      return;
    }
    const placing = PLACE.exec(req.url ?? '');
    const pairing = req.method === 'POST' && req.url === '/pair';
    const codex = CODEX.exec(req.url ?? '');
    if (
      !(req.method === 'POST' && req.url === '/projects') &&
      !pairing &&
      !(placing && (req.method === 'PUT' || req.method === 'DELETE')) &&
      !(codex && (req.method === 'GET' || req.method === 'PUT'))
    ) {
      answer(404, { error: 'not found' });
      return;
    }
    const queued = (work: { run: () => Promise<Answer> }) => {
      queue = queue.then(async () => {
        try {
          const done = await work.run();
          answer(done.status, done.body);
        } catch (error) {
          console.error(
            'provision failed:',
            error instanceof Error ? error.message.split('\n')[0] : 'error',
          );
          answer(500, { error: 'unavailable' });
        }
      });
    };
    // A file's bytes go straight to disk, and only placing them waits its turn.
    if (placing && req.method === 'PUT') {
      const target = placingTarget(options, placing, req.headers);
      if ('status' in target) {
        answer(target.status, target.body);
        req.resume();
        return;
      }
      void receive(target.root, req).then((got) => {
        if (got?.hash !== target.hash) {
          if (got) rmSync(got.partial, { force: true });
          answer(400, { error: 'invalid' });
          return;
        }
        queued({
          run: () => {
            const path = place(
              target.root,
              target.id,
              target.name,
              got.partial,
              got.hash,
            );
            return Promise.resolve(
              path === null
                ? { status: 409, body: { error: 'conflict' } }
                : { status: 200, body: { path } },
            );
          },
        });
      });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        answer(413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const work = pairing
        ? pairRoute(options, body)
        : codex
          ? codexRoute(options, req.method ?? '', codex[1] ?? '', body)
          : route(options, req.method ?? '', placing, body);
      if ('status' in work) answer(work.status, work.body);
      else queued(work);
    });
  });
}
/**
 * A pairing code for a browser to reach T3: `t3 pair`, for five minutes,
 * labelled with who asked, so T3's connections list says whose it is.
 */
function pairRoute(
  options: SpaceOptions,
  body: Buffer,
): Answer | { run: () => Promise<Answer> } {
  let label = '';
  try {
    const input: unknown = JSON.parse(body.toString('utf8'));
    if (input !== null && typeof input === 'object' && 'label' in input)
      label = String(input.label)
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, 60);
  } catch {
    // An empty body asks without a label.
  }
  return {
    run: async () => {
      const { stdout } = await run(options.t3, [
        'pair',
        '--ttl',
        '5m',
        ...(label === '' ? [] : ['--label', label]),
      ]);
      const token = /^Token: (\S+)$/m.exec(stdout)?.[1];
      const expiresAt = /^Expires: (\S+)$/m.exec(stdout)?.[1];
      if (token === undefined || expiresAt === undefined)
        throw new Error('t3 pair answered nothing to read');
      return { status: 200, body: { token, expiresAt } };
    },
  };
}
/**
 * The agent's Codex home: where it is (`GET`), or its configuration written
 * there (`PUT` with `{url, token}`). Asking again is safe.
 */
function codexRoute(
  options: SpaceOptions,
  method: string,
  agent: string,
  body: Buffer,
): Answer | { run: () => Promise<Answer> } {
  const invalid = { status: 400, body: { error: 'invalid' } };
  if (!AGENT.test(agent)) return invalid;
  if (method === 'GET')
    return { status: 200, body: { home: codexHome(options, agent) } };
  const input = codexInputOf(body.toString('utf8'));
  if (input === null) return invalid;
  return {
    run: () =>
      Promise.resolve({
        status: 200,
        body: { home: writeCodex(options, agent, input.url, input.token) },
      }),
  };
}
interface Answer {
  status: number;
  body: object;
}
/**
 * What a request asks for: refused at once (`status`), or work to do in
 * turn (`run`).
 */
function route(
  options: SpaceOptions,
  method: string,
  placing: RegExpExecArray | null,
  body: Buffer,
): Answer | { run: () => Promise<Answer> } {
  const invalid = { status: 400, body: { error: 'invalid' } };
  if (placing === null) {
    const input = inputOf(body.toString('utf8'));
    if (input === null) return invalid;
    return {
      run: async () => ({
        status: 200,
        body: {
          workspaceRoot: await provision(options, input.directory, input.title),
        },
      }),
    };
  }
  const [, directory = '', id = ''] = placing;
  if (!ATTACHMENT.test(id)) return invalid;
  const root = folderOf(options, directory);
  if (root === null) return { status: 404, body: { error: 'not found' } };
  return {
    run: () => {
      unplace(root, id);
      return Promise.resolve({ status: 200, body: {} });
    },
  };
}
/**
 * Where a file is to be placed, from what the request says before its
 * bytes: its folder, ID, name and SHA-256. Refused at once otherwise.
 */
function placingTarget(
  options: SpaceOptions,
  placing: RegExpExecArray,
  headers: IncomingHttpHeaders,
): Answer | { root: string; id: string; name: string; hash: string } {
  const invalid = { status: 400, body: { error: 'invalid' } };
  const [, directory = '', id = ''] = placing;
  if (!ATTACHMENT.test(id)) return invalid;
  if (Number(headers['content-length'] ?? 0) > FILE_LIMIT)
    return { status: 413, body: { error: 'too large' } };
  const root = folderOf(options, directory);
  if (root === null) return { status: 404, body: { error: 'not found' } };
  let name = '';
  try {
    name = decodeURIComponent(String(headers['x-kinmesh-name'] ?? ''));
  } catch {
    return invalid;
  }
  const hash = String(headers['x-kinmesh-sha256'] ?? '');
  if (name === '' || !/^[a-f0-9]{64}$/.test(hash)) return invalid;
  return { root, id, name, hash };
}

/**
 * The token, made once and kept: in a file (one machine), or in a
 * Kubernetes Secret the hub reads too (`namespace/name`), through the API
 * with the pod's service account.
 */
async function keptToken(env: NodeJS.ProcessEnv): Promise<string> {
  const file = env.KINMESH_SPACE_TOKEN_FILE;
  const secret = env.KINMESH_SPACE_TOKEN_SECRET;
  if ((file === undefined) === (secret === undefined))
    throw new Error(
      'Set one of KINMESH_SPACE_TOKEN_FILE or KINMESH_SPACE_TOKEN_SECRET.',
    );
  if (file !== undefined) {
    const kept = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (kept !== '') return kept;
    const made = randomBytes(32).toString('hex');
    writeFileSync(file, made + '\n', { mode: 0o600 });
    return made;
  }
  const [namespace, name] = (secret ?? '').split('/');
  if (!namespace || !name)
    throw new Error('KINMESH_SPACE_TOKEN_SECRET is namespace/name.');
  const account =
    env.KINMESH_SPACE_ACCOUNT ??
    '/var/run/secrets/kubernetes.io/serviceaccount';
  const path = `/api/v1/namespaces/${namespace}/secrets/${name}`;
  const api = (method: string, patch?: object) =>
    new Promise<unknown>((done, fail) => {
      const data = patch === undefined ? undefined : JSON.stringify(patch);
      const req = request(
        {
          host: 'kubernetes.default.svc',
          path,
          method,
          ca: readFileSync(join(account, 'ca.crt')),
          headers: {
            authorization: `Bearer ${readFileSync(join(account, 'token'), 'utf8').trim()}`,
            ...(data === undefined
              ? {}
              : {
                  'content-type': 'application/merge-patch+json',
                  'content-length': Buffer.byteLength(data),
                }),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) done(JSON.parse(text));
            else fail(new Error(`secret ${String(res.statusCode)}`));
          });
        },
      );
      req.on('error', fail);
      req.end(data);
    });
  const found = await api('GET');
  const data =
    found !== null && typeof found === 'object' && 'data' in found
      ? found.data
      : undefined;
  const kept =
    data !== null && typeof data === 'object' && 'token' in data
      ? data.token
      : undefined;
  if (typeof kept === 'string' && kept !== '')
    return Buffer.from(kept, 'base64').toString('utf8');
  const made = randomBytes(32).toString('hex');
  await api('PATCH', { data: { token: Buffer.from(made).toString('base64') } });
  return made;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === import.meta.filename) {
  const env = process.env;
  const port = Number(env.KINMESH_SPACE_PORT ?? 3774);
  const host = env.KINMESH_SPACE_HOST ?? '127.0.0.1';
  const space = env.KINMESH_SPACE_DIR ?? '/space';
  if (!existsSync(space)) throw new Error(`The space ${space} does not exist.`);
  const server = spaceServer({
    space,
    token: await keptToken(env),
    t3: env.KINMESH_SPACE_T3 ?? 't3',
    ...(env.KINMESH_AGENT_HOMES === undefined
      ? {}
      : { agents: env.KINMESH_AGENT_HOMES }),
    ...(env.KINMESH_CODEX_AUTH === undefined
      ? {}
      : {
          codexAuth:
            env.KINMESH_CODEX_AUTH === '' ? null : env.KINMESH_CODEX_AUTH,
        }),
  });
  server.listen(port, host, () => {
    console.log(`space provisioner on ${host}:${String(port)}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
