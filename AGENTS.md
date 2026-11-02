# Working on herdr-prsit

This is a local PR babysitter with a native herdr-app mod and standalone CLI for
Linux and macOS. Read README.md for installation, the command contract, merge
gate, recovery behavior, and limitations.

## Design boundaries

- Keep polling, eligibility decisions, retries, and publication guards deterministic.
  Use agents for repairs; native Pi Durable is the default harness. Preserve its
  checkpoint/resume behavior and OpenCode's explicit retry requirement.
- GitHub writes must remain safe to replay after interruption. Preserve operation
  markers, fresh-state checks, and head guards on push and merge.
- Repair in isolated worktrees. Preserve the user's checkout and unrelated work;
  do not introduce force pushes or administrative bypasses of merge requirements.
- Reuse existing Pi credentials and model configuration. Never commit credentials
  or local watch state. Each machine maintains independent local state.
- Registration authorizes autonomous commits, pushes, replies, addressed-thread
  resolution, and eligible merges. Preserve that workflow without extra approval
  gates; a finished agent alone is not proof that publication or merge is safe.

## Verification

Run verification locally and in GitHub Actions. Hosted CI is authorized for tests,
formatting, lint, build, and type checking using the scripts in package.json. Add
focused regression coverage for behavioral changes. Default tests and hosted CI
must use local fixtures rather than modifying live PRs or invoking paid model
providers, and must not require provider credentials. The native provider smoke
test remains opt-in and must not run in default CI.

Linux can be verified here; report macOS compatibility as unverified until tested
on a Mac. Keep process handling, paths, and CLI integrations portable to both.
