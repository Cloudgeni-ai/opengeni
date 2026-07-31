// 2 · Compact B — reserved stub for next compact chrome iteration.
import { VariantStub } from "../variant-stub";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 2,
  name: "Compact B",
};

export function Variant() {
  return <VariantStub meta={variantMeta} />;
}
