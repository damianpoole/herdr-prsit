import type { Snapshot, State } from "./types.js";

// Reactions carry no commit SHA. Require a new, observed review cycle after
// establishing the head baseline; never infer approval from an existing thumb.
export function observeCodexReview(s: Snapshot, state: State) {
  if (!s.codexReactions) return;
  const previous = state.codexReview;
  const seen = new Set(previous?.seen ?? []);
  const changed = previous?.head !== s.head;
  let cycle = changed ? undefined : previous?.cycle;
  if (!changed) {
    const eyes = s.codexReactions
      .filter((r) => r.content === "eyes" && !seen.has(r.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (eyes)
      cycle = {
        eyes: eyes.id,
        source: eyes.source,
        startedAt: eyes.createdAt,
        excluded: [...new Set([...seen, ...s.codexReactions.map((r) => r.id)])],
      };
  }
  for (const reaction of s.codexReactions) seen.add(reaction.id);
  state.codexReview = { head: s.head, seen: [...seen], cycle };
}

export function codexReviewBlocker(s: Snapshot, state: State): string | undefined {
  const evidence = state.codexReview;
  const cycle = evidence?.cycle;
  if (!s.codexReactions) return "Codex review reactions unavailable";
  if (s.codexReactions.some((r) => r.content === "eyes")) return "Codex review is in progress";
  const summary = s.codexSummary;
  if (summary?.head === s.head) {
    if (summary.status !== "completed" || !summary.clean)
      return "Waiting for Codex to complete review without findings";
    const requestedAt = Date.parse(s.codexRequestedAt ?? "");
    const completedAt = Date.parse(summary.completedAt ?? "");
    if (
      state.codexReviewRequest?.head === s.head &&
      state.codexReviewRequest.phase === "requested" &&
      completedAt > requestedAt &&
      s.codexReactions.some((r) => r.content === "+1" && Date.parse(r.createdAt) > requestedAt)
    )
      return undefined;
  }
  if (evidence?.head !== s.head || !cycle)
    return "Waiting to observe a fresh Codex review (eyes then thumbs-up)";
  const approved = s.codexReactions.some(
    (r) =>
      r.content === "+1" &&
      r.source === cycle.source &&
      !cycle.excluded.includes(r.id) &&
      Date.parse(r.createdAt) > Date.parse(cycle.startedAt),
  );
  if (!approved) return "Waiting for a fresh Codex thumbs-up after the observed review";
  return undefined;
}
