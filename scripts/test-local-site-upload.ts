import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";

const api = process.env.SITE_TEST_API ?? "http://127.0.0.1:8000";
const workspaceId = process.env.SITE_TEST_WORKSPACE;
if (!workspaceId) throw new Error("Set SITE_TEST_WORKSPACE");
const base = `${api}/v1/workspaces/${workspaceId}/published-artifacts`;
async function json(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
for (const withSource of [false, true]) {
  const upload = await json(`${base}/uploads`, {});
  const html =
    "<!doctype html><html><body><h1>Large Site upload works</h1><button onclick=\"this.textContent='PASS'\">Test interaction</button></body></html><!--" +
    "x".repeat(13_000_000) +
    "-->";
  const source = {
    entrypoint: "src/main.tsx",
    files: [
      { path: "src/main.tsx", content: "export default () => <h1>Large Site upload works</h1>;" },
    ],
  };
  const put = async (
    target: { putUrl: string; requiredHeaders: Record<string, string> },
    body: string,
  ) => {
    const response = await fetch(target.putUrl, {
      method: "PUT",
      headers: target.requiredHeaders,
      body,
    });
    if (!response.ok) throw new Error(`PUT ${response.status}: ${await response.text()}`);
  };
  await put(upload.html, html);
  if (withSource) await put(upload.source, JSON.stringify(source));
  const body = {
    uploadId: upload.uploadId,
    title: withSource ? "Large Site with source" : "Large HTML-only Site",
    idempotencyKey: crypto.randomUUID(),
    requestedTools: [],
  };
  const result = await json(base, body);
  const replay = await json(base, body);
  if (!replay.replayed || replay.version.id !== result.version.id)
    throw new Error("Retry created a different version");
  const downloads = await json(`${base}/${result.artifact.id}/downloads`);
  if ((await (await fetch(downloads.html.url)).text()) !== html)
    throw new Error("HTML download mismatch");
  if (withSource) {
    if (JSON.stringify(await (await fetch(downloads.source.url)).json()) !== JSON.stringify(source))
      throw new Error("Source download mismatch");
  } else if (downloads.source !== null)
    throw new Error("HTML-only Site unexpectedly requires source");
  await put(upload.html, "<h1>Overwrite attempt</h1>");
  if ((await (await fetch(downloads.html.url)).text()) !== html)
    throw new Error("Published version was overwritten");
  const rendered = await fetch(`${base}/${result.artifact.id}/html?versionId=${result.version.id}`);
  if ((await rendered.text()) !== html) throw new Error("HTML serving mismatch");
  console.log(
    JSON.stringify({
      pass: true,
      withSource,
      bytes: result.version.sizeBytes,
      artifactId: result.artifact.id,
    }),
  );
}
