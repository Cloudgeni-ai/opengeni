// 1 · Compact A — reserved stub for next compact chrome iteration.
import { VariantStub } from "../variant-stub";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 1,
  name: "Compact A",
};

export function Variant() {
  return <VariantStub meta={variantMeta} />;
}
