import { dashboardTerminal } from "./dashboard-ui.js";
export { renderDashboard } from "./dashboard-ui.js";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { watches, watchDir } from "./io.js";
import { ping, viewWorkspace } from "./controller.js";
import {
  openView,
  requireHerdr,
  SidebarReporter,
  markPluginView,
  releasePluginView,
} from "./herdr.js";
import {
  controlWatch,
  plain,
  watchSnapshot,
  type WatchSnapshot,
  type WatchAction,
} from "./presentation.js";
import type { Watch } from "./types.js";

export interface DashboardState {
  entries: WatchSnapshot[];
  selected?: string;
  running: boolean;
  logs: string[];
  message: string;
  watchOnly?: boolean;
  logOffset?: number;
}
export async function recentActivity(w: Watch, count = 12): Promise<string[]> {
  try {
    const file = await open(join(watchDir(w), "events.log"), "r");
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - 32_768);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start) lines.shift();
      return lines.filter(Boolean).slice(-count).map(plain);
    } finally {
      await file.close();
    }
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function dashboard(watch?: Watch) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The dashboard needs an interactive terminal. Use prsit status --json for scripts.",
    );
  const pane = process.env.HERDR_PANE_ID;
  if (watch) {
    requireHerdr();
    if (!pane) throw new Error("Herdr did not provide HERDR_PANE_ID for this PR view.");
  }
  const reporter = watch ? new SidebarReporter(pane!, watch) : undefined;
  const state: DashboardState = {
    entries: [],
    selected: watch?.id,
    running: false,
    logs: [],
    message: "",
    watchOnly: !!watch,
  };
  let stopped = false;
  let action: { watch: Watch; key: string } | undefined;
  let reportAfter = 0;
  // Opening the pane already publishes identity; updates can also partially
  // publish before failing. Release even if unwatch precedes the first update.
  let releasePending = !!reporter;
  let retiring = false;
  const pluginDashboard =
    !watch && process.env.HERDR_PLUGIN_ENTRYPOINT_ID === "dashboard" && !!pane;
  let dashboardMarked = 0;
  const stop = () => {
    stopped = true;
  };
  const keypress = (input: string, inkKey: import("ink").Key) => {
    const key = {
      name: inkKey.upArrow ? "up" : inkKey.downArrow ? "down" : input,
      ctrl: inkKey.ctrl,
    };
    if (inkKey.pageUp || inkKey.pageDown || inkKey.end) {
      state.logOffset = inkKey.end
        ? 0
        : Math.max(
            0,
            Math.min(
              Math.max(0, state.logs.length - 1),
              (state.logOffset ?? 0) + (inkKey.pageUp ? 5 : -5),
            ),
          );
      view?.update();
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      stop();
      return;
    }
    const index = Math.max(
      0,
      state.entries.findIndex((e) => e.watch.id === state.selected),
    );
    if (["up", "k", "down", "j"].includes(key.name ?? "")) {
      const next = Math.max(
        0,
        Math.min(state.entries.length - 1, index + (["up", "k"].includes(key.name!) ? -1 : 1)),
      );
      state.selected = state.entries[next]?.watch.id;
      state.logs = [];
      state.logOffset = 0;
      view?.update();
      return;
    }
    if (["p", "r", "t", "o"].includes(key.name ?? "") && !action && state.entries[index]) {
      // Pin the watch at keypress time; a refresh must not redirect an action.
      action = { watch: state.entries[index].watch, key: key.name! };
    }
  };
  const wasRaw = process.stdin.isRaw;
  let view: ReturnType<typeof dashboardTerminal.mount> | undefined;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  const resize = () => view?.update();
  process.stdout.on("resize", resize);
  try {
    view = dashboardTerminal.mount(state, keypress);
    while (!stopped) {
      try {
        if (action) {
          const pending = action;
          try {
            if (pending.key === "o") await openView(pending.watch, await viewWorkspace());
            else {
              const command = (
                { p: "pause", r: "resume", t: "retry" } as Record<string, WatchAction>
              )[pending.key];
              await controlWatch(pending.watch, command);
              state.message = `${command} requested for ${pending.watch.owner}/${pending.watch.repo} #${pending.watch.number}`;
            }
          } finally {
            action = undefined;
          }
        }
        const list = watch ? [watch] : await watches();
        list.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
        state.entries = await Promise.all(list.map(watchSnapshot));
        state.running = await ping();
        if (!state.entries.some((e) => e.watch.id === state.selected)) {
          state.selected = state.entries[0]?.watch.id;
          state.logOffset = 0;
          state.logs = [];
        }
        const selected = state.entries.find((e) => e.watch.id === state.selected);
        const logs = selected ? await recentActivity(selected.watch, 1000) : [];
        // Keep a scrolled view anchored when new lines arrive. End resumes live following.
        if (selected?.watch.id === state.selected) {
          if (state.logOffset && state.logs.length) {
            const previousEnd = logs.lastIndexOf(state.logs.at(-1)!);
            if (previousEnd >= 0) state.logOffset += logs.length - previousEnd - 1;
          }
          state.logs = logs;
        }
        if (pluginDashboard && Date.now() - dashboardMarked >= 10_000) {
          await markPluginView("dashboard", pane!);
          dashboardMarked = Date.now();
        }
        if (reporter && Date.now() >= reportAfter) {
          try {
            const entry = state.entries[0];
            if (entry.control?.mode === "removed") retiring = true;
            // Retirement is permanent; retry cleanup even after resume.
            if (retiring) {
              if (releasePending) await reporter.release();
              releasePending = false;
            } else {
              releasePending = true;
              await reporter.update(entry, state.running);
              if (state.message.startsWith("Sidebar unavailable:")) state.message = "";
            }
          } catch (e) {
            state.message = `Sidebar unavailable: ${String(e)}`;
            reportAfter = Date.now() + 10_000;
          }
        }
      } catch (e) {
        state.message = String(e);
      }
      view.update();
      await delay(300);
    }
  } finally {
    process.stdout.removeListener("resize", resize);
    await view?.close();
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
    if (reporter) await reporter.release().catch(() => {});
    if (pluginDashboard) await releasePluginView("dashboard", pane!).catch(() => {});
  }
}
