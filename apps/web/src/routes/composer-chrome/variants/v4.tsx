// 4 · Compact D — reserved stub for next compact chrome iteration.
import { VariantStub } from "../variant-stub";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 4,
  name: "Compact D",
};

export function Variant() {
  return <VariantStub meta={variantMeta} />;
}
