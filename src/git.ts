import {exec, hash, home} from './io.js';
import {join, resolve} from 'node:path';
import {mkdir, stat} from 'node:fs/promises';
import type {Watch, Snapshot, Job} from './types.js';

export function repoIdentity(remote: string): string | undefined {
  const match = remote.match(/^(?:https?:\/\/|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}/${match[3].toLowerCase()}` : undefined;
}
export const git = async (cwd: string, ...args: string[]) => (await exec('git', args, {cwd})).stdout.trim();
export async function discover(path: string, identity: string) {
  const root = await git(resolve(path), 'rev-parse', '--show-toplevel');
  for (const remote of (await git(root, 'remote')).split('\n')) {
    const url = await git(root, 'remote', 'get-url', remote);
    if (repoIdentity(url) === identity.toLowerCase()) return {path: root, remote};
  }
  throw new Error(`No Git remote in ${root} matches ${identity}`);
}
export async function prepare(w: Watch, snapshot: Snapshot, jobId: string): Promise<string> {
  const path = join(home(), 'worktrees', w.id, jobId);
  try { await stat(path); } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    await git(w.path, 'fetch', '--no-tags', w.remote, `refs/pull/${w.number}/head`);
    if (await git(w.path, 'rev-parse', 'FETCH_HEAD') !== snapshot.head) throw new Error('PR head changed before worktree creation; retry on fresh snapshot');
    await mkdir(resolve(path, '..'), {recursive: true});
    await git(w.path, 'worktree', 'add', '--detach', path, snapshot.head);
  }
  await git(path, 'fetch', '--no-tags', w.remote, snapshot.baseBranch);
  await git(path, 'update-ref', `refs/prsit/base/${w.id}`, 'FETCH_HEAD');
  // Worktree is reused after a crash; never reset or clean an existing worktree.
  return path;
}
export async function validateChanges(job: Job) {
  if (await git(job.worktree, 'status', '--porcelain')) throw new Error('Agent left uncommitted changes; inspect the worktree and resume');
  const head = await git(job.worktree, 'rev-parse', 'HEAD');
  await git(job.worktree, 'merge-base', '--is-ancestor', job.snapshot.head, head);
  return head;
}
export async function push(w: Watch, job: Job, head: string, remoteHead: string) {
  if (remoteHead === head) return; // Reconcile a successful push whose local checkpoint was lost.
  if (remoteHead !== job.snapshot.head) throw new Error('Someone else pushed to the PR; refusing to overwrite their work');
  if (head === remoteHead) return;
  const targetIdentity = `${w.host}/${job.snapshot.headRepo}`.toLowerCase();
  let remote: string | undefined = job.snapshot.headRepo.toLowerCase() === `${w.owner}/${w.repo}`.toLowerCase() ? await git(w.path, 'remote', 'get-url', w.remote) : undefined;
  for (const name of (await git(w.path, 'remote')).split('\n')) {
    const url = await git(w.path, 'remote', 'get-url', name);
    if (repoIdentity(url) === targetIdentity) { remote = url; break; }
  }
  remote ??= `https://${w.host}/${job.snapshot.headRepo}.git`;
  await git(job.worktree, 'push', remote, `${head}:refs/heads/${job.snapshot.headBranch}`);
}
