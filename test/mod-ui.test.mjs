import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { setImmediate } from "node:timers/promises";
import { host, context, find } from "./mod-host.mjs";
register(new URL("./mod-loader.mjs", import.meta.url));
const { default: Mod } = await import("../mods/prsit/main.js");
const snapshot = {
  version: 1,
  controllerRunning: false,
  watches: [
    {
      id: "one",
      number: 1,
      repository: "owner/repo",
      mode: "running",
      stage: "controller stopped",
      semantic: "unknown",
      agent: "pi",
      model: "fixture/local",
    },
    {
      id: "two",
      number: 2,
      repository: "owner/repo",
      mode: "removed",
      stage: "unwatched",
      semantic: "idle",
    },
  ],
  activity: ["fixture activity"],
};

function setup() {
  host.props = {};
  host.calls = [];
  host.timers = [];
  host.error = undefined;
  host.layout = {};
  host.exec = async () => ({ code: 0, stdout: JSON.stringify(snapshot), stderr: "" });
  const cx = context(),
    mod = new Mod();
  mod.init({}, cx);
  return { mod, cx };
}

test("native mod renders stopped health, selection, history and pinned controls", async () => {
  const { mod, cx } = setup();
  await setImmediate();
  assert.equal(mod.snapshot.controllerRunning, false);
  let tree = mod.render();
  assert.ok(find(tree, "prsit-one"));
  assert.equal(find(tree, "prsit-two"), null);
  find(tree, "prsit-one").attributes.on_click[0]({}, cx);
  await setImmediate();
  tree = mod.render();
  const pause = find(tree, "action-pause");
  assert.ok(pause);
  const calls = [];
  host.exec = async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(snapshot), stderr: "" };
  };
  mod.selected = "two"; // a stale row's explicit control still targets its own watch
  pause.attributes.on_click[0]({}, cx);
  await setImmediate();
  assert.deepEqual(calls[0], ["pause", "one"]);
  find(tree, "prsit-history").attributes.on_click[0]({}, cx);
  assert.ok(find(mod.render(), "prsit-two"));
  assert.equal(host.error, undefined);
});

test("failed controls stay visible after successful polls; registration uses explicit input", async () => {
  const { mod, cx } = setup();
  await setImmediate();
  host.exec = async () => ({ code: 1, stderr: "backend refused retry", stdout: "" });
  mod.action(["retry", "one"], cx);
  await setImmediate();
  assert.match(mod.actionError, /backend refused/);
  host.exec = async () => ({ code: 0, stdout: JSON.stringify(snapshot), stderr: "" });
  mod.refresh(cx);
  await setImmediate();
  assert.match(mod.actionError, /backend refused/);
  mod.submit(cx);
  assert.match(mod.actionError, /Supply/);
  mod.inputs.pr.set_value("123");
  mod.inputs.repo.set_value("/fixture/repo");
  const calls = [];
  host.exec = async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(snapshot), stderr: "" };
  };
  mod.form = true;
  mod.submit(cx);
  await setImmediate();
  assert.deepEqual(calls[0], ["watch", "123", "--repo", "/fixture/repo"]);
  assert.equal(mod.form, false);
  assert.equal(mod.actionError, "");
});

test("Ship-it-compatible panel navigation neither creates terminals nor changes Ship-it", async () => {
  const { mod } = setup();
  await setImmediate();
  host.layout = {
    id: "panel",
    children: [{ id: "panel-body", children: [{ id: "prsit-panel" }] }],
  };
  mod.openPanel();
  assert.deepEqual(host.calls, [
    ["layout.select", { stack: "panel-body", child: "prsit-panel" }],
    ["layout.show", { id: "panel" }],
  ]);
  host.calls = [];
  host.layout = {};
  mod.openPanel();
  assert.equal(host.calls[0][0], "tab.new");
  assert.equal(host.calls[0][1].mod, "prsit");
  assert.equal(host.calls[0][1].argv, undefined);
  assert.equal(mod.close, undefined, "closing a view must not shut down controller ownership");
});
