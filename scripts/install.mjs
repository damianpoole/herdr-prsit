#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { access, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { integrateLayout } from "./layout.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    home: { type: "string" },
    layout: { type: "string" },
    from: { type: "string" },
    "state-home": { type: "string" },
    "skip-check": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node scripts/install.mjs [--home PATH] [--layout PERSONAL_NAME [--from main]] [--state-home PATH]\nInstalls the native mod. Optionally adds it to a personal layout, without switching the running window. --skip-check is for isolated fixture tests only.",
  );
  process.exit(0);
}
const appHome = resolve(
  values.home ?? process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app"),
);
const destination = join(appHome, "mods/prsit");
const backend = join(root, "dist/cli.js");
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const validName = (name) => typeof name === "string" && /^[a-zA-Z0-9_-]+$/.test(name);
try {
  await access(backend);
  if (values.from && !values.layout) throw new Error("--from requires --layout");
  let target, original, updated;
  if (values.layout) {
    if (!validName(values.layout) || ["main", "terminals", "win98"].includes(values.layout))
      throw new Error("Choose a personal layout name, not a shipped layout");
    target = join(appHome, "layouts", `${values.layout}.json`);
    if (values.from) {
      if (!validName(values.from)) throw new Error("Invalid source layout name");
      if (await exists(target))
        throw new Error("Target layout already exists; omit --from to update it");
      original = await readFile(join(appHome, "layouts", `${values.from}.json`), "utf8");
    } else original = await readFile(target, "utf8");
    updated = JSON.stringify(integrateLayout(JSON.parse(original)), null, 2) + "\n";
  }
  const receipt = join(destination, ".prsit-install.json");
  if (await exists(destination)) {
    let owner;
    try {
      owner = JSON.parse(await readFile(receipt, "utf8"));
    } catch {}
    if (owner?.package !== "herdr-prsit")
      throw new Error(`Refusing to overwrite unmanaged mod: ${destination}`);
  }
  await mkdir(destination, { recursive: true });
  const config = { command: process.execPath, args: [backend] };
  if (values["state-home"] ?? process.env.PRSIT_HOME)
    config.stateHome = resolve(values["state-home"] ?? process.env.PRSIT_HOME);
  for (const file of ["main.js", "client.js", "mod.json"])
    await copyFile(join(root, "mods/prsit", file), join(destination, file));
  await writeFile(
    join(destination, "config.js"),
    `// Machine-local installer configuration; do not commit.\nexport default ${JSON.stringify(config, null, 2)};\n`,
  );
  await writeFile(
    receipt,
    JSON.stringify({ package: "herdr-prsit", source: root, version: 1 }) + "\n",
  );
  if (!values["skip-check"]) {
    const checked = spawnSync("herdr-app", ["check", destination], { stdio: "inherit" });
    if (checked.error || checked.status !== 0)
      throw new Error(
        "Mod check failed; layout was not changed. Fix the reported error and rerun installation.",
      );
  }
  if (target) {
    await mkdir(dirname(target), { recursive: true });
    if (!values.from) {
      try {
        await copyFile(target, `${target}.before-prsit`, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      // Refuse to overwrite edits made while the mod was being installed.
      if ((await readFile(target, "utf8")) !== original)
        throw new Error("Layout changed during installation; rerun to preserve those changes");
    }
    await writeFile(target, updated, values.from ? { flag: "wx" } : undefined);
  }
  console.log(`Installed ${destination}\nBackend: ${backend}`);
  if (target)
    console.log(
      `Layout: ${target}\nTo show it: herdr-app do layout.switch --name ${values.layout}`,
    );
  else console.log("No layout changed. Add the documented blocks or open a prsit mod tab.");
  console.log("No controller was started and no PRs were registered.");
} catch (error) {
  console.error(`install: ${error.message}`);
  process.exitCode = 1;
}
