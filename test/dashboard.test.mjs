import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboard, recentActivity } from "../dist/dashboard.js";
import { controlWatch, watchSnapshot } from "../dist/presentation.js";
import { watchDir } from "../dist/io.js";

test("dashboard bounds the viewport, keeps the selected PR visible, and strips terminal escapes", () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    watch: {
      id: String(i),
      number: i,
      owner: "owner",
      repo: "repo",
      url: `https://github.com/owner/repo/pull/${i}`,
    },
    state: { status: "waiting", message: "Waiting for passing checks" },
  }));
  const state = {
    entries,
    selected: "19",
    running: true,
    logs: ["safe", "\x1b[2Jbad\x1b]52;c;c2VjcmV0\x07"],
    message: "pause requested",
  };
  const text = renderDashboard(state, 80, 24);
  assert.match(text, /PR SITTER DASHBOARD/);
  assert.match(renderDashboard({ ...state, watchOnly: true }, 80, 24), /PR ACTIVITY/);
  assert.match(text, /> #19 owner\/repo/);
  assert.match(text, /waiting for checks/);
  assert.match(text, /pause requested/);
  assert.ok(!text.includes("\x1b"));
  assert.doesNotMatch(text, /c2VjcmV0/);
  for (const [cols, rows] of [
    [80, 24],
    [30, 10],
    [1, 1],
  ]) {
    const lines = renderDashboard(state, cols, rows).split("\r\n");
    assert.ok(lines.length <= rows);
    assert.ok(lines.every((line) => Array.from(line).length <= cols));
  }
});

test("dashboard controls preserve durable state and only write the existing control protocol", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prsit-dashboard-"));
  const env = { ...process.env };
  process.env.PRSIT_HOME = dir;
  t.after(async () => {
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  const w = { id: "one" };
  await mkdir(watchDir(w), { recursive: true });
  const durable = join(watchDir(w), "durable.sqlite");
  await writeFile(durable, "untouched");
  await controlWatch(w, "pause");
  assert.equal((await watchSnapshot(w)).control.mode, "paused");
  await controlWatch(w, "retry");
  const retry = (await watchSnapshot(w)).control;
  assert.equal(retry.mode, "running");
  assert.ok(retry.retryAt <= Date.now());
  await controlWatch(w, "resume");
  assert.deepEqual((await watchSnapshot(w)).control, { mode: "running" });
  await controlWatch(w, "unwatch");
  assert.equal((await watchSnapshot(w)).control.mode, "removed");
  assert.equal(await readFile(durable, "utf8"), "untouched");
  assert.deepEqual(await recentActivity(w), []);
  await writeFile(join(watchDir(w), "events.log"), "old\n".repeat(20_000) + "last\n");
  assert.deepEqual(await recentActivity(w, 2), ["old", "last"]);
});
