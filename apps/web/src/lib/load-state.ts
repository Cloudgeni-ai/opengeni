// The honest list-surface state machine shared by the console's list views
// (environments, packs, the queue rail, account sections). A failed load must
// never fall through to the empty state: "No X yet…" copy actively misguides
// when the request failed. Data already on screen keeps rendering; otherwise
// the error wins over everything, then the initial load, then true emptiness.
export type ListViewState = "ready" | "error" | "loading" | "empty";

export function listViewState(input: { loading: boolean; error: Error | null; count: number }): ListViewState {
  if (input.count > 0) {
    return "ready";
  }
  if (input.error) {
    return "error";
  }
  if (input.loading) {
    return "loading";
  }
  return "empty";
}
