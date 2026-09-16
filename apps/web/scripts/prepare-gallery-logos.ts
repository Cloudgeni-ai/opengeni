import { resolve } from "node:path";
const repoRoot = resolve(import.meta.dirname, "../../..");
const assets = {
  linear: "linear-app-4b4a9f349c60.png",
  slack: "slack-com-5a15dccc0dc0.jpg",
  notion: "notion-com-3b56ae2f8166.png",
};
const logos: Record<string, string> = {};
for (const [id, file] of Object.entries(assets)) {
  const bytes = await Bun.file(resolve(repoRoot, "data/catalog/logos", file)).arrayBuffer();
  logos[id] =
    `data:image/${file.endsWith("png") ? "png" : "jpeg"};base64,${Buffer.from(bytes).toString("base64")}`;
}
await Bun.write(
  resolve(repoRoot, "apps/web/src/component-gallery/catalog-logos.ts"),
  `// Generated from the repository's data/catalog/logos artwork by prepare-gallery-logos.ts.\nexport const catalogLogos = ${JSON.stringify(logos, null, 2)} as const;\n`,
);
console.log("Prepared three repository connector logos.");
