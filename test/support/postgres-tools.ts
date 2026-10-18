import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { DISPOSABLE_MARKER } from './storage.js';

export type TestConnection = Readonly<{ connectionString: string }>;
const CONTAINER = 'mpd-m2-tests-postgres-1';

/** Explicit disposable cluster only. Secrets travel in process environment, never CLI arguments. */
export async function runPostgresTool(tool: 'pg_dump' | 'pg_restore', args: readonly string[], connection: TestConnection): Promise<void> {
  if (process.env.PG_TEST_DISPOSABLE !== 'true') throw new Error('PG_TEST_DISPOSABLE_REQUIRED');
  const url = new URL(connection.connectionString);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55432' || !/^\/mpd_identity_test_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) throw new Error('UNSAFE_TEST_TOOL_CONNECTION');
  if (decodeURIComponent(url.username) !== (tool === 'pg_dump' ? 'mpd_identity_backup' : 'mpd_identity_migrator')) throw new Error('UNSAFE_TEST_TOOL_ROLE');
  const client = new pg.Client({ connectionString: connection.connectionString });
  try {
    await client.connect();
    const result = await client.query("SELECT current_setting('server_version_num')::int AS version,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    if (Math.floor(result.rows[0].version / 10000) !== 17 || result.rows[0].marker !== DISPOSABLE_MARKER) throw new Error('UNSAFE_TEST_TOOL_CONNECTION');
    if (tool === 'pg_restore' && (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='mpd_identity'")).rowCount) throw new Error('UNSAFE_TEST_RESTORE_TARGET');
  } finally { await client.end(); }
  const options = [...args];
  let file: string;
  if (tool === 'pg_dump') {
    const index = options.findIndex(arg => arg.startsWith('--file='));
    if (index < 0) throw new Error('PRIVATE_DUMP_FILE_REQUIRED');
    file = options.splice(index, 1)[0]!.slice(7);
    if (!options.includes('--format=custom') || !options.includes('--schema=mpd_identity')) throw new Error('UNSAFE_TEST_TOOL_OPTIONS');
  } else {
    file = options.pop() ?? '';
    if (!options.includes('--exit-on-error') || !options.includes('--role=mpd_identity_owner')) throw new Error('UNSAFE_TEST_TOOL_OPTIONS');
  }
  if (!isAbsolute(file) || options.some(arg => !['--format=custom', '--schema=mpd_identity', '--no-owner', '--no-privileges', '--exit-on-error', '--role=mpd_identity_owner'].includes(arg)) || !options.includes('--no-owner') || !options.includes('--no-privileges')) throw new Error('UNSAFE_TEST_TOOL_OPTIONS');
  const parent = await stat(dirname(file));
  if ((parent.mode & 0o777) !== 0o700) throw new Error('PRIVATE_DUMP_DIRECTORY_REQUIRED');
  if (tool === 'pg_restore' && ((await stat(file)).mode & 0o077) !== 0) throw new Error('PRIVATE_DUMP_FILE_REQUIRED');
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1), PGAPPNAME: `mpd_fixture_${tool}` };
  const docker = ['exec', '-i', ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGAPPNAME'].flatMap(name => ['-e', name]), CONTAINER, tool];
  await checkVersion(tool);
  if (tool === 'pg_restore') options.push(`--dbname=${env.PGDATABASE}`);
  if (tool === 'pg_dump') { const handle = await open(file, 'wx', 0o600); await handle.close(); }
  const child = spawn('docker', [...docker, ...options], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let errorBytes = 0;
  child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 65_536) child.kill(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const exit = new Promise<void>((resolve, reject) => { child.on('error', () => reject(new Error('POSTGRES_TOOL_FAILED'))); child.on('close', code => code === 0 ? resolve() : reject(new Error('POSTGRES_TOOL_FAILED'))); });
    if (tool === 'pg_dump') { child.stdin.end(); await Promise.all([pipeline(child.stdout, createWriteStream(file, { flags: 'r+', mode: 0o600 })), exit]); }
    else { child.stdout.resume(); await Promise.all([pipeline(createReadStream(file), child.stdin), exit]); }
  } catch { child.kill('SIGKILL'); throw new Error('POSTGRES_TOOL_FAILED'); }
  finally { clearTimeout(timer); }
}

async function checkVersion(tool: 'pg_dump' | 'pg_restore'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['exec', CONTAINER, tool, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('close', () => clearTimeout(timer));
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.resume();
    child.on('error', () => reject(new Error('POSTGRES_TOOL_VERSION_REQUIRED')));
    child.on('close', code => code === 0 && /PostgreSQL\) 17\./.test(output) ? resolve() : reject(new Error('POSTGRES_TOOL_VERSION_REQUIRED')));
  });
}
