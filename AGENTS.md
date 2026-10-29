# Working on herdr-prsit

This is a local, terminal-first PR babysitter for Herdr on Linux and macOS. Read
README.md for the command contract, merge gate, recovery behavior, and limitations.

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

Run verification locally only. Do not add GitHub Actions workflows or other hosted
CI jobs. Use the scripts in package.json for build, type checking, and tests, with
focused regression coverage for behavioral changes. Default tests must use local
fixtures rather than modifying live PRs or invoking paid model providers. The
native provider smoke test is opt-in.

Linux can be verified here; report macOS compatibility as unverified until tested
on a Mac. Keep process handling, paths, and CLI integrations portable to both.
