import { exec, hash } from "./io.js";
import { isCodexAuthor, codexStatus, reviewRequestBody } from "./codex-status.js";
import type { Watch, Snapshot, Feedback } from "./types.js";

type Obj = Record<string, any>;
const marker = "<!-- herdr-prsit:";
const codexRequest = (body: string) =>
  /^\s*@codex\s+review\s*(?:<!-- herdr-prsit:codex-review:[a-f0-9]+ -->\s*)?$/i.test(body);
export function parsePR(url: string) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (u.protocol !== "https:" || u.username || u.password || !m || !/^[\w.-]+$/.test(u.hostname))
    throw new Error("Expected an HTTPS GitHub PR URL");
  return {
    host: u.hostname,
    owner: m[1],
    repo: m[2],
    number: Number(m[3]),
    url: `https://${u.hostname}/${m[1]}/${m[2]}/pull/${m[3]}`,
  };
}
export class GitHub {
  constructor(readonly w: Watch) {}
  async api(path: string, body?: Obj): Promise<any> {
    const args = ["api", "--hostname", this.w.host, path];
    if (body) args.push("--method", "POST", "--input", "-");
    const result = await exec("gh", args, { input: body ? JSON.stringify(body) : undefined });
    return result.stdout ? JSON.parse(result.stdout) : undefined;
  }
  async pages(path: string): Promise<Obj[]> {
    const result = await exec("gh", [
      "api",
      "--hostname",
      this.w.host,
      "--paginate",
      "--slurp",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100`,
    ]);
    return JSON.parse(result.stdout).flat();
  }
  async graphql(query: string, variables: Obj = {}): Promise<Obj> {
    const result = await this.api("graphql", { query, variables });
    if (result.errors?.length) throw new Error(result.errors.map((e: Obj) => e.message).join("; "));
    return result.data;
  }
  async threads(): Promise<Obj[]> {
    const nodes: Obj[] = [];
    let cursor: string | null = null;
    do {
      const data: Obj = await this.graphql(
        `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
          reviewThreads(first:100,after:$cursor) { nodes { id isResolved isOutdated viewerCanResolve
            comments(first:100) { nodes { id databaseId body updatedAt author {login} } pageInfo {hasNextPage endCursor} }
          } pageInfo {hasNextPage endCursor} }
        } }
      }`,
        { ...this.w, cursor },
      );
      const connection = data.repository.pullRequest.reviewThreads;
      for (const thread of connection.nodes) {
        let page = thread.comments.pageInfo;
        while (page.hasNextPage) {
          const more = await this.graphql(
            `query($id:ID!,$cursor:String!) {node(id:$id) {... on PullRequestReviewThread {
            comments(first:100,after:$cursor) {nodes {id databaseId body updatedAt author {login}} pageInfo {hasNextPage endCursor}}
          }}}`,
            { id: thread.id, cursor: page.endCursor },
          );
          thread.comments.nodes.push(...more.node.comments.nodes);
          page = more.node.comments.pageInfo;
        }
        nodes.push(thread);
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return nodes;
  }
  async snapshot(): Promise<Snapshot> {
    const fields =
      "title,state,isDraft,headRefOid,headRefName,headRepository,headRepositoryOwner,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
    const [view, threads, comments, reviews] = await Promise.all([
      exec("gh", ["pr", "view", this.w.url, "--json", fields]),
      this.threads(),
      this.pages(`repos/${this.w.owner}/${this.w.repo}/issues/${this.w.number}/comments`),
      this.pages(`repos/${this.w.owner}/${this.w.repo}/pulls/${this.w.number}/reviews`),
    ]);
    const p = JSON.parse(view.stdout);
    const codex = this.w.requireCodexReview
      ? codexStatus(
          this.w,
          p.headRefOid,
          comments.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, user: c.user })),
        )
      : undefined;
    const codexReactions = this.w.requireCodexReview
      ? await this.codexReactions(comments)
      : undefined;
    const feedback: Feedback[] = [];
    for (const t of threads.filter((t) => !t.isResolved)) {
      const relevant = t.comments.nodes.filter((c: Obj) => !c.body.includes(marker));
      if (!relevant.length) continue;
      feedback.push({
        key: `thread:${t.id}`,
        fingerprint: hash(relevant.map((c: Obj) => [c.id, c.updatedAt, c.body])),
        kind: "thread",
        body: relevant.map((c: Obj) => `${c.author?.login ?? "deleted"}: ${c.body}`).join("\n\n"),
        threadId: t.id,
        commentId: Number(t.comments.nodes[0].databaseId),
        canResolve: t.viewerCanResolve,
      });
    }
    for (const c of comments.filter(
      (c) =>
        !c.body.includes(marker) &&
        !codex?.informational.has(c.id) &&
        !(this.w.requireCodexReview && codexRequest(c.body)),
    ))
      feedback.push({
        key: `comment:${c.id}`,
        fingerprint: hash([c.updated_at, c.body]),
        kind: "comment",
        body: `${c.user?.login}: ${c.body}`,
      });
    for (const r of reviews.filter((r) => r.body?.trim() && !r.body.includes(marker)))
      feedback.push({
        key: `review:${r.id}`,
        fingerprint: hash([r.state, r.body, r.submitted_at]),
        kind: "review",
        body: `${r.user?.login} (${r.state}): ${r.body}`,
      });
    const checks = (p.statusCheckRollup ?? []).map((c: Obj) => ({
      name: c.name ?? c.context,
      state: c.status === "COMPLETED" ? c.conclusion : (c.state ?? c.status),
      url: c.detailsUrl ?? c.targetUrl ?? "",
    }));
    for (const c of checks.filter((c: Obj) =>
      [
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "STALE",
      ].includes(c.state),
    )) {
      const key = `ci:${c.name}`;
      feedback.push({
        key,
        fingerprint: hash([p.headRefOid, c.name, c.state, c.url]),
        kind: "ci",
        body: `Check ${c.name}: ${c.state}\n${c.url}`,
      });
    }
    if (p.mergeable === "CONFLICTING")
      feedback.push({
        key: "conflict",
        fingerprint: hash([p.headRefOid, p.baseRefName]),
        kind: "conflict",
        body: `Merge conflicts with ${p.baseRefName}. The fetched base is refs/prsit/base/${this.w.id}. Merge that ref and resolve conflicts.`,
      });
    return {
      head: p.headRefOid,
      title: p.title,
      state: p.state,
      draft: p.isDraft,
      mergeable: p.mergeable,
      mergeState: p.mergeStateStatus,
      reviewDecision: p.reviewDecision ?? "",
      headBranch: p.headRefName,
      headRepo: `${p.headRepositoryOwner?.login}/${p.headRepository?.name}`,
      baseBranch: p.baseRefName,
      checks,
      feedback,
      codexReactions,
      codexSummary: codex?.summary,
      codexRequestedAt: codex?.requestedAt,
      unresolved: threads.filter((t) => !t.isResolved).map((t) => t.id),
    };
  }
  async codexReactions(comments: Obj[]): Promise<NonNullable<Snapshot["codexReactions"]>> {
    const base = `repos/${this.w.owner}/${this.w.repo}/issues`;
    const sources = [
      `${base}/${this.w.number}/reactions`,
      ...comments
        .filter((c) => codexRequest(c.body))
        .map((c) => `${base}/comments/${c.id}/reactions`),
    ];
    const pages = await Promise.all(
      sources.map(async (source) =>
        (await this.pages(source))
          .filter((r) => isCodexAuthor(r.user, this.w.host))
          .map((r) => ({ id: String(r.id), content: r.content, createdAt: r.created_at, source })),
      ),
    );
    return pages.flat();
  }
  async ciLogs(s: Snapshot): Promise<string> {
    const runs = new Set(
      s.checks
        .filter((c) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.state))
        .flatMap((c) => {
          const match = c.url.match(/\/actions\/runs\/(\d+)/);
          return match ? [match[1]] : [];
        }),
    );
    const logs: string[] = [];
    for (const id of runs) {
      try {
        logs.push(
          (
            await exec(
              "gh",
              [
                "run",
                "view",
                id,
                "--repo",
                `${this.w.host}/${this.w.owner}/${this.w.repo}`,
                "--log-failed",
              ],
              { timeout: 120_000 },
            )
          ).stdout.slice(-80_000),
        );
      } catch (e) {
        logs.push(`Could not fetch run ${id}: ${String(e)}`);
      }
    }
    return logs.join("\n").slice(-200_000);
  }
  async requestCodexReview(head: string) {
    const base = `repos/${this.w.owner}/${this.w.repo}`;
    const body = reviewRequestBody(this.w, head);
    const comments = await this.pages(`${base}/issues/${this.w.number}/comments`);
    // Check the live head even on replay. Never request a review for a superseded push.
    const pr = await this.api(`${base}/pulls/${this.w.number}`);
    if (pr.state !== "open" || pr.head?.sha !== head)
      throw new Error(
        `Cannot request Codex review: PR is closed or head changed (expected ${head}, observed ${pr.head?.sha})`,
      );
    if (!comments.some((c) => c.body === body))
      await this.api(`${base}/issues/${this.w.number}/comments`, { body });
  }
  async respond(item: Feedback, body: string, resolve: boolean, operation: string) {
    const stamp = `${marker}${operation} -->`;
    const full = `${body}\n\n${stamp}`;
    const base = `repos/${this.w.owner}/${this.w.repo}`;
    // Search GitHub before each write: a previous attempt may have succeeded before its checkpoint.
    if (item.kind === "thread") {
      const thread = (await this.threads()).find((t) => t.id === item.threadId);
      if (!thread) throw new Error(`Review thread disappeared: ${item.threadId}`);
      if (!thread.comments.nodes.some((c: Obj) => c.body.includes(stamp)))
        await this.api(`${base}/pulls/${this.w.number}/comments/${item.commentId}/replies`, {
          body: full,
        });
      if (resolve && !thread.isResolved) {
        if (!thread.viewerCanResolve)
          throw new Error("GitHub does not permit resolving this review thread");
        await this.graphql(
          "mutation($id:ID!) {resolveReviewThread(input:{threadId:$id}) {thread {isResolved}}}",
          { id: item.threadId },
        );
      }
    } else {
      const comments = await this.pages(`${base}/issues/${this.w.number}/comments`);
      if (!comments.some((c) => c.body.includes(stamp)))
        await this.api(`${base}/issues/${this.w.number}/comments`, { body: full });
    }
  }
  async merge(s: Snapshot) {
    await exec("gh", [
      "pr",
      "merge",
      this.w.url,
      `--${this.w.merge}`,
      "--match-head-commit",
      s.head,
    ]);
  }
}
