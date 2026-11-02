// No Node APIs: this module also runs under the native mod host.
export function invocation(config, args) {
  const command = config.command ?? "prsit";
  const prefix = config.args ?? [];
  if (
    typeof command !== "string" ||
    !Array.isArray(prefix) ||
    prefix.some((x) => typeof x !== "string")
  )
    throw new Error("Invalid PR Sitter command configuration");
  if (config.stateHome)
    return {
      command: "env",
      args: [`PRSIT_HOME=${config.stateHome}`, command, ...prefix, ...args],
    };
  return { command, args: [...prefix, ...args] };
}

export async function call(exec, config, args, json = false) {
  const request = invocation(config, args);
  const result = await exec(request.command, request.args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || `prsit exited ${result.code}`);
  if (!json) return result.stdout.trim();
  const value = JSON.parse(result.stdout);
  if (
    args[0] === "snapshot" &&
    (value.version !== 1 || !Array.isArray(value.watches) || !Array.isArray(value.activity))
  )
    throw new Error("Unsupported PR Sitter snapshot; update backend and mod together");
  return value;
}

export function watchArgs(fields) {
  const pr = fields.pr.trim(),
    repo = fields.repo.trim();
  if (!pr || !repo) throw new Error("Supply a PR number/URL and a local checkout path");
  if (!/^[1-9]\d*$/.test(pr) && !pr.startsWith("https://"))
    throw new Error("Use a positive PR number or an HTTPS PR URL");
  const args = ["watch", pr, "--repo", repo];
  for (const key of ["model", "test", "interval"]) {
    const value = fields[key]?.trim();
    if (value) args.push(`--${key}`, value);
  }
  return args;
}

export function findBlock(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findBlock(child, id);
    if (found) return found;
  }
  return null;
}
