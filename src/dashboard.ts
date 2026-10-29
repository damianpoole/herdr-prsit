import { emitKeypressEvents } from "node:readline";
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
  presentation,
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
}
const clip = (text: string, width: number) =>
  Array.from(plain(text)).slice(0, Math.max(0, width)).join("");
export function renderDashboard(state: DashboardState, columns = 100, rows = 30): string {
  const { entries, running } = state;
  const width = Math.max(1, columns - 1);
  const height = Math.max(1, rows);
  const index = Math.max(
    0,
    entries.findIndex((e) => e.watch.id === state.selected),
  );
  const selected = entries[index];
  const lines = [
    `${state.watchOnly ? "PR ACTIVITY" : "PR SITTER DASHBOARD"}  |  controller ${running ? "running" : "STOPPED"}  |  ${entries.length} watches`,
    "↑/↓ j/k select   p pause   r resume   t retry   o open activity   q quit",
    state.watchOnly
      ? "One PR activity view. Open PR sitter dashboard for all watches."
      : `${entries.filter((e) => e.state?.status === "merged").length} merged | ${entries.filter((e) => e.state?.status === "blocked").length} blocked | ${entries.filter((e) => e.control?.mode === "paused").length} paused`,
    "",
  ];
  const count = Math.max(1, Math.min(entries.length, Math.floor((height - 8) / 2)));
  const start = Math.max(0, index - count + 1);
  for (const entry of entries.slice(start, start + count)) {
    const { watch: w } = entry;
    const stage = presentation(entry, running).stage;
    lines.push(
      `${w.id === selected?.watch.id ? ">" : " "} #${w.number} ${w.owner}/${w.repo}  |  ${stage}`,
    );
  }
  if (!entries.length)
    lines.push("No PRs registered. Add one with: prsit watch <PR URL> --repo <path>");
  lines.push("");
  if (selected) {
    lines.push(selected.watch.url);
    lines.push(selected.state?.message ?? "Registered; waiting for the controller.");
    if (selected.state?.job?.worktree) lines.push(`Worktree: ${selected.state.job.worktree}`);
    lines.push("Recent activity:");
    const space = Math.max(0, height - lines.length - 2);
    lines.push(...(space ? state.logs.slice(-space) : []));
  }
  lines.push(
    "",
    state.message ||
      "Controls use the existing watch state. Closing this view leaves work running.",
  );
  return lines
    .slice(0, height)
    .map((line) => clip(line, width))
    .join("\r\n");
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
  const keypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
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
      return;
    }
    if (["p", "r", "t", "o"].includes(key.name ?? "") && !action && state.entries[index]) {
      // Pin the watch at keypress time; a refresh must not redirect an action.
      action = { watch: state.entries[index].watch, key: key.name! };
    }
  };
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", keypress);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  try {
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
        if (!state.entries.some((e) => e.watch.id === state.selected))
          state.selected = state.entries[0]?.watch.id;
        const selected = state.entries.find((e) => e.watch.id === state.selected);
        state.logs = selected ? await recentActivity(selected.watch, process.stdout.rows) : [];
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
      process.stdout.write(
        "\x1b[H\x1b[2J" + renderDashboard(state, process.stdout.columns, process.stdout.rows),
      );
      await delay(300);
    }
  } finally {
    process.stdin.removeListener("keypress", keypress);
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (reporter) await reporter.release().catch(() => {});
    if (pluginDashboard) await releasePluginView("dashboard", pane!).catch(() => {});
  }
}
