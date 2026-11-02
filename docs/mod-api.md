# Native mod/backend interface (version 1)

Run `prsit snapshot [watch ID, URL, or unambiguous PR number]`. A successful
process writes one JSON object to stdout and exits zero. Errors write a diagnostic
to stderr and exit nonzero. No terminal-screen or durable-database parsing is
needed. The caller supplies the same `PRSIT_HOME` as its controller.

```json
{
  "version": 1,
  "home": "/absolute/state/directory",
  "controllerRunning": false,
  "watches": [
    {
      "id": "watch-id",
      "url": "https://github.com/owner/repo/pull/123",
      "number": 123,
      "repository": "owner/repo",
      "path": "/local/checkout",
      "agent": "pi",
      "model": "provider/model-id",
      "stage": "controller stopped",
      "semantic": "unknown",
      "message": "Waiting for controller",
      "mode": "running",
      "worktree": null
    }
  ],
  "activity": []
}
```

- Watches are sorted by creation time then ID, including retained unwatched
  history. `mode` is running, paused, or removed. `semantic` is working, blocked,
  idle, or unknown. `stage` is human-facing text, not a policy enum.
- `activity` is empty unless a watch is selected. It contains at most 1,000
  nonempty, sanitized lines from the latest 32 KiB of the selected event log.
  The incomplete first line of a truncated file tail is discarded. `prsit logs`
  remains the full-history interface. Messages/activity strip terminal escapes.
- `worktree` is a path or null. No database contents, conversation credentials,
  repair prompts, or raw GitHub feedback are embedded in the watch summary.
- Controller liveness is probed through the existing local socket. The view is
  best-effort observational data: state can change between reads. Nothing in
  this response authorizes a push or merge.
- The mod rejects unknown API versions, malformed JSON and nonzero exits; it
  never treats cached state as proof that the controller is still running.

Controls use the existing CLI commands: `pause`, `resume`, `retry`, `unwatch`,
and `watch` with explicit PR/repository/configuration arguments. The mod checks
exit status, not human-readable success text. Registration retains the CLI's
repository/model validation and autonomous-work authorization. Control failures
remain visible across successful later health polls.

`prsit start` writes `{ "running": true, "started": true|false }` after a live
controller is reachable. It reconnects without launching when already running;
otherwise it creates one unparented background hc terminal with explicit Node,
backend and state paths. A stable hc name and the controller's existing socket
prevent duplicate ownership. If startup is ambiguous it reports failure and asks
the person to inspect that terminal, rather than blindly relaunching.

`prsit stop` uses the established checkpointed shutdown protocol. Neither mod
reload nor view/window closure calls it. Terminal recovery shells are not a
restart mechanism: after reboot, start the controller explicitly.
