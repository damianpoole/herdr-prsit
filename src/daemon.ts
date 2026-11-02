import { join } from "node:path";
import { unlink, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { home, watches, optional, atomic, watchDir, log } from "./io.js";
import { models, closeModels } from "./agent.js";
import { openRuntime, type Control } from "./runtime.js";
import { acquire, socketPath } from "./controller.js";

// Native views observe state independently. Running the controller never opens
// tabs, changes focus, or depends on a particular app window/session.
export async function daemon() {
  await mkdir(home(), { recursive: true, mode: 0o700 });
  const lock = await acquire();
  const active = new Map<string, Awaited<ReturnType<typeof openRuntime>>>();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const m = await models();
    console.log(
      `herdr-prsit running. State: ${home()}\nRegister PRs from another pane with prsit watch <url>. Ctrl+C saves progress.`,
    );
    while (!stopped) {
      for (const w of await watches()) {
        const control = await optional<Control>(join(watchDir(w), "control.json"));
        if (control && control.mode !== "running") {
          if (active.has(w.id)) {
            await active.get(w.id)!.close();
            active.delete(w.id);
            await log(w, control.mode);
          }
          continue;
        }
        if (active.has(w.id)) continue;
        try {
          active.set(w.id, await openRuntime(w, m));
        } catch (e) {
          await log(w, `Could not open runtime: ${String(e)}`);
          await atomic(join(watchDir(w), "control.json"), { mode: "paused" });
        }
      }
      await delay(1000);
    }
  } finally {
    stopped = true;
    await Promise.allSettled([...active.values()].map((r) => r.close()));
    await closeModels();
    await new Promise<void>((resolve) => lock.close(() => resolve()));
    await unlink(socketPath()).catch(() => {});
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
