import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { resolveSiteClientScript, SITE_CLIENT_SCRIPT_PATH } from "./site-document";

const tag = `<script src="${SITE_CLIENT_SCRIPT_PATH}"></script>`;

test("ordinary bundled Sites remain byte-identical", () => {
  const html =
    '<!doctype html><script type="module">const client = "bundled SDK";</script><main>React</main>';
  expect(resolveSiteClientScript(html)).toBe(html);
  const comment = `<!-- ${tag} -->`;
  expect(resolveSiteClientScript(comment)).toBe(comment);
  const sample = `<script>const example = '<script src="${SITE_CLIENT_SCRIPT_PATH}"><\\/script>';</script>`;
  expect(resolveSiteClientScript(sample)).toBe(sample);
});

test("optional script preserves document order and exposes the existing client", () => {
  const html = `<!doctype html><title>Preview</title>${tag}<script>globalThis.authorRan = true</script>`;
  const result = resolveSiteClientScript(html);
  expect(result.startsWith("<!doctype html><title>Preview</title><script>")).toBe(true);
  expect(result.endsWith("<script>globalThis.authorRan = true</script>")).toBe(true);
  const script = result.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const context: Record<string, unknown> = {
    URL,
    Request,
    Response,
    Headers,
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(script, context);
  expect(typeof context.createOpenGeniSiteClient).toBe("function");
});

test("optional client uses the existing local catalog transport", async () => {
  const html = resolveSiteClientScript(tag);
  const calls: string[] = [];
  const window: Record<string, unknown> = {};
  window.parent = window;
  const context: Record<string, any> = {
    window,
    URL,
    Request,
    Response,
    Headers,
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    fetch: async (url: string) => {
      calls.push(url);
      return Response.json({ version: 1, generation: 1, digest: "test", entries: [] });
    },
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  const client = context.createOpenGeniSiteClient();
  await client.tools.$catalog();
  expect(calls).toEqual(["/__opengeni/site-tools/catalog"]);
  client.close();
});
