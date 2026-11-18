// The coding agents T3 runs (pi, Codex, Claude Code) live in the persistent
// npm prefix, so an agent, T3 or a person may upgrade them and the upgrade
// stays. The image carries a version of each in /opt/agents, the floor: at
// start each goes into the prefix unless one as new or newer is there.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const SEED = process.env.KINMESH_AGENTS_SEED ?? '/opt/agents';
const PREFIX = process.env.NPM_CONFIG_PREFIX ?? join(homedir(), '.local');

interface Manifest {
  version: string;
  /** Command name to the file it runs, inside the package. */
  bins: Record<string, string>;
}
/** A package's version and commands, or null when there is none. */
function manifest(dir: string, name: string): Manifest | null {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  const read: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof read !== 'object' || read === null) return null;
  const version = 'version' in read ? read.version : undefined;
  if (typeof version !== 'string') return null;
  const bin = 'bin' in read ? read.bin : undefined;
  const bins: Record<string, string> = {};
  if (typeof bin === 'string') bins[name.split('/').pop() ?? name] = bin;
  else if (typeof bin === 'object' && bin !== null)
    for (const [command, path] of Object.entries(bin))
      if (typeof path === 'string') bins[command] = path;
  return { version, bins };
}
/** -1, 0 or 1; a prerelease is older than its release. */
function compare(a: string, b: string) {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { parts: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
/** Package folders under a node_modules, scoped ones included. */
function packages(modules: string) {
  if (!existsSync(modules)) return [];
  return readdirSync(modules).flatMap((entry) =>
    entry.startsWith('@')
      ? readdirSync(join(modules, entry)).map((name) => `${entry}/${name}`)
      : [entry],
  );
}

const seedModules = join(SEED, 'lib', 'node_modules');
const modules = join(PREFIX, 'lib', 'node_modules');
const bin = join(PREFIX, 'bin');
mkdirSync(modules, { recursive: true });
mkdirSync(bin, { recursive: true });
for (const name of packages(seedModules)) {
  const seed = manifest(join(seedModules, name), name);
  if (seed === null) continue;
  const target = join(modules, name);
  const there = manifest(target, name);
  if (there !== null && compare(there.version, seed.version) >= 0) {
    console.info(`${name} ${there.version} kept (image has ${seed.version})`);
    continue;
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(seedModules, name), target, {
    recursive: true,
    verbatimSymlinks: true,
  });
  for (const [command, path] of Object.entries(seed.bins)) {
    const link = join(bin, command);
    // A command installed some other way (Claude Code's own updater) stays.
    if (existsSync(link) || isLink(link)) {
      if (!isLink(link) || !readlinkSync(link).includes('node_modules'))
        continue;
      rmSync(link);
    }
    symlinkSync(relative(bin, join(target, path)), link);
  }
  console.info(
    `${name} ${seed.version} installed${there ? ` over ${there.version}` : ''}`,
  );
}
function isLink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
