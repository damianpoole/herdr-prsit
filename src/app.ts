import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { exec, hash, home } from "./io.js";
import { ping } from "./controller.js";
import type { Watch } from "./types.js";

export async function openView(watch: Watch) {
  const result = await exec("herdr-app", [
    "do",
    "tab.new",
    JSON.stringify({
      name: `PR #${watch.number} ${watch.owner}/${watch.repo}`,
      mod: "prsit",
      props: {
        role: "panel",
        watch: watch.id,
        stateHome: home(),
        command: process.execPath,
        args: [fileURLToPath(new URL("./cli.js", import.meta.url))],
      },
    }),
  ]);
  return result.stdout.trim();
}

// hc owns this process, never the window/mod that requested it. The stable name
// closes the launch race between clients; the controller socket remains the
// authority across different hc sessions and standalone CLI launches.
export async function startController(deps = { exec, ping, delay }) {
  if (await deps.ping()) return { running: true, started: false };
  let launchError: unknown;
  try {
    await deps.exec(
      "hc",
      [
        "run",
        "--bg",
        "--no-parent",
        "--no-notify",
        "--name",
        `prsit-${hash(home()).slice(0, 16)}`,
        "--",
        "env",
        `PRSIT_HOME=${home()}`,
        process.execPath,
        fileURLToPath(new URL("./cli.js", import.meta.url)),
        "run",
        "--headless",
      ],
      { timeout: 15_000 },
    );
  } catch (error) {
    // Another client may have won the name/ownership race. Never launch again
    // blindly: wait for the controller, then report the original failure.
    launchError = error;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await deps.ping()) return { running: true, started: !launchError };
    await deps.delay(250);
  }
  if (launchError) throw launchError;
  throw new Error(
    "Controller did not become ready. Inspect its prsit-* hc terminal before retrying.",
  );
}
