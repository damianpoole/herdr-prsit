import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// A clean build must not ship removed herdr-tui entrypoints in dist/.
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url))],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
