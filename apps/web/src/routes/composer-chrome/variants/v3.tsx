// 3 · Compact C — reserved stub for next compact chrome iteration.
import { VariantStub } from "../variant-stub";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 3,
  name: "Compact C",
};

export function Variant() {
  return <VariantStub meta={variantMeta} />;
}
