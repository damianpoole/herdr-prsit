import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modSnapshot } from "../dist/mod-api.js";
import { atomic, watchDir } from "../dist/io.js";
import { controlWatch } from "../dist/presentation.js";
import { acquire } from "../dist/controller.js";

test("native snapshot is versioned, bounded, and uses real controller health", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prsit-mod-"));
  const previous = process.env.PRSIT_HOME;
  process.env.PRSIT_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PRSIT_HOME;
    else process.env.PRSIT_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const w = {
    id: "fixture",
    url: "https://github.com/owner/repo/pull/1",
    number: 1,
    owner: "owner",
    repo: "repo",
    path: "/fixture/repo",
    agent: "pi",
    model: "fixture/local",
    created: 1,
  };
  await atomic(join(dir, "watches", `${w.id}.json`), w);
  await atomic(join(watchDir(w), "status.json"), {
    status: "repairing",
    message: "Fixing\x1b[2J feedback",
    job: { worktree: "/fixture/repair", items: [{ kind: "thread" }] },
  });
  await writeFile(join(watchDir(w), "durable.sqlite"), "do not read or change");
  await writeFile(join(watchDir(w), "events.log"), "old\n".repeat(20000) + "last\x1b[2J\n");
  const stopped = await modSnapshot(w.id);
  assert.equal(stopped.version, 1);
  assert.equal(stopped.home, dir);
  assert.equal(stopped.controllerRunning, false);
  assert.equal(stopped.watches[0].stage, "controller stopped");
  assert.equal(stopped.watches[0].message, "Fixing feedback");
  assert.equal(stopped.watches[0].worktree, "/fixture/repair");
  assert.equal(stopped.activity.length, 1000);
  assert.equal(stopped.activity.at(-1), "last");
  assert.deepEqual((await modSnapshot()).activity, []);
  await assert.rejects(modSnapshot("missing"), /Watch not found/);
  const server = await acquire();
  try {
    await assert.rejects(acquire(), /already running/);
    const live = await modSnapshot();
    assert.equal(live.controllerRunning, true);
    assert.equal(live.watches[0].stage, "handling comments");
    assert.equal(live.watches[0].semantic, "working");
    await controlWatch(w, "pause");
    assert.equal((await modSnapshot()).watches[0].stage, "paused");
    await controlWatch(w, "unwatch");
    assert.equal((await modSnapshot()).watches[0].stage, "unwatched");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(
    await readFile(join(watchDir(w), "durable.sqlite"), "utf8"),
    "do not read or change",
  );
});
