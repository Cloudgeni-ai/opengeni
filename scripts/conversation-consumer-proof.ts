/**
 * Prove that a product importing only the default conversation surfaces
 * (`OpenGeniProvider`, `SessionConversation`, `compiled.css`, and the SDK's
 * `createSessionProxyHandler`) builds with Next.js (Turbopack) and Vite while
 * NONE of @opengeni/react's optional peers are installed. Bundlers resolve
 * every reachable `import()` at build time, so an optional peer reachable from
 * these entrypoints breaks the host's build.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ConversationConsumerInput = {
  root: string;
  tarballs: { contracts: string; connect: string; sdk: string; react: string };
  reactManifest: {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    devDependencies?: Record<string, string>;
  };
  nextVersion?: string;
  run: (command: string[], cwd: string) => Promise<unknown>;
};

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const conversationSource = `import { OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniProvider, SessionConversation } from "@opengeni/react";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });

export function Assistant() {
  return (
    <OpenGeniProvider client={client} workspaceId="${WORKSPACE_ID}">
      <SessionConversation sessionId="${SESSION_ID}" />
    </OpenGeniProvider>
  );
}
`;

const proxySource = `import { OpenGeniClient, createSessionProxyHandler } from "@opengeni/sdk";

const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL ?? "http://127.0.0.1:1",
  apiKey: process.env.OPENGENI_API_KEY ?? "unused",
});
const handler = createSessionProxyHandler(og, {
  resolve: () => ({ workspaceId: "${WORKSPACE_ID}", user: "proof-user" }),
});
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
`;

export async function proveConversationConsumer(input: ConversationConsumerInput): Promise<void> {
  const { root, tarballs, reactManifest, run } = input;
  const optionalPeers = Object.entries(reactManifest.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional)
    .map(([name]) => name);
  const file = (path: string) => `file:${path}`;
  const manifest = {
    name: "opengeni-conversation-consumer-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      "build:next": "next build next-app",
      "build:vite": "vite build vite-app --logLevel warn",
    },
    dependencies: {
      "@opengeni/react": file(tarballs.react),
      "@opengeni/sdk": file(tarballs.sdk),
      next: input.nextVersion ?? "^16.0.0",
      react: reactManifest.peerDependencies?.react,
      "react-dom": reactManifest.peerDependencies?.["react-dom"],
    },
    devDependencies: {
      "@types/node": "^24.10.1",
      "@types/react": reactManifest.devDependencies?.["@types/react"],
      "@types/react-dom": reactManifest.devDependencies?.["@types/react-dom"],
      "@vitejs/plugin-react": reactManifest.devDependencies?.["@vitejs/plugin-react"],
      // Next.js verifies its TypeScript setup with a classic TypeScript 5 compiler.
      typescript: "^5.9.0",
      vite: reactManifest.devDependencies?.vite,
    },
    overrides: {
      "@opengeni/contracts": file(tarballs.contracts),
      "@opengeni/connect": file(tarballs.connect),
      "@opengeni/sdk": file(tarballs.sdk),
    },
  };
  const nextApp = join(root, "next-app");
  const viteApp = join(root, "vite-app");
  await mkdir(join(nextApp, "app", "api", "opengeni", "[...path]"), { recursive: true });
  await mkdir(join(viteApp, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    // Type checking belongs to the SDK/React proofs; this one proves bundling.
    writeFile(
      join(nextApp, "next.config.mjs"),
      "export default { typescript: { ignoreBuildErrors: true } };\n",
    ),
    writeFile(
      join(nextApp, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "preserve", strict: true, moduleResolution: "bundler", module: "esnext", target: "es2022", lib: ["dom", "esnext"], skipLibCheck: true, noEmit: true, allowJs: false, esModuleInterop: true, isolatedModules: true, incremental: false, resolveJsonModule: true, plugins: [{ name: "next" }] }, include: ["**/*.ts", "**/*.tsx"] }, null, 2)}\n`,
    ),
    writeFile(
      join(nextApp, "app", "layout.tsx"),
      'import "@opengeni/react/compiled.css";\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (<html lang="en"><body>{children}</body></html>);\n}\n',
    ),
    writeFile(join(nextApp, "app", "assistant.tsx"), `"use client";\n${conversationSource}`),
    writeFile(
      join(nextApp, "app", "page.tsx"),
      'import { Assistant } from "./assistant";\nexport default function Page() {\n  return <Assistant />;\n}\n',
    ),
    writeFile(join(nextApp, "app", "api", "opengeni", "[...path]", "route.ts"), proxySource),
    writeFile(
      join(viteApp, "vite.config.ts"),
      'import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [react()], build: { emptyOutDir: true } });\n',
    ),
    writeFile(
      join(viteApp, "index.html"),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    ),
    writeFile(join(viteApp, "src", "assistant.tsx"), conversationSource),
    writeFile(
      join(viteApp, "src", "main.tsx"),
      'import { createRoot } from "react-dom/client";\nimport "@opengeni/react/compiled.css";\nimport { Assistant } from "./assistant";\ncreateRoot(document.getElementById("root")!).render(<Assistant />);\n',
    ),
  ]);

  await run(["bun", "install"], root);
  const installed = optionalPeers.filter((name) =>
    existsSync(join(root, "node_modules", ...name.split("/"))),
  );
  if (installed.length > 0) {
    throw new Error(`Conversation consumer unexpectedly installed optional peers: ${installed}`);
  }
  await run(["bun", "run", "build:vite"], root);
  await run(["bun", "run", "build:next"], root);
}
