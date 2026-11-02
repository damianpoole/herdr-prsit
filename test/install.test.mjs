import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { integrateLayout } from "../scripts/layout.mjs";

const layout = () => ({
  id: "root",
  type: "column",
  children: [
    { id: "tabs", type: "block", content: { mod: "tabs" } },
    { id: "ship-it", type: "block", size: { px: 40 }, content: { mod: "ship-it" } },
    {
      id: "panel",
      type: "column",
      children: [
        {
          id: "panel-body",
          type: "stack",
          active: "ship-it-review",
          children: [
            { id: "ship-it-review", type: "block", content: { mod: "ship-it-review" } },
            { id: "personal", type: "block", content: { mod: "personal" } },
          ],
        },
      ],
    },
  ],
});

test("installation sits beside Ship-it and preserves its active side panel", () => {
  const before = layout(),
    after = integrateLayout(before);
  assert.deepEqual(before, layout(), "input must not be mutated");
  assert.deepEqual(integrateLayout(after), after, "repeat install must be idempotent");
  const toolbar = after.children[1];
  assert.equal(toolbar.id, "prsit-toolbar");
  assert.equal(toolbar.size.px, 40);
  assert.equal(toolbar.children[0].content.mod, "ship-it");
  assert.equal(toolbar.children[1].content.mod, "prsit");
  const stack = after.children[2].children[0];
  assert.equal(stack.active, "ship-it-review");
  assert.deepEqual(stack.children.slice(0, 2), before.children[2].children[0].children);
  assert.equal(stack.children.at(-1).id, "prsit-panel");
});

test("standalone layouts work without Ship-it; collisions fail rather than overwrite", () => {
  const tree = layout();
  tree.children.splice(1, 1);
  assert.equal(integrateLayout(tree).children[1].id, "prsit-strip");
  assert.throws(() => integrateLayout({ id: "root" }), /No Ship-it strip/);
  tree.children.push({ id: "prsit-panel", content: { mod: "unrelated" } });
  assert.throws(() => integrateLayout(tree), /belongs to another/);
});

test("clean isolated installation, repeat update, backup and unmanaged collision", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prsit install ' "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "layouts"));
  const initial = JSON.stringify(layout());
  await writeFile(join(dir, "layouts/main.json"), initial);
  const install = (...args) =>
    execFileSync(
      process.execPath,
      ["scripts/install.mjs", "--home", dir, "--skip-check", ...args],
      { encoding: "utf8" },
    );
  assert.match(install("--layout", "my-main", "--from", "main"), /No controller was started/);
  assert.equal(await readFile(join(dir, "layouts/main.json"), "utf8"), initial);
  const personal = await readFile(join(dir, "layouts/my-main.json"), "utf8");
  install("--layout", "my-main");
  assert.equal(await readFile(join(dir, "layouts/my-main.json"), "utf8"), personal);
  assert.equal(await readFile(join(dir, "layouts/my-main.json.before-prsit"), "utf8"), personal);
  const config = await readFile(join(dir, "mods/prsit/config.js"), "utf8");
  assert.match(config, /dist\/cli\.js/);
  assert.throws(() => install("--layout", "main"), /personal layout/);
  await rm(join(dir, "mods/prsit/.prsit-install.json"));
  assert.throws(() => install(), /unmanaged mod/);
});
