/**
 * The names a person sees. Opengeni's own build uses the defaults; a product
 * that ships its own branded build of this extension passes its brand to
 * `scripts/build.ts --brand`, which compiles it in.
 */
export type ExtensionBrand = {
  /** The extension's name, e.g. "Opengeni Browser". */
  name: string;
  /** The product people know the app and its agent by, e.g. "Opengeni". */
  product: string;
};

export const DEFAULT_BRAND: ExtensionBrand = { name: "Opengeni Browser", product: "Opengeni" };

// Set only by the build, as literals, so a branded bundle carries no other names.
declare const __EXTENSION_BRAND_NAME__: string | undefined;
declare const __EXTENSION_BRAND_PRODUCT__: string | undefined;

export const BRAND: ExtensionBrand = {
  name:
    typeof __EXTENSION_BRAND_NAME__ === "string" ? __EXTENSION_BRAND_NAME__ : DEFAULT_BRAND.name,
  product:
    typeof __EXTENSION_BRAND_PRODUCT__ === "string"
      ? __EXTENSION_BRAND_PRODUCT__
      : DEFAULT_BRAND.product,
};
