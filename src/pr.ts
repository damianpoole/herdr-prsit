import { parsePR } from "./github.js";
import { exec } from "./io.js";

export async function resolvePR(target: string, path = process.cwd()) {
  if (target.startsWith("https://")) return parsePR(target);
  if (!/^[0-9]+$/.test(target) || !Number.isSafeInteger(Number(target)) || Number(target) < 1)
    throw new Error("Supply a positive PR number or full HTTPS PR URL");
  let root: string;
  try {
    root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: path })).stdout.trim();
  } catch {
    throw new Error(
      "A PR number needs a local checkout. Run inside its repository or pass --repo <path>.",
    );
  }
  // Resolve gh's default repository from this checkout, never an unrelated GH_REPO override.
  const { stdout } = await exec("gh", ["repo", "view", "--json", "url"], {
    cwd: root,
    env: { GH_REPO: undefined },
  });
  const { url } = JSON.parse(stdout);
  return parsePR(`${url}/pull/${Number(target)}`);
}
