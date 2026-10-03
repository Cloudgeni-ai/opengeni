import { expect, test } from "bun:test";
import sharp from "sharp";
import { createModelImageSizer } from "../src/model-image-sizing";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";

const raster = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 32, g: 64, b: 96, alpha: 0.5 } },
  });

test.each(["png", "jpeg", "webp", "gif"] as const)(
  "%s small images preserve exact bytes and large images have a stable raster projection",
  async (format) => {
    const type = `image/${format}`;
    const small = (await raster(32, 16)[format]().toBuffer()).toString("base64");
    const large = (await raster(3072, 1536)[format]().toBuffer()).toString("base64");
    const size = createModelImageSizer(2000);
    expect((await size(small, type)).data).toBe(small);
    const first = await size(large, type);
    expect(first).toMatchObject({
      originalWidth: 3072,
      originalHeight: 1536,
      width: 2000,
      height: 1000,
    });
    expect(["image/png", "image/webp"]).toContain(first.mediaType);
    expect(first.data.length).toBeLessThanOrEqual(large.length);
    const metadata = await sharp(Buffer.from(first.data, "base64")).metadata();
    expect(metadata.width).toBe(2000);
    expect(metadata.height).toBe(1000);
    expect(await size(large, type)).toEqual(first);
    expect(await createModelImageSizer(2000)(large, type)).toEqual(first);
  },
);

test("portrait sizing preserves aspect ratio and transparent pixels", async () => {
  const image = await createModelImageSizer(2000)(
    (await raster(1536, 3072).png().toBuffer()).toString("base64"),
    "image/png",
  );
  expect(image.width).toBe(1000);
  expect(image.height).toBe(2000);
  expect((await sharp(Buffer.from(image.data, "base64")).metadata()).hasAlpha).toBe(true);
});

test("resizing applies EXIF orientation before stripping metadata", async () => {
  const bytes = await raster(3072, 1536).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const sized = await createModelImageSizer(2000)(bytes.toString("base64"), "image/jpeg");
  expect(sized).toMatchObject({
    originalWidth: 1536,
    originalHeight: 3072,
    width: 1000,
    height: 2000,
  });
  expect((await sharp(Buffer.from(sized.data, "base64")).metadata()).orientation).toBeUndefined();
});

test("high-entropy JPEG projections never grow individual or multi-image payloads", async () => {
  const pixels = Buffer.alloc(2100 * 2100 * 3);
  let seed = 17;
  for (let i = 0; i < pixels.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[i] = seed & 255;
  }
  const bytes = await sharp(pixels, { raw: { width: 2100, height: 2100, channels: 3 } })
    .jpeg({ quality: 50 })
    .toBuffer();
  const encoded = bytes.toString("base64");
  expect(encoded.length).toBeLessThan(10 * 1024 * 1024);
  const sized = await createModelImageSizer(2000)(encoded, "image/jpeg");
  expect(sized.mediaType).toBe("image/webp");
  expect(sized.data.length).toBeLessThanOrEqual(10 * 1024 * 1024);
  expect(sized.data.length).toBeLessThanOrEqual(encoded.length);
  expect(await createModelImageSizer(2000)(encoded, "image/jpeg")).toEqual(sized);
  const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async (_url, init) => {
    expect(String(init?.body).length).toBeLessThan(32_000_000);
    const sent = JSON.parse(String(init?.body));
    const images = sent.messages[0].content.filter((block: any) => block.type === "image");
    expect(images).toHaveLength(10);
    for (const image of images) expect(image.source.data).toBe(sized.data);
    return response();
  }) as typeof fetch);
  await model.getResponse(
    request([
      {
        role: "user",
        content: Array.from({ length: 10 }, () => ({
          type: "input_image",
          image: `data:image/jpeg;base64,${encoded}`,
        })),
      },
    ]),
  );
}, 30_000);

test("invalid and active formats fail before entering other image decoders", async () => {
  const size = createModelImageSizer(2000);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"/>',
  ).toString("base64");
  await expect(size(svg, "image/svg+xml")).rejects.toThrow("Model image could not be decoded");
  await expect(size(svg, "image/png")).rejects.toThrow("Model image could not be decoded");
  await expect(size("aGVsbG8=", "image/png")).rejects.toThrow("Model image could not be decoded");
  expect(() => createModelImageSizer(0)).toThrow(RangeError);
});

