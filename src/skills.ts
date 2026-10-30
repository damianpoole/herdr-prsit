import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatSkillsForPrompt, getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";

/** Discover only skill resources: never initialize CLI extensions or provider sessions. */
export function skillCatalog(
  worktree: string,
  checkout: string,
  home = homedir(),
  agentDir = getAgentDir(),
  codexDir = process.env.CODEX_HOME || join(home, ".codex"),
) {
  const localRoots = (base: string) =>
    [".pi", ".agents", ".codex", ".claude"].map((dir) => join(base, dir, "skills"));
  const roots = [
    ...localRoots(worktree),
    ...localRoots(checkout),
    join(agentDir, "skills"),
    join(home, ".agents", "skills"),
    join(codexDir, "skills"),
    join(home, ".claude", "skills"),
  ];
  const files: string[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  function scan(path: string) {
    try {
      const canonical = realpathSync(path);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      if (!statSync(path).isDirectory()) return;
      const skill = join(path, "SKILL.md");
      if (statSync(skill, { throwIfNoEntry: false })?.isFile()) {
        files.push(skill);
        return;
      }
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const child = join(path, entry.name);
        const type = entry.isSymbolicLink() ? statSync(child, { throwIfNoEntry: false }) : entry;
        if (type?.isDirectory()) scan(child);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`${path}: ${(error as Error).message}`);
    }
  }
  for (const root of roots) scan(resolve(root));
  const result = loadSkills({ cwd: worktree, agentDir, skillPaths: files, includeDefaults: false });
  warnings.push(...result.diagnostics.map((d) => `${d.path}: ${d.message}`));
  return { prompt: formatSkillsForPrompt(result.skills), warnings };
}
