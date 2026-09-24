// Compiles the exact on-screen handler against the repository's current SDK
// source. Run: bun scripts/check-snippet.ts && bunx tsc -p snippet-check/tsconfig.json
import { mkdirSync, writeFileSync } from "node:fs";
import { CODE_SOURCE } from "../src/data/code";

// Not shown on screen: the product's own auth helper, as in the official snippet.
const prelude = `declare function authenticate(request: Request): Promise<{ accountId: string; userId: string; token: string }>;\n\n`;
mkdirSync(new URL("../out/snippet-check/", import.meta.url), { recursive: true });
writeFileSync(new URL("../out/snippet-check/snippet.ts", import.meta.url), prelude + CODE_SOURCE + "\n");
console.log("out/snippet-check/snippet.ts written");
