import { findWatch, home, watches } from "./io.js";
import { ping } from "./controller.js";
import { recentActivity } from "./dashboard.js";
import { plain, presentation, watchSnapshot } from "./presentation.js";

// A versioned, read-only projection for native clients. Durable state and policy
// remain backend-owned; presentation labels never authorize a GitHub write.
export async function modSnapshot(selected?: string) {
  const running = await ping();
  const list = await watches();
  list.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const entries = await Promise.all(
    list.map(async (watch) => {
      const snapshot = await watchSnapshot(watch);
      const display = presentation(snapshot, running);
      return {
        id: watch.id,
        url: watch.url,
        number: watch.number,
        repository: `${watch.owner}/${watch.repo}`,
        path: watch.path,
        agent: watch.agent,
        model: watch.model,
        ...display,
        message: plain(snapshot.state?.message ?? "Waiting for controller"),
        mode: snapshot.control?.mode ?? "running",
        worktree: snapshot.state?.job?.worktree ?? null,
      };
    }),
  );
  const activity = selected ? await recentActivity(await findWatch(selected), 1000) : [];
  return { version: 1, home: home(), controllerRunning: running, watches: entries, activity };
}
