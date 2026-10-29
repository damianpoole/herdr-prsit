# herdr-prsit

A terminal-first GitHub pull-request babysitter for **Herdr**, built on **Pi Durable**. It polls GitHub with ordinary code, repairs actionable feedback with an agent, publishes the fixes, and merges when the PR satisfies its merge gate.

Designed to run locally on Linux and macOS. Verification has been performed locally on Linux; macOS validation is pending testing on a MacBook. Each machine has its own watch list and repository mappings. Ghostty needs no special integration.

## Install

Requires Node **22.19+**, Git, an authenticated `gh`, and **Herdr 0.9.1+** for the plugin and Agents sidebar. The default agent uses your Pi credentials and `models.json`. OpenCode 2.x is optional.

```sh
git clone git@github.com:damianpoole/herdr-prsit.git
cd herdr-prsit
npm ci --ignore-scripts
npm run build
npm link
herdr plugin link .
prsit doctor
prsit models
```

Pi Durable and Pi's model library are pinned to `1.4.0`. This is a native Pi Durable harness, not a subprocess running the Pi coding-agent CLI. It reuses Pi's provider/auth configuration, but does not load Pi CLI extensions, MCP servers, themes, or prompt templates. Its tools are Pi Durable's read, write, edit, and bash tools. The agent is instructed to read repository `AGENTS.md` files.

## Daily workflow

In a Herdr pane:

```sh
prsit run
```

In another pane, from your repository:

```sh
prsit watch 123 \
  --model openai-codex/gpt-6.1-sol \
  --test 'npm test'

prsit status
prsit logs 123 --follow
prsit pause 123
prsit resume 123
```

`--model` can be omitted when `PRSIT_MODEL` or Pi's `defaultProvider` and `defaultModel` are configured. `prsit models` lists authenticated model choices; authentication stays in Pi's existing store. Model selection is recorded per PR.

`prsit watch 123` resolves the repository from the current checkout (including subdirectories), using `gh`'s default repository for that checkout. `--repo /path/to/repo` supplies the checkout when running elsewhere. An ambient `GH_REPO` does not override this lookup. Full HTTPS PR URLs remain supported.

For example, when running outside the repository:

```sh
prsit watch 123 --repo ~/git/my-project
```

`watch` validates the checkout against the PR's GitHub host and repository. Pass `--repo /path/to/repo` from elsewhere; full URLs can also reuse a remembered repository mapping. For commands acting on existing watches, ambiguous PR numbers require the displayed watch ID or full URL.

Registration authorizes autonomous local commits, pushes, review replies, addressed-thread resolution, and merging. No work starts until the controller runs. The workspace running `prsit run` remains the main workspace. Each watched PR gets a plugin-owned activity pane and an entry in Herdr's **Agents sidebar**, visible while you work in other workspaces. Its tab and Agents sidebar names update together from saved watch state and include the PR number, repository, and stage: `handling comments`, `fixing checks`, `review requested`, `publishing fixes`, `blocked`, `merged`, and so on. No sidebar configuration changes are needed with Herdr's default Agents layout. Existing custom Agent filters can still hide entries; the plugin does not replace your filters.

The pane is a view of prsit, not a second agent runtime. The actual Pi Durable/OpenCode work stays in the controller. The backing panes live in tabs in the main workspace, but status is reported to the global Agents sidebar rather than relying on tab names. Selecting a sidebar entry opens its details and recent activity. `prsit open 123` focuses the existing entry or recreates a closed view. Creation by the controller never steals focus. Closing a view leaves work running. Existing standalone workspaces and the earlier tab-only views are left untouched; you can close them manually.

The plugin reports `working` during repairs/publication, `blocked` for work needing intervention, and `idle` while waiting or finished. Both Herdr's seen and unseen completion labels keep the actual PR stage; viewing a merged PR does not turn its label into generic “idle”. If the controller stops, unfinished running watches show `controller stopped` instead of stale activity. Paused and terminal states remain visible. Unwatching releases the sidebar entry, with history retained in the dashboard. Display reporting never authorizes a push or merge.

## Herdr plugin and dashboard

After building and linking the plugin from the install steps, these actions are available in Herdr:

