import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
const base = process.argv[2];
if (!base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("Pass this worktree's local API URL");
const headers = {
  "content-type": "application/json",
  [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
};
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
const [workspace] = await request("/v1/workspaces");
const prefix = `/v1/workspaces/${workspace.id}/published-artifacts`;
const html = Bun.file(`${import.meta.dir}/dist/index.html`);
const source = {
  entrypoint: "index.html",
  files: await Promise.all(
    ["index.html", "main.tsx", "style.css", "server.ts", "package.json"].map(async (path) => ({
      path,
      content: await Bun.file(`${import.meta.dir}/${path}`).text(),
    })),
  ),
};
const upload = await request(`${prefix}/uploads`, {
  method: "POST",
  body: "{}",
});
async function put(
  target: { putUrl: string; requiredHeaders: Record<string, string> },
  body: BodyInit,
) {
  const response = await fetch(target.putUrl, {
    method: "PUT",
    headers: target.requiredHeaders,
    body,
  });
  if (!response.ok) throw new Error(`Upload ${response.status}: ${await response.text()}`);
}
await put(upload.html, html);
await put(upload.source, JSON.stringify(source));
const payload = {
  title: "SDK session embed test",
  description: "Standard React timeline and composer, running inside a Site.",
  uploadId: upload.uploadId,
  requestedTools: [],
  idempotencyKey: crypto.randomUUID(),
};
const result = await request(prefix, {
  method: "POST",
  body: JSON.stringify(payload),
});
console.log(JSON.stringify({ workspaceId: workspace.id, artifactId: result.artifact.id }));
