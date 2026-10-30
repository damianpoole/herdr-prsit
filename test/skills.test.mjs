import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { skillCatalog } from "../dist/skills.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "prsit-skills-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = ["worktree", "checkout", "home", "pi", "codex"].map((p) => join(dir, p));
  async function skill(root, path, name, description = name, extra = "") {
    const file = join(root, path, "SKILL.md");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `---\nname: ${name}\ndescription: ${description}\n${extra}---\nPRIVATE BODY\n`,
    );
    return file;
  }
  return { args, skill, catalog: () => skillCatalog(...args) };
}

test("discovers all standard repo/global roots and hidden bundled skills with absolute paths", async (t) => {
  const {
    args: [worktree, checkout, home, pi, codex],
    skill,
    catalog,
  } = await fixture(t);
  const roots = [
    ...[worktree, checkout].flatMap((base) =>
      [".pi", ".agents", ".codex", ".claude"].map((p) => join(base, p, "skills")),
    ),
    join(pi, "skills"),
    join(home, ".agents", "skills"),
    join(codex, "skills"),
    join(home, ".claude", "skills"),
  ];
  const files = [];
  for (const [i, root] of roots.entries())
    files.push(await skill(root, `nested/skill-${i}`, `skill-${i}`));
  files.push(await skill(codex, "skills/.system/bundled", "bundled"));
  const result = catalog();
  for (const file of files) assert.ok(result.prompt.includes(file), file);
  assert.ok(result.prompt.includes("Use the read tool"));
  assert.ok(!result.prompt.includes("PRIVATE BODY"));
  assert.deepEqual(result.warnings, []);
});

test("worktree wins over checkout and global duplicates; distinct checkout skills remain available", async (t) => {
  const {
    args: [worktree, checkout, , pi],
    skill,
    catalog,
  } = await fixture(t);
  await skill(pi, "skills/duplicate", "duplicate", "global version");
  await skill(checkout, ".agents/skills/duplicate", "duplicate", "checkout version");
  const winner = await skill(worktree, ".agents/skills/duplicate", "duplicate", "worktree version");
  await skill(checkout, ".agents/skills/local-only", "local-only");
  const result = catalog();
  assert.ok(result.prompt.includes(winner));
  assert.ok(result.prompt.includes("local-only"));
  assert.ok(!result.prompt.includes("global version"));
  assert.ok(!result.prompt.includes("checkout version"));
  assert.equal(result.warnings.filter((s) => s.includes("collision")).length, 2);
  assert.deepEqual(catalog(), result);
});

test("symlink aliases and cycles terminate and do not duplicate skills", async (t) => {
  const {
    args: [worktree, checkout],
    skill,
    catalog,
  } = await fixture(t);
  const root = join(worktree, ".agents/skills");
  await skill(root, "one", "one");
  await symlink(root, join(root, "cycle"));
  await symlink(join(root, "missing"), join(root, "broken"));
  await mkdir(join(checkout, ".agents"), { recursive: true });
  await symlink(root, join(checkout, ".agents/skills"));
  const result = catalog();
  assert.equal((result.prompt.match(/<name>one<\/name>/g) || []).length, 1);
  assert.deepEqual(result.warnings, []);
});

test("self-referential symlinks warn without suppressing later sibling skills", async (t) => {
  const {
    args: [worktree],
    skill,
    catalog,
  } = await fixture(t);
  const root = join(worktree, ".agents/skills");
  const valid = await skill(root, "z-valid", "z-valid");
  const loop = join(root, "a-loop");
  await symlink("a-loop", loop);
  const result = catalog();
  assert.ok(result.prompt.includes(valid));
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].startsWith(`${loop}: `));
  assert.match(result.warnings[0], /ELOOP/);
});

test("only SKILL.md entrypoints are loaded, including symlinked files", async (t) => {
  const {
    args: [worktree, , home, pi],
    skill,
    catalog,
  } = await fixture(t);
  const root = join(pi, "skills");
  await mkdir(root, { recursive: true });
  const shared = await skill(home, "shared", "shared");
  const alias = join(root, "shared", "SKILL.md");
  await mkdir(dirname(alias), { recursive: true });
  await symlink(shared, alias);
  await symlink(shared, join(root, "shared.md"));
  await symlink(shared, join(root, "not-markdown.txt"));
  await writeFile(join(root, "plain.md"), "---\nname: plain\ndescription: Plain skill\n---\n");
  const nested = await skill(home, "nested", "nested");
  const nestedRoot = join(worktree, ".pi/skills/subdir");
  await mkdir(nestedRoot, { recursive: true });
  await symlink(nested, join(nestedRoot, "nested.md"));
  const result = catalog();
  assert.equal((result.prompt.match(/<name>shared<\/name>/g) || []).length, 1);
  assert.ok(result.prompt.includes(alias));
  assert.ok(!result.prompt.includes(join(root, "shared.md")));
  assert.ok(!result.prompt.includes("<name>nested</name>"));
  assert.ok(!result.prompt.includes("<name>plain</name>"));
  assert.deepEqual(result.warnings, []);
});

test("missing roots, malformed metadata, opt-out, XML escaping and skill boundaries", async (t) => {
  const {
    args: [worktree],
    skill,
    catalog,
  } = await fixture(t);
  assert.deepEqual(catalog(), { prompt: "", warnings: [] });
  await skill(worktree, ".pi/skills/bad", "bad", "");
  await skill(
    worktree,
    ".pi/skills/hidden",
    "hidden",
    "Hidden",
    "disable-model-invocation: true\n",
  );
  await skill(worktree, ".pi/skills/visible", "visible", "A < B & C");
  await skill(worktree, ".pi/skills/visible/reference", "reference");
  const result = catalog();
  assert.ok(result.prompt.includes("A &lt; B &amp; C"));
  assert.ok(!result.prompt.includes("<name>bad</name>"));
  assert.ok(!result.prompt.includes("<name>hidden</name>"));
  assert.ok(!result.prompt.includes("<name>reference</name>"));
  assert.ok(result.warnings.some((s) => s.includes("description")));
});
