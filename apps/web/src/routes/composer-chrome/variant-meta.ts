// Shared contract for composer-chrome gallery tabs.
// Variant agents may refine `name` via `export const variantMeta = { id, name }`.

export type VariantId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type VariantMeta = {
  id: VariantId;
  name: string;
};

export function tabLabel(meta: VariantMeta): string {
  return `${meta.id} · ${meta.name}`;
}
