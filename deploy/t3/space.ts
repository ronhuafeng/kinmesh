// The space provisioner: makes a channel's folder in the space a T3 project,
// for the hub (contract in docs/operations.md#the-space). T3 creates projects
// over MCP only for a Full access client, and Kinmesh only finds projects, so
// this runs beside T3 and uses its CLI. It ships in the kinmesh-t3 image and
// runs with Node alone (`node space.ts`): no dependencies, erasable types only.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import { join, resolve, sep } from 'node:path';
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
    if (req.method !== 'POST' || req.url !== '/projects') {
      answer(404, { error: 'not found' });
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > BODY_LIMIT) req.destroy();
    });
    req.on('end', () => {
      const input = inputOf(body);
      if (input === null) {
        answer(400, { error: 'invalid' });
        return;
      }
      queue = queue.then(async () => {
        try {
          answer(200, {
            workspaceRoot: await provision(
              options,
              input.directory,
              input.title,
            ),
          });
        } catch (error) {
          console.error(
            'provision failed:',
            error instanceof Error ? error.message.split('\n')[0] : 'error',
          );
          answer(500, { error: 'unavailable' });
        }
      });
    });
  });
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
  });
  server.listen(port, host, () => {
    console.log(`space provisioner on ${host}:${String(port)}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
