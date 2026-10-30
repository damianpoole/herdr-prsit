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

test("Ink layouts keep controls and Unicode inside wide, narrow and tiny viewports", async () => {
  const { stripVTControlCharacters } = await import("node:util");
  const { default: stringWidth } = await import("string-width");
  const entries = Array.from({ length: 25 }, (_, i) => ({
    watch: {
      id: String(i),
      number: i,
      owner: "团队",
      repo: "工具👩‍💻",
      url: "https://github.com/example/repo/pull/1",
    },
    state: {
      status: "blocked",
      message: "Validation failed. Inspect the worktree, then retry.\x1b]52;c;secret\x07",
    },
  }));
  const state = {
    entries,
    selected: "24",
    running: true,
    logs: Array.from({ length: 50 }, (_, i) => `event ${i}`),
    message: "",
  };
  for (const [columns, rows] of [
    [120, 32],
    [80, 24],
    [50, 20],
    [30, 10],
    [1, 1],
  ]) {
    const output = stripVTControlCharacters(renderDashboard(state, columns, rows));
    const lines = output.split("\r\n");
    assert.ok(lines.length <= rows, `${columns}x${rows}: height`);
    assert.ok(
      lines.every((line) => stringWidth(line) <= columns),
      `${columns}x${rows}: width`,
    );
    assert.doesNotMatch(output, /secret/);
    if (columns >= 50) {
      assert.match(output, /#24 团队\/工具👩‍💻/);
      assert.match(output, /q quit/);
    }
  }
  const live = stripVTControlCharacters(renderDashboard(state, 120, 32));
  assert.match(live, /event 49/);
  const history = stripVTControlCharacters(renderDashboard({ ...state, logOffset: 10 }, 120, 32));
  assert.match(history, /10 lines back/);
  assert.match(history, /event 39/);
  assert.doesNotMatch(history, /event 49/);
  const stopped = stripVTControlCharacters(renderDashboard({ ...state, running: false }, 120, 32));
  assert.match(stopped, /Controller STOPPED/);
  assert.match(stopped, /Controls queue/);
  assert.match(
    stripVTControlCharacters(renderDashboard({ ...state, entries: [] }, 80, 24)),
    /prsit watch 123/,
  );
});

test("keyboard controls pin their target and selection resets activity scrolling", async (t) => {
  const { dashboard } = await import("../dist/dashboard.js");
  const { dashboardTerminal } = await import("../dist/dashboard-ui.js");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = await mkdtemp(join(tmpdir(), "prsit-ink-controls-"));
  const env = { ...process.env };
  process.env.PRSIT_HOME = dir;
  delete process.env.HERDR_PLUGIN_ENTRYPOINT_ID;
  t.after(async () => {
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "watches"));
  for (const [i, id] of ["one", "two"].entries()) {
    const watch = {
      id,
      number: i + 1,
      owner: "fixture",
      repo: "local",
      url: `https://github.com/fixture/local/pull/${i + 1}`,
      created: i,
    };
    await writeFile(join(dir, "watches", `${id}.json`), JSON.stringify(watch));
    await mkdir(join(dir, id));
    await writeFile(
      join(dir, id, "events.log"),
      Array.from({ length: 1000 }, (_, n) => `${id} event ${n}`).join("\n"),
    );
  }
  for (const [object, key, value] of [
    [process.stdin, "isTTY", true],
    [process.stdout, "isTTY", true],
    [process.stdout, "columns", 120],
    [process.stdout, "rows", 32],
    [process.stdin, "setRawMode", () => {}],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete object[key];
    });
  }
  t.mock.method(process.stdin, "pause", () => process.stdin);
  let state,
    keypress,
    closed = false;
  t.mock.method(dashboardTerminal, "mount", (snapshot, onKey) => {
    state = snapshot;
    keypress = onKey;
    return {
      update() {},
      async close() {
        closed = true;
      },
    };
  });
  const running = dashboard();
  const until = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await delay(20);
    }
    assert.fail("dashboard did not reach expected state");
  };
  try {
    await until(() => state?.logs.length === 1000);
    keypress("", { pageUp: true });
    assert.equal(state.logOffset, 5);
    // Paging beyond the oldest retained row must not accumulate an invisible offset.
    for (let i = 0; i < 210; i++) keypress("", { pageUp: true });
    assert.equal(state.logOffset, 985); // 1,000 retained lines minus 15 visible rows.
    keypress("", { pageDown: true });
    assert.equal(state.logOffset, 980);
    assert.match(renderDashboard(state, 120, 32), /one event 5/);
    keypress("", { pageUp: true });
    // Rollover retains 1,000 lines, even while anchoring to older activity.
    await writeFile(
      join(dir, "one", "events.log"),
      Array.from({ length: 1010 }, (_, n) => `one event ${n}`).join("\n"),
    );
    await until(() => state.logs.at(-1) === "one event 1009");
    assert.equal(state.logOffset, 985);
    keypress("", { pageDown: true });
    assert.equal(state.logOffset, 980);
    assert.match(renderDashboard(state, 120, 32), /one event 15/);
    // Enlarging the pane reduces the scrollable range immediately.
    process.stdout.rows = 42;
    process.stdout.emit("resize");
    assert.equal(state.logOffset, 975);
    keypress("", { pageDown: true });
    assert.equal(state.logOffset, 970);
    assert.match(renderDashboard(state, 120, 42), /one event 15/);
    keypress("p", {});
    keypress("j", {});
    assert.equal(state.selected, "two");
    assert.equal(state.logOffset, 0);
    assert.deepEqual(state.logs, []);
    await until(async () => (await watchSnapshot({ id: "one" })).control?.mode === "paused");
    assert.equal((await watchSnapshot({ id: "two" })).control, undefined);
    await until(() => state.logs[0]?.startsWith("two"));
    keypress("", { pageUp: true });
    assert.equal(state.logOffset, 5);
    keypress("", { end: true });
    assert.equal(state.logOffset, 0);
    keypress("t", {});
    await until(async () => !!(await watchSnapshot({ id: "two" })).control?.retryAt);
    keypress("r", {});
    await until(async () => {
      const control = (await watchSnapshot({ id: "two" })).control;
      return control?.mode === "running" && !control.retryAt;
    });
  } finally {
    keypress("q", {});
    await running;
  }
  assert.ok(closed);
});
