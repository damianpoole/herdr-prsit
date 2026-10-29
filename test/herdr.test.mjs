import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openView,
  openPluginView,
  requireHerdr,
  currentWorkspace,
  SidebarReporter,
  markView,
} from "../dist/herdr.js";
import { exec } from "../dist/io.js";
import { setTimeout as delay } from "node:timers/promises";
import { activityLabel, presentation } from "../dist/presentation.js";
import { pluginAction } from "../dist/plugin.js";
import { acquire, controllerInfo, socketPath, viewWorkspace } from "../dist/controller.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "prsit herdr "));
  const env = { ...process.env };
  t.after(async () => {
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.PRSIT_HOME = join(dir, "state with ' quotes");
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "caller-workspace";
  process.env.HERDR_BIN_PATH = join(dir, "herdr-fixture");
  process.env.FIXTURE_LOG = join(dir, "calls");
  process.env.FIXTURE_STATE = join(dir, "panes.json");
  await writeFile(process.env.FIXTURE_STATE, JSON.stringify({ panes: [] }));
  await writeFile(
    process.env.HERDR_BIN_PATH,
    `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];
appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(a)+'\\n');
if(process.env.FIXTURE_FAIL && a.includes(process.env.FIXTURE_FAIL)) {process.stderr.write('fixture unavailable');process.exit(1);}
const state=JSON.parse(readFileSync(process.env.FIXTURE_STATE,'utf8'));let result={type:'ok'};
if(a[0]==='pane'&&a[1]==='list') {
 result={panes:state.panes};
 if(process.env.FIXTURE_LIST_BARRIER) {
  writeFileSync(process.env.FIXTURE_LIST_BARRIER+'.ready','');
  while(!((await import('node:fs')).existsSync(process.env.FIXTURE_LIST_BARRIER)))
   await new Promise(resolve=>setTimeout(resolve,10));
 }
}
if(a[0]==='pane'&&a[1]==='get')result={pane:state.panes.find(p=>p.pane_id===a[2])};
if(a[0]==='plugin'&&a[1]==='pane'&&a[2]==='open') {
  const pane={pane_id:'opaque:p'+(state.panes.length+1),terminal_id:'terminal-'+(state.panes.length+1),tab_id:'opaque:t'+(state.panes.length+1),workspace_id:get('--workspace'),tokens:{}};
  state.panes.push(pane);result={plugin_pane:{plugin_id:get('--plugin'),entrypoint:get('--entrypoint'),pane}};
}
if(a[0]==='pane'&&a[1]==='report-metadata') {
 const pane=state.panes.find(p=>p.pane_id===a[2]);
 if(pane)for(let i=3;i<a.length;i++) {
  if(a[i]==='--token'){const [k,...v]=a[++i].split('=');pane.tokens[k]=v.join('=');}
  else if(a[i]==='--clear-token')delete pane.tokens[a[++i]];
 }
}
writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));
if (!(process.env.FIXTURE_EMPTY_CREATE && a[2]==='open') && !['report-metadata','report-agent','release-agent'].includes(a[1])) console.log(JSON.stringify({result}));
`,
    { mode: 0o755 },
  );
  return {
    dir,
    w: { id: "fixture", owner: "owner", repo: "repo", number: 42, path: dir },
    calls: async () =>
      (await readFile(process.env.FIXTURE_LOG, "utf8")).trim().split("\n").map(JSON.parse),
  };
}

test("opens a plugin-owned PR pane without focus and reuses it across calling workspaces", async (t) => {
  const { w, calls } = await fixture(t);
  const pane = await openView(w, "controller-workspace", false);
  assert.equal(pane, "opaque:p1");
  const create = (await calls()).find((a) => a[0] === "plugin" && a[2] === "open");
  assert.deepEqual(create, [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "herdr-prsit",
    "--entrypoint",
    "watch",
    "--placement",
    "tab",
    "--workspace",
    "controller-workspace",
    "--cwd",
    w.path,
    "--env",
    `PRSIT_HOME=${process.env.PRSIT_HOME}`,
    "--env",
    "PRSIT_WATCH_ID=fixture",
    "--no-focus",
  ]);
  assert.equal(await openView(w, "other-workspace"), pane);
  assert.equal((await calls()).filter((a) => a[0] === "plugin" && a[2] === "open").length, 1);
  assert.deepEqual((await calls()).at(-1), ["plugin", "pane", "focus", pane]);
  assert.ok(
    !(await calls()).some(
      (a) => a[0] === "workspace" || (a[0] === "tab" && a[1] !== "rename") || a[1] === "run",
    ),
  );
  assert.ok(
    (await calls()).some(
      (a) =>
        JSON.stringify(a) ===
        JSON.stringify(["tab", "rename", "opaque:t1", "PR #42 owner/repo — watching"]),
    ),
  );
  process.env.PRSIT_HOME += "different";
  assert.notEqual(await openView(w, "controller-workspace", false), pane);
  assert.equal(currentWorkspace(), "caller-workspace");
  delete process.env.HERDR_WORKSPACE_ID;
  assert.throws(currentWorkspace, /HERDR_WORKSPACE_ID/);
  delete process.env.HERDR_ENV;
  assert.throws(requireHerdr, /Herdr pane/);
});

test("sidebar reports semantic state, visible stage and both seen/unseen completion labels", async (t) => {
  const { w, calls } = await fixture(t);
  const pane = await openView(w, "controller-workspace", false);
  const reporter = new SidebarReporter(pane, w);
  const snapshot = {
    watch: w,
    state: {
      status: "repairing",
      message: "Agent repairing PR",
      job: { items: [{ kind: "thread" }] },
    },
  };
  await reporter.update(snapshot, true, 100);
  let records = await calls();
  const status = records.find((a) => a[1] === "report-agent");
  assert.equal(status[status.indexOf("--state") + 1], "working");
  const display = records.find((a) => a.includes("--display-agent"));
  assert.equal(
    display[display.indexOf("--display-agent") + 1],
    "PR #42 owner/repo — handling comments",
  );
  assert.deepEqual(records.filter((a) => a[0] === "tab" && a[1] === "rename").at(-1), [
    "tab",
    "rename",
    "opaque:t1",
    "PR #42 owner/repo — handling comments",
  ]);
  const before = records.length;
  await reporter.update(snapshot, true, 101);
  assert.equal((await calls()).length, before);
  await reporter.update(snapshot, false, 102);
  records = await calls();
  assert.equal(
    records
      .filter((a) => a[1] === "report-agent")
      .at(-1)
      .includes("unknown"),
    true,
  );
  snapshot.state = {
    status: "waiting",
    message: "Waiting for Codex review",
    codexReviewRequest: { phase: "requested" },
  };
  await reporter.update(snapshot, true, 102.5);
  assert.match((await calls()).filter((a) => a[0] === "tab").at(-1)[3], /review requested$/);
  snapshot.state = { status: "merged", message: "Merged on GitHub" };
  await reporter.update(snapshot, false, 103);
  const merged = (await calls()).filter((a) => a.includes("--display-agent")).at(-1);
  assert.match((await calls()).filter((a) => a[0] === "tab").at(-1)[3], /merged$/);
  assert.ok(merged.includes("idle=merged"));
  assert.ok(merged.includes("done=merged"));
  const count = (await calls()).length;
  await reporter.update(snapshot, false, 10_104);
  assert.ok((await calls()).length > count);
  const renamed = (await calls()).filter((a) => a[0] === "tab").length;
  await reporter.update(snapshot, false, 20_105);
  assert.equal((await calls()).filter((a) => a[0] === "tab").length, renamed);
  const live = JSON.parse(await readFile(process.env.FIXTURE_STATE, "utf8"));
  live.panes[0].tab_id = "moved:tab";
  await writeFile(process.env.FIXTURE_STATE, JSON.stringify(live));
  await reporter.update(snapshot, false, 30_106);
  assert.deepEqual((await calls()).filter((a) => a[0] === "tab").at(-1), [
    "tab",
    "rename",
    "moved:tab",
    "PR #42 owner/repo — merged",
  ]);
  await reporter.release();
  assert.ok((await calls()).some((a) => a[1] === "release-agent"));
  // A released view is no longer reused.
  assert.notEqual(await openView(w, "controller-workspace", false), pane);
});

test("failed status reports retry rather than caching success", async (t) => {
  const { w, calls } = await fixture(t);
  const pane = await openView(w, "main", false);
  const reporter = new SidebarReporter(pane, w);
  process.env.FIXTURE_FAIL = "report-metadata";
  await assert.rejects(reporter.update({ watch: w }, true, 1), /fixture unavailable/);
  delete process.env.FIXTURE_FAIL;
  await reporter.update({ watch: w }, true, 2);
  assert.equal((await calls()).filter((a) => a[1] === "report-agent").length, 1);
});

test("presentation reflects actual repair stages and never equates agent completion with merge", () => {
  const label = (status, message = "", extra = {}) => activityLabel({ status, message, ...extra });
  assert.equal(activityLabel(), "watching");
  assert.equal(label("preparing"), "preparing repair");
  assert.equal(label("repairing", "", { job: { items: [{ kind: "ci" }] } }), "fixing checks");
  assert.equal(
    label("repairing", "", { job: { items: [{ kind: "conflict" }] } }),
    "resolving conflicts",
  );
  assert.equal(label("publishing"), "publishing fixes");
  assert.equal(
    label("waiting", "Waiting to observe a fresh Codex review", {
      codexReviewRequest: { phase: "requested" },
    }),
    "review requested",
  );
  assert.equal(label("waiting", "Codex review is in progress"), "review in progress");
  assert.equal(label("waiting", "Waiting for required review"), "waiting for review");
  assert.equal(label("waiting", "Waiting for passing checks"), "waiting for checks");
  assert.equal(label("waiting", "Merge submitted; waiting for GitHub/merge queue"), "merge queued");
  assert.equal(label("blocked", "Waiting for checks"), "blocked");
  assert.equal(
    presentation({ state: { status: "repairing" }, control: { mode: "paused" } }, true).semantic,
    "idle",
  );
  assert.equal(presentation({ state: { status: "repairing" } }, false).stage, "controller stopped");
  assert.equal(
    presentation({ state: { status: "merged" }, control: { mode: "paused" } }, false).stage,
    "merged",
  );
  assert.equal(activityLabel(undefined, { mode: "removed" }), "unwatched");
});

test("controller advertises its session and refuses to target workspace IDs in another session", async (t) => {
  await fixture(t);
  process.env.HERDR_SOCKET_PATH = "/fixture/original.sock";
  const server = await acquire("controller-workspace");
  const socket = socketPath();
  try {
    assert.deepEqual(await controllerInfo(), {
      pid: process.pid,
      workspace: "controller-workspace",
      session: "/fixture/original.sock",
    });
    assert.equal(await viewWorkspace(), "controller-workspace");
    process.env.HERDR_SOCKET_PATH = "/fixture/other.sock";
    await assert.rejects(viewWorkspace(), /another Herdr session/);
    await assert.rejects(acquire(), /already running/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socket, { force: true });
  }
  assert.equal(await viewWorkspace(), "caller-workspace");
});

test("plugin actions open in the intended workspace and never start a second controller", async (t) => {
  const { calls } = await fixture(t);
  await pluginAction("start");
  let launch = (await calls()).find((a) => a[2] === "open");
  assert.deepEqual((await calls()).at(-1), ["tab", "rename", "opaque:t1", "PR sitter"]);
  assert.ok(launch.includes("controller"));
  assert.equal(launch[launch.indexOf("--workspace") + 1], "caller-workspace");
  const server = await acquire("main-workspace");
  const socket = socketPath();
  try {
    await assert.rejects(pluginAction("start"), /already running/);
    await pluginAction("dashboard");
    launch = (await calls()).find((a) => a[2] === "open" && a.includes("dashboard"));
    assert.ok(launch.includes("dashboard"));
    assert.equal(launch[launch.indexOf("--workspace") + 1], "main-workspace");
    assert.ok(launch.includes(`PRSIT_HOME=${process.env.PRSIT_HOME}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socket, { force: true });
  }
});

test("reporting failure after successful creation never opens another tab, even after identity expires", async (t) => {
  const { w, calls } = await fixture(t);
  process.env.FIXTURE_FAIL = "report-metadata";
  await assert.rejects(openView(w, "main", false), /fixture unavailable/);
  await assert.rejects(openView(w, "main", false), /fixture unavailable/);
  delete process.env.FIXTURE_FAIL;
  assert.equal(await openView(w, "main", false), "opaque:p1");
  assert.equal((await calls()).filter((a) => a[2] === "open").length, 1);
});

test("ambiguous creation result blocks repeated opens and reconciles the view when it reports identity", async (t) => {
  const { w, calls } = await fixture(t);
  process.env.FIXTURE_EMPTY_CREATE = "1";
  await assert.rejects(openView(w, "main", false), /empty JSON/);
  delete process.env.FIXTURE_EMPTY_CREATE;
  await assert.rejects(openView(w, "main", false), /refusing to open a duplicate/);
  assert.equal((await calls()).filter((a) => a[2] === "open").length, 1);
  await markView(w, "opaque:p1");
  assert.equal(await openView(w, "main", false), "opaque:p1");
  assert.equal((await calls()).filter((a) => a[2] === "open").length, 1);
});

test("dashboard action focuses one existing dashboard instead of creating one per invocation", async (t) => {
  const { calls } = await fixture(t);
  for (let i = 0; i < 3; i++) await pluginAction("dashboard");
  assert.equal((await calls()).filter((a) => a[2] === "open").length, 1);
  assert.equal((await calls()).filter((a) => a[2] === "focus").length, 3);
  assert.ok(
    (await calls()).some(
      (a) => JSON.stringify(a) === JSON.stringify(["tab", "rename", "opaque:t1", "PR dashboard"]),
    ),
  );
});

for (const kind of ["watch", "dashboard"]) {
  test(`${kind} stale receipt replacement is locked across processes`, async (t) => {
    const { dir, w, calls } = await fixture(t);
    const watch = kind === "watch" ? w : undefined;
    await openPluginView(kind, "main", false, watch);
    // The old pane was closed without releasing its saved open receipt.
    await writeFile(process.env.FIXTURE_STATE, JSON.stringify({ panes: [] }));
    const barrier = join(dir, "list-barrier");
    process.env.FIXTURE_LIST_BARRIER = barrier;
    const opening = openPluginView(kind, "main", false, watch);
    try {
      for (let i = 0; ; i++) {
        try {
          await readFile(`${barrier}.ready`);
          break;
        } catch (e) {
          if (e.code !== "ENOENT" || i >= 500) throw e;
          await delay(10);
        }
      }
      // A separate CLI process must not read/delete the stale receipt while
      // the first caller is reconciling it, even before it writes "opening".
      const script = `
        import { openPluginView } from ${JSON.stringify(new URL("../dist/herdr.js", import.meta.url).href)};
        delete process.env.FIXTURE_LIST_BARRIER;
        try {
          await openPluginView(${JSON.stringify(kind)}, "main", false, ${JSON.stringify(watch) ?? "undefined"});
          process.exitCode = 1;
        } catch (e) {
          if (!/already being opened or released/.test(String(e))) throw e;
        }
      `;
      await exec(process.execPath, ["--input-type=module", "-e", script]);
    } finally {
      delete process.env.FIXTURE_LIST_BARRIER;
      await writeFile(barrier, "");
      await opening;
    }
    assert.equal((await calls()).filter((a) => a[2] === "open").length, 2);
    assert.equal(await openPluginView(kind, "main", false, watch), "opaque:p1");
    assert.equal((await calls()).filter((a) => a[2] === "open").length, 2);
    const files = await readdir(join(process.env.PRSIT_HOME, "herdr-views"));
    assert.ok(!files.some((name) => name.endsWith(".lock")));
  });
}