```sh
herdr plugin action invoke herdr-prsit.start
herdr plugin action invoke herdr-prsit.dashboard
```

`start` opens a controller pane in a tab named **PR sitter** in the invoking workspace. `prsit stop` gracefully stops that controller from any terminal using the same state directory; it works even when you cannot locate the pane. You can instead run `prsit run` in an existing pane. The dashboard action opens or focuses one **PR SITTER DASHBOARD** board in a tab named **PR dashboard** in the controller's workspace. Repeating the action reuses that board. Per-PR tabs are named **PR #123 owner/repo — handling comments** (using the current stage), and their panes are headed **PR ACTIVITY** and show only that PR. `prsit dashboard` runs the same board in your current terminal, including outside Herdr for inspecting state and changing local watch controls. `open` requires Herdr. Plugin actions and `prsit open` must run in the controller's Herdr session; a different session is rejected rather than interpreting its workspace IDs locally.

The dashboard lists watches and their stages, shows the selected PR's status message, repair worktree, and recent activity, and refreshes automatically. Its controls are:

| Key                    | Action                                                 |
| ---------------------- | ------------------------------------------------------ |
| `↑` / `↓` or `j` / `k` | Select a PR                                            |
| `p`                    | Pause the selected watch                               |
| `r`                    | Resume its checkpointed work                           |
| `t`                    | Request retry using the existing blocked-work protocol |
| `o`                    | Focus or reopen its activity pane                      |
| `q` / `Ctrl+C`         | Close this view; leave the controller running          |

Use `prsit watch` to register new PRs and `prsit unwatch` to remove them. There is no merge button or second repair engine in the dashboard. All controls use the same local state as the CLI. A dashboard opened while the controller is stopped can queue pause/resume/retry controls, but work only progresses when the controller runs.

The plugin's manifest is `herdr-plugin.toml`; it declares controller, dashboard, and per-PR pane entrypoints and two menu actions. It adds no startup daemon or hosted service. Plugin and CLI share `$PRSIT_HOME` (or the usual default), Pi credentials, and existing watch history. For a custom state directory, launch the plugin actions with the same `PRSIT_HOME` as the controller; menu actions use the environment inherited by Herdr. Background UI errors retry independently of runtime supervision. Closing a PR pane removes its sidebar entry; `prsit open` brings it back. After restarting Herdr, restart `prsit run` to restore monitoring and views.

```sh
prsit watch https://github.com/owner/repo/pull/456 \
  --repo ~/git/repo --agent opencode --model provider/model-id
```

OpenCode runs in its own saved session with `run --format json --auto`. Its output appears in the activity view. Unlike native Pi Durable, an interrupted OpenCode process is **not** resumed automatically: inspect its session/worktree, then use `prsit retry 456` to start a fresh repair. Explicit OpenCode permission denials remain in effect.

## Commands

| Command                 | Behaviour                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- |
| `run`                   | Run continuously inside Herdr; Ctrl+C checkpoints pending work                    |
| `stop`                  | Request graceful controller shutdown and checkpoint pending work                  |
| `run --headless`        | Run without Herdr layout, useful for a service or test host                       |
| `watch <number or url>` | Register a PR and its repository/harness configuration                            |
| `status [--json]`       | Controller liveness and each watch's last published status                        |
| `logs <watch> [-f]`     | Activity and native agent text/tool events                                        |
| `open <watch>`          | Focus or reopen the PR’s Agents sidebar activity pane                             |
| `dashboard`             | Interactive PR stages, details, recent activity, and local controls               |
| `pause <watch>`         | Close the durable runtime, preserving unfinished work                             |
| `resume <watch>`        | Reopen and resume the same checkpointed work                                      |
| `retry <watch>`         | Resume blocked publication; otherwise start a fresh repair and reset retry counts |
| `unwatch <watch>`       | Stop watching and retain history/worktrees; `resume` reactivates it               |
| `doctor` / `models`     | Check environment and available Pi models                                         |

Watch options: `--interval 15m`, `--timeout 30m`, `--max-attempts 3`, `--merge squash|merge|rebase`, `--test '<shell command>'`, `--allow-no-checks`.

For personal projects, `--require-codex-review` adds an optional Codex reaction gate:

