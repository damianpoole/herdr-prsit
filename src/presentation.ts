import { join } from "node:path";
import { atomic, optional, watchDir } from "./io.js";
import type { Watch, State } from "./types.js";
import type { Control } from "./runtime.js";

// Optional review-request metadata can be supplied by review-gate integrations.
type ActivityState = State & { codexReviewRequest?: { phase: "pending" | "requested" } };
export interface WatchSnapshot {
  watch: Watch;
  state?: ActivityState;
  control?: Control;
}
export async function watchSnapshot(watch: Watch): Promise<WatchSnapshot> {
  const [state, control] = await Promise.all([
    optional<ActivityState>(join(watchDir(watch), "status.json")),
    optional<Control>(join(watchDir(watch), "control.json")),
  ]);
  return { watch, state, control };
}

// Display only: never use a presentation label to authorize publication or merge.
export function activityLabel(state?: ActivityState, control?: Control): string {
  if (control?.mode === "removed") return "unwatched";
  if (state && ["merged", "closed"].includes(state.status)) return state.status;
  if (control?.mode === "paused") return "paused";
  if (!state) return "watching";
  if (["blocked", "retrying"].includes(state.status)) return state.status;
  if (state.status === "preparing") return "preparing repair";
  if (state.status === "repairing") {
    const kinds = state.job?.items.map((item) => item.kind) ?? [];
    if (kinds.some((kind) => ["thread", "comment", "review"].includes(kind)))
      return "handling comments";
    if (kinds.includes("ci")) return "fixing checks";
    if (kinds.includes("conflict")) return "resolving conflicts";
    return "repairing";
  }
  if (state.status === "publishing") return "publishing fixes";
  if (/merge submitted/i.test(state.message)) return "merge queued";
  if (/draft/i.test(state.message)) return "draft";
  if (/requesting fresh/i.test(state.message)) return "requesting review";
  if (/review is in progress/i.test(state.message)) return "review in progress";
  if (/review|thumbs-up/i.test(state.message)) {
    return state.codexReviewRequest?.phase === "requested"
      ? "review requested"
      : "waiting for review";
  }
  if (/checks/i.test(state.message)) return "waiting for checks";
  return state.status === "waiting" ? "waiting" : "watching";
}

export function presentation(snapshot: WatchSnapshot, running: boolean) {
  const { state, control } = snapshot;
  let stage = activityLabel(state, control);
  const settled = ["merged", "closed", "paused", "unwatched"].includes(stage);
  if (!running && !settled) stage = "controller stopped";
  const semantic =
    stage === "controller stopped"
      ? "unknown"
      : stage === "blocked"
        ? "blocked"
        : ["preparing", "repairing", "publishing"].includes(state?.status ?? "") && !settled
          ? "working"
          : "idle";
  return { stage, semantic };
}

export type WatchAction = "pause" | "resume" | "retry" | "unwatch";
export async function controlWatch(w: Watch, action: WatchAction) {
  // The runtime remains responsible for deciding whether a retry is actionable.
  await atomic(join(watchDir(w), "control.json"), {
    mode: action === "pause" ? "paused" : action === "unwatch" ? "removed" : "running",
    ...(action === "retry" ? { retryAt: Date.now() } : {}),
  });
}

// Repository feedback and tool output must not be interpreted as terminal commands.
/* oxlint-disable no-control-regex -- Deliberately strip terminal control sequences from displayed text. */
export const plain = (value: string) =>
  value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/* oxlint-enable no-control-regex */
