import { sha256Hex } from "@opengeni/contracts/values";

import type { Presentation, PresentationElement } from "./presentation";

export { sha256Hex };

export async function presentationModelDigest(presentation: Presentation): Promise<string> {
  const imageDigests: Array<{ id: string; digest: string }> = [];
  const visit = async (element: PresentationElement): Promise<void> => {
    if ("sourceForSvg" in element) {
      imageDigests.push({
        id: element.id,
        digest: await sha256Hex(new TextEncoder().encode(element.sourceForSvg() ?? "")),
      });
    } else if ("children" in element) {
      for (const child of element.children) await visit(child);
    }
  };
  for (const slide of presentation.slides.items) {
    for (const element of slide.elements) await visit(element);
  }
  const normalized = await normalizeDigestValue({
    layout: presentation.layoutSnapshot(),
    imageDigests,
  });
  return await sha256Hex(new TextEncoder().encode(JSON.stringify(normalized)));
}

async function normalizeDigestValue(value: unknown): Promise<unknown> {
  if (value instanceof Uint8Array) return { $bytes: await sha256Hex(value) };
  if (value instanceof ArrayBuffer) return { $bytes: await sha256Hex(new Uint8Array(value)) };
  if (Array.isArray(value)) return await Promise.all(value.map(normalizeDigestValue));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = await normalizeDigestValue(child);
    }
    return output;
  }
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}