```sh
prsit watch 123 --require-codex-review --allow-no-checks --interval 30s
```

Omit `--allow-no-checks` if the repository has CI. Required reviewers, checks, unresolved threads, and GitHub merge protections still apply; existing watches and the default workflow are unchanged.

On its first actionable poll, the controller establishes a baseline and requests a fresh review automatically. If there is pending feedback, it repairs that first. An existing thumbs-up at startup does not permit immediate merging. The gate accepts Codex’s structured completed/no-findings summary for the exact current commit, with its code-review completion time and a 👍 both newer than the controller’s marked review request. This works even when the entire review finishes between polls. Existing approval before the request does not qualify. If the summary format is unavailable, the fallback requires an observed new 👀 followed by a new 👍 on the same source. Any active Codex 👀 blocks merging. In this mode, exact `@codex review` comments, authenticated structured status summaries, and recognized no-findings receipts are not repair feedback. Actual review findings and other comments still trigger repairs.

Every observed head change (including a repair push) invalidates the review cycle. Evidence survives controller restarts; missing or unreadable reaction data never grants approval. With this option enabled, after publishing a changed head and replying to the addressed feedback, the controller automatically posts `@codex review`. It saves the new-head baseline before posting, checks the live PR head, and uses a stable operation marker to avoid duplicate requests after interruption or retry. Reactions on these marked request comments count toward the gate. Further findings go through the same repair → push → request-review loop. A repair that creates no new commit does not request another review if this head already has a request. Post-push request failures block publication; `prsit retry` resumes it without rerunning the repair. Initial request failures retry at the poll interval. It also requests a fresh review when it observes an externally changed head once pending feedback has been addressed. Each head gets at most one automatically posted request under normal replay; if neither a fresh commit-specific completion summary nor an observed reaction cycle is available, or Codex never responds, the watch keeps waiting rather than repeatedly posting requests.

Codex’s structured summary provides a reviewed commit SHA; reactions alone do not. Summary parsing fails closed if required completion metadata is missing or changes format. The reaction-only fallback cannot conclusively attribute concurrent reviews or head changes between polls. Use GitHub-enforced reviews/checks where that guarantee is required. Reactions are rechecked in the final fresh snapshot before the existing head-guarded merge.

`retry` is for blocked work, not an already running job. A blocked publication resumes its saved validated commit and report without rerunning the agent; genuine head changes still block publication. After a push, the controller retries an unchanged old GitHub head up to ten times at one-second intervals before blocking. Other blocked phases start a fresh repair. A blocked watch notices a retry within about five seconds. Pause/resume controls are noticed within about one second, except while the controller is opening another runtime. A resumed sleeping watch keeps its original poll deadline. The repair timeout is a wall-clock deadline and includes time spent stopped.

## How it works

```text
GitHub snapshot → deterministic decision → durable sleep (15 minutes)
                         │
                  actionable changes
                         ↓
          isolated Git worktree → durable agent conversation
                         ↓
           structured report + local commit + validation
                         ↓
           guarded push → replies/resolution → fresh snapshot
                         ↓
                  head-guarded merge
```

The supervisor is a Pi Durable task, with persisted `poll`, `prepare`, `repair`, and `publish` checkpoints and sleep deadlines. An unchanged PR causes no model request. New/edited comments, review threads and review bodies, failing checks, and merge conflicts trigger a repair. GitHub Actions failure logs are included when available; other CI providers are represented by check state and links.

Each job gets a detached worktree. The agent commits locally; the controller requires a clean worktree and a descendant of the original PR head before publishing. A configured `--test` command runs independently after the agent and must pass. Without it, the agent chooses relevant validation and GitHub CI remains part of the merge gate.

The controller awaits native submission completion **and** conversation idleness, then immediately validates and checks GitHub. It does not infer completion from terminal colours or screen scraping. Native tool/model activity is stored by Pi Durable; an interrupted tool follows its own replay policy. Shell side effects are not assumed to be exactly-once.

