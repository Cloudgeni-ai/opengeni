// Build to .release/publish-canary.mjs so the publisher's repository-relative
// roots remain unchanged. Package builds/packing still invoke pinned Bun.
import { main } from "./publish-canary";

await main();
