import { Manifest, type SandboxSessionLike } from "@openai/agents/sandbox";
import { isDeepStrictEqual } from "node:util";

/** Record already-materialized directory placeholders after lazy setup. This is
 * not manifest application: never change environment, permissions, grants,
 * mounts, files, or existing entries. Non-placeholder deltas remain visible to
 * the SDK's normal validation/invalidation path. */
export async function recordLazyMaterializedDirectories(
  session: SandboxSessionLike,
  target: Manifest,
): Promise<void> {
  const current = session.state.manifest;
  const { entries: currentEntries, ...currentMetadata } = current;
  const { entries: targetEntries, ...targetMetadata } = target;
  if (!isDeepStrictEqual(currentMetadata, targetMetadata) || !session.listDir) return;
  const additions = Object.entries(targetEntries).filter(([path]) => !(path in currentEntries));
  if (
    Object.entries(currentEntries).some(
      ([path, entry]) => path in targetEntries && !isDeepStrictEqual(entry, targetEntries[path]),
    )
  )
    return;
  // A plain directory is the logical placeholder for a repository cloned by
  // setup. Rich directories, sources and permissions require SDK materialization.
  const emptyDirectory = new Manifest({ entries: { placeholder: { type: "dir" } } }).entries
    .placeholder;
  if (additions.some(([, entry]) => !isDeepStrictEqual(entry, emptyDirectory))) return;
  // iterEntries validates every logical path before any live filesystem access.
  const paths = new Map([...target.iterEntries()].map((entry) => [entry.logicalPath, entry]));
  const directories = new Map<
    string,
    Awaited<ReturnType<NonNullable<SandboxSessionLike["listDir"]>>>
  >();
  for (const [path] of additions) {
    let directory = target.root;
    // Listing the target itself follows symlinks on some adapters. Walk every
    // ancestor through its parent's typed listing instead, exactly like the
    // repository reader. Cache only these invocation-local parent listings.
    for (const name of paths.get(path)!.logicalPath.split("/")) {
      let entries = directories.get(directory);
      if (!entries) {
        entries = await session.listDir({ path: directory });
        directories.set(directory, entries);
      }
      if (!entries.some((entry) => entry.name === name && entry.type === "dir")) return;
      directory = `${directory.replace(/\/$/, "")}/${name}`;
    }
  }
  // Do not overwrite a concurrent manifest update.
  if (session.state.manifest !== current || additions.length === 0) return;
  session.state.manifest = new Manifest({
    ...current,
    entries: { ...currentEntries, ...targetEntries },
  });
}