The merge gate requires an open, non-draft PR; no active job; no unprocessed feedback; no unresolved review threads; required review satisfied; all reported checks successful, neutral, or skipped; and GitHub's `MERGEABLE`/`CLEAN` state. No checks blocks merging unless explicitly opted in. A second fresh snapshot is checked just before `gh pr merge --match-head-commit`. There is no administrator bypass. A queued/submitted merge is monitored until GitHub confirms `MERGED`.

GitHub repository protection rules remain authoritative. The head guard detects commit races, but GitHub does not expose an atomic transaction covering every comment and review read. Feedback added in the tiny interval after the final read follows GitHub's enforced conversation/review requirements.

## Recovery and state

State lives at `$PRSIT_HOME`, otherwise `$XDG_STATE_HOME/herdr-prsit` or `~/.local/state/herdr-prsit`:

- `herdr-views/`: session-scoped pane creation receipts and retired-pane exclusions, independent of expiring sidebar metadata. Retirement is saved before identity cleanup, so a transient cleanup failure cannot reopen an inactive pane; cleanup retries even if the watch resumes. If a creation result is lost, the controller refuses to create another pane until the existing view reports its identity. Separate per-view `.lock` files serialize receipt reconciliation, creation, and release across processes; a concurrent caller must retry. Locks are removed on normal completion or failure, but are not automatically reclaimed after a crash. Only remove an abandoned lock after confirming its owner has exited and inspecting existing PR sitter tabs; retain any `opening` receipt until the view identity is reconciled.
- `watches/`: repository mappings and per-PR settings.
- `<watch>/durable.sqlite`: authoritative task and agent history.
- `<watch>/status.json`: last status snapshot for the CLI.
- `<watch>/events.log`: readable activity view.
- `<watch>/jobs/`: prompts, agent reports, and OpenCode receipts.
- `worktrees/<watch>/<job>/`: isolated checkouts, retained for inspection.

One controller owns the state directory. A Unix socket prevents duplicate controllers; it is not a network service. Separate state directories do not coordinate watches: do not register the same PR in multiple controllers/machines.

Publication is reconciled against GitHub: a head already pushed is accepted; reviewer replies carry stable HTML operation markers to prevent duplicate replies after recovery; resolving an already resolved thread is a no-op. Feedback IDs plus content fingerprints prevent unchanged text from repeatedly triggering work. GitHub reads paginate both review threads and their nested comments.

Transient polling failures retry at the poll interval. Agent/publication failures become blocked with a visible reason. Automatic repairs of the same feedback key are bounded. `retry` preserves previous worktrees/transcripts for inspection and creates fresh work; it does not discard user files or force push.

The controller must be running on an awake, connected machine. Herdr detachment keeps the pane process alive; a sleeping laptop cannot poll GitHub. Restart `prsit run` after a reboot to reopen persisted work. An OS service can run `--headless` with the same PATH, Git credentials, and Pi authentication, but service installation is not required.

The agent executes local shell commands as you do. Run it against repositories and PR code you trust. A Git worktree is isolation from your working branch, not a security sandbox. Forks require permission to push to their head repository; otherwise the watch blocks. Repository hooks, signing, missing dependencies, unavailable CI secrets, or explicit provider permission denials may also require attention.

## Development and verification

```sh
npm run lint
npm run fmt:check
npm test
npm run check
npm audit
npm pack
```

Oxlint and Oxfmt use their default rules and formatting settings. Run `npm run lint:fix` to apply automatic lint fixes and `npm run fmt` to format the repository. Both tools respect `.gitignore`, so dependencies and build output are excluded.

Tests exercise the actual Pi Durable SQLite scheduler and native coding tools using a deterministic model fixture, restart recovery, head races, deduplicated review replies, pagination, real Git worktrees and local pushes, the Herdr plugin/Agents reporting contract, and dashboard controls. Verification is local only; this repository has no GitHub Actions workflow. The suite has passed on Linux. Run the same commands on a MacBook to validate macOS. No credentials or live GitHub writes are needed for the normal suite.

An optional real-provider smoke test repairs a temporary local repository and validates/pushes to a local bare remote. It makes model requests using your Pi authentication but does not write to GitHub:

```sh
PRSIT_SMOKE_MODEL=provider/model-id node test/native-smoke.mjs
```

The project deliberately pins the experimental Pi Durable API. Test recovery before upgrading it.
