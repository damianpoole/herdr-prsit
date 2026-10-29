import test from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../dist/github.js";
const w = { host: "github.com", owner: "o", repo: "r", number: 1 };
test("thread and nested comment pagination are complete", async () => {
  const gh = new GitHub(w);
  let pages = 0,
    nested = 0;
  gh.graphql = async (query, vars) => {
    if (vars.id) {
      nested++;
      return {
        node: {
          comments: { nodes: [{ id: "c2", body: "second" }], pageInfo: { hasNextPage: false } },
        },
      };
    }
    pages++;
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: vars.cursor ? "two" : "one",
                isResolved: false,
                comments: {
                  nodes: [{ id: "c1", body: "first" }],
                  pageInfo: { hasNextPage: !vars.cursor, endCursor: "nested" },
                },
              },
            ],
            pageInfo: { hasNextPage: !vars.cursor, endCursor: "outer" },
          },
        },
      },
    };
  };
  const threads = await gh.threads();
  assert.equal(threads.length, 2);
  assert.equal(threads[0].comments.nodes.length, 2);
  assert.equal(pages, 2);
  assert.equal(nested, 1);
});
test("replayed thread response does not post twice, but retries resolution", async () => {
  const gh = new GitHub(w);
  const comments = [];
  let resolved = false,
    posts = 0,
    resolutions = 0;
  gh.threads = async () => [
    { id: "thread", isResolved: resolved, viewerCanResolve: true, comments: { nodes: comments } },
  ];
  gh.api = async (_p, body) => {
    posts++;
    comments.push(body);
  };
  gh.graphql = async () => {
    resolutions++;
    if (resolutions === 1) throw new Error("network lost");
    resolved = true;
    return {};
  };
  const item = { kind: "thread", threadId: "thread", commentId: 12 };
  await assert.rejects(() => gh.respond(item, "Fixed", true, "operation"), /network lost/);
  await gh.respond(item, "Fixed", true, "operation");
  assert.equal(posts, 1);
  assert.equal(resolutions, 2);
});
test("lack of resolution permission never silently marks feedback resolved", async () => {
  const gh = new GitHub(w);
  gh.threads = async () => [
    {
      id: "t",
      isResolved: false,
      viewerCanResolve: false,
      comments: { nodes: [{ body: "<!-- herdr-prsit:op -->" }] },
    },
  ];
  await assert.rejects(
    () => gh.respond({ kind: "thread", threadId: "t" }, "Fixed", true, "op"),
    /does not permit/,
  );
});
