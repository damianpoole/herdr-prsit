# herdr-prsit

A terminal-first GitHub pull-request babysitter for **Herdr**, built on **Pi Durable**. It polls GitHub with ordinary code, repairs actionable feedback with an agent, publishes the fixes, and merges when the PR satisfies its merge gate.

Designed to run locally on Linux and macOS. Verification has been performed locally on Linux; macOS validation is pending testing on a MacBook. Each machine has its own watch list and repository mappings. Ghostty needs no special integration.

## Install

Requires Node **22.19+**, Git, an authenticated `gh`, and Herdr for pane integration. The default agent uses your Pi credentials and `models.json`. OpenCode 2.x is optional.

```sh
git clone git@github.com:damianpoole/herdr-prsit.git
cd herdr-prsit
npm ci --ignore-scripts
npm run build
npm link
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

Registration authorizes autonomous local commits, pushes, review replies, addressed-thread resolution, and merging. No work starts until the controller runs. The controller creates a Herdr workspace with a live activity view for each new watch without changing focus. `prsit open 123` opens another view. Agent execution lives in the controller, so closing a view does not stop the agent.

```sh
prsit watch https://github.com/owner/repo/pull/456 \
  --repo ~/git/repo --agent opencode --model provider/model-id
```

OpenCode runs in its own saved session with `run --format json --auto`. Its output appears in the activity view. Unlike native Pi Durable, an interrupted OpenCode process is **not** resumed automatically: inspect its session/worktree, then use `prsit retry 456` to start a fresh repair. Explicit OpenCode permission denials remain in effect.

## Commands

| Command                 | Behaviour                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- |
| `run`                   | Run continuously inside Herdr; Ctrl+C checkpoints pending work                    |
| `run --headless`        | Run without Herdr layout, useful for a service or test host                       |
| `watch <number or url>` | Register a PR and its repository/harness configuration                            |
| `status [--json]`       | Controller liveness and each watch's last published status                        |
| `logs <watch> [-f]`     | Activity and native agent text/tool events                                        |
| `open <watch>`          | Create a new Herdr activity workspace                                             |
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

Tests exercise the actual Pi Durable SQLite scheduler and native coding tools using a deterministic model fixture, restart recovery, head races, deduplicated review replies, pagination, real Git worktrees and local pushes, and the Herdr command contract. Verification is local only; this repository has no GitHub Actions workflow. The suite has passed on Linux. Run the same commands on a MacBook to validate macOS. No credentials or live GitHub writes are needed for the normal suite.

An optional real-provider smoke test repairs a temporary local repository and validates/pushes to a local bare remote. It makes model requests using your Pi authentication but does not write to GitHub:

```sh
PRSIT_SMOKE_MODEL=provider/model-id node test/native-smoke.mjs
```

The project deliberately pins the experimental Pi Durable API. Test recovery before upgrading it.
