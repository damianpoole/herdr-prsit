# herdr-app migration verification

## Local checks

Verified on Linux with herdr-app 0.1.12 and hc 0.1.17:

- `npm test`: **71 passed, 0 failed**, on Node 26.8.1 and Node 22.23.2.
- `npm run check`: passed.
- `npm run lint`: passed without warnings.
- `npm run fmt:check`: passed.
- `herdr-app check mods/prsit`: passed.
- `git diff --check`: passed.

Tests include the actual durable SQLite scheduler, replay/recovery and guarded
publication fixtures, real scratch Git worktrees, native snapshot/controller
ownership, control target pinning, persistent action errors, registration argv,
layout composition/idempotence/collisions, and isolated installation. The old
TUI-specific tests were replaced; shared presentation-stage assertions remain.
No paid providers or live PR writes were used by tests.

## Native rendering and controller lifetime

Used an isolated Xvfb display, scratch HOME/XDG directories, a dedicated hc
session and a separate HERDR_APP_HOME. No interaction with the user's window or
live watch state was required. Temporary display/runtime dependencies were
extracted into the scratch directory, not installed system-wide.

Inspected actual native screenshots at full width and 420px panel width:

- Fictional repair, waiting and blocked entries with selected worktree/activity.
- Registration form with all five inputs and autonomous-work notice.
- Empty registration submission displaying its validation error.

`preview.png` is the actual 420px renderer with fictional data from
`scripts/preview-fixture.mjs`; that script rejects all non-snapshot commands.

Separately started the real controller with an empty scratch state directory:

1. First `prsit start` returned running=true, started=true.
2. Second Start reconnected: running=true, started=false.
3. Reinstalled/reloaded the mod; snapshot still reported the controller running.
4. Closed the isolated app window; snapshot still reported it running.
5. `prsit stop` requested graceful shutdown; the hc terminal exited zero and the
   final snapshot reported controllerRunning=false.

The temporary terminals, X server and dedicated hc server were stopped after
verification. No restart/stop command targeted the user's core.

## Distribution smoke check

- `npm pack --json` produced a 72-file package including the native assets,
  installer, recipe and preview.
- Confirmed no legacy TUI entrypoints/manifest, generated mod type declarations,
  credentials or durable SQLite state in the package.
- Installed the tarball with production dependencies only into a scratch prefix
  (`npm install --ignore-scripts --omit=dev`).
- Ran the installed package's installer into another isolated app home, with an
  explicit scratch state home. Its native check passed.
- Ran the installed backend's snapshot: version=1, stopped, empty watch list.
- Layout tests preserve Ship-it's active review panel and unrelated blocks,
  wrap its strip alongside PR Sitter, reject ID collisions and repeat cleanly.

## Limits and remaining work

- macOS is **unverified**; no Mac execution is claimed.
- Local controller orchestration only; remote machines are not implemented.
- Advanced registration flags remain available via CLI rather than all being
  exposed in the native form. Native activity is bounded to 32 KiB / 1,000 lines.
- With no side-panel stack, explicitly opening PR Sitter creates a tab. Existing
  panes are not reused without observable backend/state-directory identity.
- Ship-it integration is layout/visual composition as clarified by the user,
  not an upstream patch or automatic PR-created handoff.
- Hosted test/format/lint CI is still pending. AGENTS.md now records the user's
  authorization, but no hosted workflow or successful hosted check is claimed.
