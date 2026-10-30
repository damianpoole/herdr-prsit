// Local display fixtures only: no GitHub requests, credentials, or watch-state writes.
import { renderDashboard } from "../dist/dashboard-ui.js";
const entries = [
  [42, "herdr", "repairing", "Addressing review feedback in an isolated worktree.", "thread"],
  [
    87,
    "website",
    "blocked",
    "Validation failed: npm test. Inspect the worktree, then press t to retry.",
  ],
  [31, "herdr-prsit", "waiting", "Waiting for required checks to pass."],
  [56, "cli", "waiting", "Waiting for review."],
  [24, "docs", "merged", "Pull request merged successfully."],
  [19, "api", "waiting", "Paused while investigating a flaky integration test."],
].map(([number, repo, status, message, kind], index) => ({
  watch: {
    id: String(number),
    number,
    owner: "acme",
    repo,
    url: `https://github.com/acme/${repo}/pull/${number}`,
    created: index,
  },
  state: {
    status,
    message,
    ...(kind
      ? { job: { items: [{ kind }], worktree: `/tmp/prsit/worktrees/acme-${repo}/${number}` } }
      : {}),
  },
  ...(number === 19 ? { control: { mode: "paused" } } : {}),
}));
const mode = process.argv[2] ?? "wide";
const columns = Number(process.argv[3] ?? (mode === "narrow" ? 72 : 120));
const rows = Number(process.argv[4] ?? 32);
const state = {
  entries: mode === "empty" ? [] : mode === "activity" ? [entries[0]] : entries,
  selected: mode === "narrow" || mode === "stopped" ? "87" : "42",
  running: mode !== "stopped",
  watchOnly: mode === "activity",
  message: "",
  logs:
    mode === "narrow" || mode === "stopped"
      ? [
          "14:21:03  Validation started: npm test",
          "14:21:05  FAIL test/navigation.test.ts",
          "14:21:05  Expected active route: /settings",
          "14:21:05  Received active route: /",
          "14:21:06  Publication blocked; worktree retained.",
        ]
      : [
          "14:20:11  GitHub snapshot refreshed",
          "14:20:11  Found 2 actionable review threads",
          "14:20:12  Prepared isolated repair worktree",
          "14:20:12  Pi Durable repair started",
          "14:20:15  Read src/navigation.ts",
          "14:20:18  Read test/navigation.test.ts",
          "14:20:22  Updated active-route handling",
          "14:20:23  Added regression coverage",
          "14:20:24  Running local validation…",
        ],
};
process.stdout.write(renderDashboard(state, columns, rows) + "\r\n");
