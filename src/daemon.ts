import { join } from "node:path";
import { unlink, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { home, watches, optional, atomic, watchDir, log } from "./io.js";
import { models, closeModels } from "./agent.js";
import { openRuntime, type Control } from "./runtime.js";
import { openView, currentWorkspace } from "./herdr.js";
import { acquire, socketPath } from "./controller.js";

// UI failure must never stall pause/resume checks or durable agent execution.
async function maintainViews(workspace: string, stopped: () => boolean) {
  const opened = new Set<string>();
  const retry = new Map<string, number>();
  while (!stopped()) {
    try {
      for (const w of await watches()) {
        if (stopped()) break;
        if (opened.has(w.id) || Date.now() < (retry.get(w.id) ?? 0)) continue;
        try {
          const control = await optional<Control>(join(watchDir(w), "control.json"));
          if (control?.mode === "removed") continue;
          await openView(w, workspace, false);
          opened.add(w.id);
        } catch (e) {
          retry.set(w.id, Date.now() + 30_000);
          await log(w, `Could not open PR sidebar entry: ${String(e)}. Use prsit open ${w.id}.`);
        }
      }
    } catch (e) {
      console.error(`Herdr view refresh: ${String(e)}`);
    }
    await delay(1000);
  }
}

export async function daemon(headless = false) {
  const workspace = headless ? undefined : currentWorkspace();
  await mkdir(home(), { recursive: true, mode: 0o700 });
  const lock = await acquire(workspace);
  let views: Promise<void> | undefined;
  const active = new Map<string, Awaited<ReturnType<typeof openRuntime>>>();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const m = await models();
    if (workspace) views = maintainViews(workspace, () => stopped);
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
    await views;
    await Promise.allSettled([...active.values()].map((r) => r.close()));
    await closeModels();
    await new Promise<void>((resolve) => lock.close(() => resolve()));
    await unlink(socketPath()).catch(() => {});
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