const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://example.test/v1",
  apiKey: "synthetic-key",
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
};
const response = () =>
  Response.json({
    id: "msg_synthetic",
    content: [{ type: "text", text: "Done" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
const request = (input: ModelRequest["input"]): ModelRequest => ({
  input,
  systemInstructions: "Synthetic instructions",
  modelSettings: { reasoning: { effort: "high" } },
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
});
const unmarked = (blocks: any[]) => blocks.map(({ cache_control: _cache, ...block }) => block);

test("20 to 21 images never changes the previous projected prefix, even in a new model instance", async () => {
  const large = (await raster(3072, 1536).png().toBuffer()).toString("base64");
  const small = (await raster(32, 16).png().toBuffer()).toString("base64");
  const bodies: any[] = [];
  const transport = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const images = body.messages[0].content.filter((block: any) => block.type === "image");
    for (const image of images) {
      const metadata = await sharp(Buffer.from(image.source.data, "base64")).metadata();
      expect(metadata.width).toBeLessThanOrEqual(2000);
      expect(metadata.height).toBeLessThanOrEqual(2000);
    }
    bodies.push(body);
    return response();
  }) as typeof fetch;
  const input = (count: number) => [
    {
      type: "message" as const,
      role: "user" as const,
      content: Array.from({ length: count }, (_, index) => ({
        type: "input_image" as const,
        image: `data:image/png;base64,${index === 0 ? large : small}`,
      })),
    },
  ];
  const first = request(input(20));
  const next = request(input(21));
  const canonical = JSON.stringify([first, next]);
  const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", transport);
  await model.getResponse(first);
  await model.getResponse(next);
  await new AnthropicMessagesModel(provider, "claude-opus-5-5", transport).getResponse(next);
  const prefix = unmarked(bodies[0].messages[0].content);
  expect(unmarked(bodies[1].messages[0].content).slice(0, prefix.length)).toEqual(prefix);
  expect(bodies[2].messages).toEqual(bodies[1].messages);
  expect(bodies[1].system).toEqual(bodies[0].system);
  expect(bodies[1].thinking).toEqual(bodies[0].thinking);
  expect(bodies[1].output_config).toEqual(bodies[0].output_config);
  expect(JSON.stringify([first, next])).toBe(canonical);
});

test("nested tool images preserve pairing, signed thinking, coordinate mapping and cache boundaries", async () => {
  const image = (await raster(3072, 1536).png().toBuffer()).toString("base64");
  let sent: any;
  const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return response();
  }) as typeof fetch);
  const signed = {
    type: "thinking",
    thinking: "Synthetic signed content",
    signature: "synthetic-signature",
  };
  const req = request([
    { role: "user", content: [{ type: "input_image", image: `data:image/png;base64,${image}` }] },
    { type: "reasoning", providerData: { anthropic: { block: signed } } },
    { type: "function_call", name: "inspect", callId: "call_synthetic", arguments: "{}" },
    {
      type: "function_call_result",
      callId: "call_synthetic",
      output: [{ type: "input_image", image: `data:image/png;base64,${image}` }],
    },
  ] as any);
  const before = JSON.stringify(req);
  await model.getResponse(req);
  const toolResult = sent.messages.at(-1).content[0];
  expect(toolResult.tool_use_id).toBe("call_synthetic");
  expect(toolResult.content[0].source.media_type).toBe("image/png");
  expect(toolResult.content[1].text).toContain("original 3072x1536; encoded image 2000x1000");
  expect(toolResult.content[1].text).toContain("any further provider resizing");
  expect(toolResult.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  expect(sent.messages[1].content[0]).toEqual(signed);
  expect(sent.messages[0].content[0].cache_control).toBeUndefined();
  expect(sent.messages[0].content[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  expect(JSON.stringify(req)).toBe(before);
});

test("URL sources remain unchanged without application-side fetching", async () => {
  let sent: any;
  const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return response();
  }) as typeof fetch);
  await model.getResponse(
    request([
      { role: "user", content: [{ type: "input_image", image: "https://example.test/image.png" }] },
    ]),
  );
  expect(sent.messages[0].content[0].source).toEqual({
    type: "url",
    url: "https://example.test/image.png",
  });
});
