import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePR } from "../dist/pr.js";
import { exec } from "../dist/io.js";

test("PR numbers resolve from a checkout or subdirectory, ignoring GH_REPO", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prsit number "));
  const env = { ...process.env };
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  const repo = join(dir, "repo");
  const sub = join(repo, "nested");
  const bin = join(dir, "bin");
  await mkdir(sub, { recursive: true });
  await mkdir(bin);
  await exec("git", ["init", repo]);
  await writeFile(join(bin, "package.json"), ' {"type":"module"}');
  await writeFile(
    join(bin, "gh"),
    `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.FIXTURE_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),override:process.env.GH_REPO}));
console.log(JSON.stringify({url:process.env.FIXTURE_URL}));
`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + ":" + process.env.PATH;
  process.env.FIXTURE_LOG = join(dir, "call.json");
  process.env.FIXTURE_URL = "https://github.com/owner/repo";
  process.env.GH_REPO = "unrelated/repository";
  process.chdir(sub);
  assert.deepEqual(await resolvePR("12"), {
    host: "github.com",
    owner: "owner",
    repo: "repo",
    number: 12,
    url: "https://github.com/owner/repo/pull/12",
  });
  assert.deepEqual(JSON.parse(await readFile(process.env.FIXTURE_LOG, "utf8")), {
    args: ["repo", "view", "--json", "url"],
    cwd: await realpath(repo),
  });
  assert.equal(process.env.GH_REPO, "unrelated/repository");
  process.chdir(dir);
  process.env.FIXTURE_URL = "https://git.example.com/team/project";
  assert.equal((await resolvePR("42", sub)).url, "https://git.example.com/team/project/pull/42");
  await assert.rejects(() => resolvePR("42"), /local checkout/);
});

test("full URLs need no local checkout or gh lookup", async () => {
  assert.equal(
    (await resolvePR("https://github.com/owner/repo/pull/123", "/nonexistent/prsit-checkout"))
      .number,
    123,
  );
});

test("invalid numeric targets fail before repository discovery", async () => {
  for (const value of ["0", "-1", "1.2", "9007199254740992", "abc", ""])
    await assert.rejects(
      () => resolvePR(value, "/nonexistent/prsit-checkout"),
      /positive PR number/,
    );
});
