// Fictional, read-only data for native UI previews. Never contacts GitHub/models.
const watches = [
  {
    id: "repair",
    number: 123,
    repository: "example/herdr-app",
    stage: "handling comments",
    semantic: "working",
    message: "Addressing keyboard navigation feedback in an isolated worktree.",
    worktree: "/tmp/prsit-preview/worktrees/focus-fix",
  },
  {
    id: "checks",
    number: 128,
    repository: "example/herdr-app",
    stage: "waiting for checks",
    semantic: "idle",
    message: "Waiting for reported checks to finish.",
    worktree: null,
  },
  {
    id: "blocked",
    number: 94,
    repository: "example/herdr-core",
    stage: "blocked",
    semantic: "blocked",
    message: "Validation failed. Inspect the worktree, then request a retry.",
    worktree: "/tmp/prsit-preview/worktrees/reconnect",
  },
].map((w) => ({
  ...w,
  url: `https://github.com/${w.repository}/pull/${w.number}`,
  path: "/tmp/prsit-preview/repository",
  mode: "running",
  agent: "pi",
  model: "fixture/local",
}));
if (process.argv[2] !== "snapshot") {
  console.error("Read-only preview: no controller or GitHub action was performed.");
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      version: 1,
      home: "/tmp/prsit-preview/state",
      controllerRunning: true,
      watches,
      activity: process.argv[3]
        ? [
            "14:21:02 Read repository instructions",
            "14:21:07 Inspected keyboard focus handling",
            "14:21:15 Updated navigation regression test",
            "14:21:23 Running local validation…",
          ]
        : [],
    }),
  );
}
