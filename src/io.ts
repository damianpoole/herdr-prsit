import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, readdir, appendFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import type {Watch} from './types.js';

export const home = () => resolve(process.env.PRSIT_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-prsit'));
export const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')); }
export async function optional<T>(path: string): Promise<T | undefined> {
  try { return await json<T>(path); } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
}
export async function atomic(path: string, value: unknown) {
  await mkdir(resolve(path, '..'), {recursive: true, mode: 0o700});
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), {mode: 0o600});
  await rename(tmp, path);
}
export async function watches(): Promise<Watch[]> {
  await mkdir(join(home(), 'watches'), {recursive: true, mode: 0o700});
  const entries = await readdir(join(home(), 'watches'));
  return Promise.all(entries.filter(x => x.endsWith('.json')).map(x => json<Watch>(join(home(), 'watches', x))));
}
export async function findWatch(key: string) {
  const found = (await watches()).filter(w => [w.id, w.url, String(w.number)].includes(key));
  if (found.length !== 1) throw new Error('Watch not found or PR number is ambiguous; use its watch ID or URL');
  return found[0];
}
export const watchDir = (w: Watch) => join(home(), w.id);
export async function log(w: Watch, message: string) {
  await mkdir(watchDir(w), {recursive: true, mode: 0o700});
  const line = `${new Date().toISOString()} ${message}\n`;
  await appendFile(join(watchDir(w), 'events.log'), line, {mode: 0o600});
  console.log(`${w.id} ${message}`);
}
export async function exec(command: string, args: string[], opts: {
  cwd?: string; input?: string; timeout?: number; allowed?: number[]; signal?: AbortSignal;
  onData?: (chunk: string) => void;
} = {}): Promise<{stdout: string; stderr: string; code: number}> {
  return new Promise((done, fail) => {
    const env:NodeJS.ProcessEnv={...process.env,MISE_QUIET:'1'}; delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, args, {cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true});
    let stdout = '', stderr = '', ended = false, killed: string | undefined;
    let killer: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      killed = why;
      try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
      killer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 2000);
      killer.unref();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed out'), opts.timeout ?? 120_000);
    const cleanup = () => { ended = true; clearTimeout(timer); if (killer) clearTimeout(killer); opts.signal?.removeEventListener('abort', abort); };
    opts.signal?.addEventListener('abort', abort, {once: true});
    if (opts.signal?.aborted) abort();
    child.on('error', e => { cleanup(); fail(e); });
    child.stdout.on('data', b => { stdout += b.toString(); opts.onData?.(b.toString()); if (stdout.length > 32_000_000) stop('output exceeded 32 MB'); });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-128_000); });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
    child.on('close', code => {
      if (ended) return;
      cleanup();
      if (killed || !(opts.allowed ?? [0]).includes(code ?? -1)) fail(new Error(`${command}: ${killed ?? (stderr.trim() || stdout.slice(-2000) || `exit ${code}`)}`));
      else done({stdout, stderr, code: code!});
    });
  });
}
