// 5 · Compact E — reserved stub for next compact chrome iteration.
import { VariantStub } from "../variant-stub";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 5,
  name: "Compact E",
};

export function Variant() {
  return <VariantStub meta={variantMeta} />;
}
