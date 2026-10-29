import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openView, requireHerdr } from "../dist/herdr.js";
test("Herdr uses returned pane IDs, explicit cwd, no focus and quoted paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prsit herdr "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  t.after(() => {
    process.env = env;
  });
  process.env.PRSIT_HOME = join(dir, "state");
  process.env.HERDR_ENV = "1";
  process.env.PATH = dir + ":" + process.env.PATH;
  process.env.FIXTURE_LOG = join(dir, "calls");
  await writeFile(
    join(dir, "herdr"),
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(a)+'\\n');console.log(JSON.stringify({result:{root_pane:{pane_id:'opaque:p27'},workspace:{workspace_id:'opaque'}}}));`,
    { mode: 0o755 },
  );
  const pane = await openView({ id: "fixture", number: 42, path: dir });
  assert.equal(pane, "opaque:p27");
  const calls = (await readFile(process.env.FIXTURE_LOG, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(calls[0], [
    "workspace",
    "create",
    "--cwd",
    dir,
    "--label",
    "prsit #42",
    "--no-focus",
  ]);
  assert.equal(calls[1][2], "opaque:p27");
  assert.ok(calls[1][3].includes("logs 'fixture' --follow"));
  delete process.env.HERDR_ENV;
  assert.throws(requireHerdr, /inside a Herdr pane/);
});
