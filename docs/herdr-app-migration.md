# Native mod migration

## Agreed direction

Replace the herdr-tui plugin, retain the standalone CLI and Ink dashboard, and
keep the existing deterministic controller and durable repair engine. The native
mod is a view and control client, not an agent runtime or merge authority.

The user clarified that Ship-it integration means a cohesive UI, not automatic
registration after PR creation or a shared-state-prefilled watch form.

## Ship-it compatibility findings

Inspected https://github.com/ashrodan/ship-it (README and the strip's main.js and
data.js). It uses a 40px strip below the tab bar and three blocks in the
`panel-body` stack: `ship-it-changes`, `ship-it-review`, and `ship-it-prs`.
Its controls use theme colors, compact 26px buttons, rounded borders, and the
host layout's `panel` / `panel-body` commands. Without that stack, its review
falls back to a pane. PR creation opens `gh pr create --web`; there is no
creation callback. Its internal `ship-it.pr` shared cache is not an authorization
source or a public extension contract.

PR Sitter should add a compact companion control alongside the Ship-it strip
and a native panel in the same side-panel stack, with matching spacing, theme
colors, stage badges, and navigation. Installation must preserve Ship-it's
blocks and the user's other layout content, be repeatable, and only edit an
explicitly selected personal layout. Standalone installation should still work
without Ship-it, with a pane/board fallback. No upstream changes or runtime
patching of Ship-it are needed. Do not duplicate Ship-it's diff/review/merge UI.

## Backend boundary

`prsit snapshot [watch]` returns a versioned JSON projection: controller health,
state directory identity, watch summaries, exact presentation stages, worktree
paths, and selected activity bounded to 32 KiB / 1,000 lines. No database or
terminal scraping by the mod. Existing watch registration and control commands
remain the only way to request changes; failures must be visible to the caller.

Controller start uses an unparented/background hc terminal with explicit state
configuration and the existing socket ownership guard. It must not be owned by
any mod copy. Closing/reloading a panel must not kill it. Reboot recovery still
requires restarting the controller; hc keep is not command replay.

Native views replace all automatic per-watch terminal creation and TUI sidebar
reporting. UI identity is not controller ownership. Keep old watch state readable
and leave old UI receipts/worktrees untouched rather than deleting user history.

## Verification

Use fixture-backed backend and mod-logic tests, isolated install/layout tests,
herdr-app check, and an actual safe rendered preview. Preserve core publication
and recovery regressions. Check Linux here and explicitly leave Mac validation
unverified until exercised on a Mac. The user authorized revising AGENTS.md to
permit fixture-based hosted CI; provider smoke tests remain opt-in and local.
