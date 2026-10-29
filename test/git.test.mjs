import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, prepare, validateChanges, push } from "../dist/git.js";
import { exec } from "../dist/io.js";
test("worktree repair pushes only validated descendant commits and rejects concurrent pushes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prsit-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.PRSIT_HOME = join(dir, "state");
  const bare = join(dir, "remote.git"),
    repo = join(dir, "repo");
  await exec("git", ["init", "--bare", "--initial-branch=main", bare]);
  await exec("git", ["clone", bare, repo]);
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.com");
  await writeFile(join(repo, "file"), "initial\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "push", "origin", "main");
  await git(repo, "switch", "-c", "fix");
  await writeFile(join(repo, "file"), "fix\n");
  await git(repo, "commit", "-am", "PR");
  await git(repo, "push", "origin", "fix");
  const head = await git(repo, "rev-parse", "HEAD");
  await git(bare, "update-ref", "refs/pull/1/head", head);
  const w = {
    id: "git",
    path: repo,
    remote: "origin",
    host: "github.com",
    owner: "owner",
    repo: "repo",
    number: 1,
  };
  const snapshot = { head, headRepo: "owner/repo", headBranch: "fix", baseBranch: "main" };
  const worktree = await prepare(w, snapshot, "job");
  const j = { id: "job", snapshot, worktree };
  assert.equal(await git(repo, "branch", "--show-current"), "fix");
  await writeFile(join(worktree, "file"), "repaired\n");
  await assert.rejects(() => validateChanges(j), /uncommitted/);
  await git(worktree, "commit", "-am", "repair");
  const repaired = await validateChanges(j);
  await push(w, j, repaired, head);
  assert.equal(await git(bare, "rev-parse", "refs/heads/fix"), repaired);
  await push(w, j, repaired, repaired); // Crash recovery is a no-op.
  await assert.rejects(() => push(w, j, repaired, "another-commit"), /Someone else pushed/);
  assert.equal(await readFile(join(repo, "file"), "utf8"), "fix\n");
  assert.equal(await prepare(w, snapshot, "job"), worktree); // Never resets recovered work.
  assert.equal(await git(worktree, "rev-parse", "HEAD"), repaired);
});
