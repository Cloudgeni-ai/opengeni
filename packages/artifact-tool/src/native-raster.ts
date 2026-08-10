const FONT_FILES_ENV = "OPENGENI_ARTIFACT_RASTER_FONT_FILES";
const DEFAULT_FONT_FAMILY_ENV = "OPENGENI_ARTIFACT_RASTER_DEFAULT_FONT_FAMILY";
const MAX_FONT_FILES = 16;
const MAX_FONT_FILE_BYTES = 32 * 1024 * 1024;

type ResvgOptions = {
  background?: string;
  fitTo?: { mode: "zoom"; value: number };
  font: {
    defaultFontFamily?: string;
    fontFiles?: string[];
    loadSystemFonts: boolean;
  };
};

type ResvgRuntime = {
  Resvg: new (svg: string, options: ResvgOptions) => { render(): { asPng(): Uint8Array } };
};

type FontAuthority = ResvgOptions["font"];

let cachedFontAuthority: { key: string; value: Promise<FontAuthority> } | undefined;

/**
 * Rasterize with an explicit font authority when the host configures one.
 * Resvg otherwise succeeds while silently dropping every glyph on minimal
 * Linux images. Sandboxes pin regular/bold/italic-capable Liberation faces;
 * desktop installs retain their native system-font fallback.
 */
export async function rasterizeSvgToPng(
  svg: string,
  options: Readonly<{ background?: string; zoom?: number }> = {},
): Promise<Uint8Array> {
  const [{ Resvg }, font] = await Promise.all([
    importNativeRuntime<ResvgRuntime>("@resvg/resvg-js"),
    rasterFontAuthority(),
  ]);
  const resvgOptions: ResvgOptions = {
    ...(options.background === undefined ? {} : { background: options.background }),
    ...(options.zoom === undefined
      ? {}
      : { fitTo: { mode: "zoom" as const, value: options.zoom } }),
    font,
  };
  return Uint8Array.from(new Resvg(svg, resvgOptions).render().asPng());
}

async function importNativeRuntime<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

async function rasterFontAuthority(): Promise<FontAuthority> {
  const environment = typeof process === "undefined" ? undefined : process.env;
  const filesJson = environment?.[FONT_FILES_ENV];
  const defaultFontFamily = environment?.[DEFAULT_FONT_FAMILY_ENV];
  if (filesJson === undefined && defaultFontFamily === undefined) {
    return { loadSystemFonts: true };
  }
  if (
    !filesJson ||
    filesJson.length > 8_192 ||
    !defaultFontFamily?.trim() ||
    defaultFontFamily.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(defaultFontFamily)
  ) {
    throw new Error(`${FONT_FILES_ENV} and ${DEFAULT_FONT_FAMILY_ENV} must be configured together`);
  }
  const key = `${filesJson}\u0000${defaultFontFamily}`;
  if (cachedFontAuthority?.key === key) return await cachedFontAuthority.value;
  const value = validateConfiguredFontAuthority(filesJson, defaultFontFamily.trim());
  cachedFontAuthority = { key, value };
  return await value;
}

async function validateConfiguredFontAuthority(
  filesJson: string,
  defaultFontFamily: string,
): Promise<FontAuthority> {
  let requested: unknown;
  try {
    requested = JSON.parse(filesJson);
  } catch {
    throw new Error(`${FONT_FILES_ENV} must be a JSON array of absolute font file paths`);
  }
  if (
    !Array.isArray(requested) ||
    requested.length === 0 ||
    requested.length > MAX_FONT_FILES ||
    requested.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    throw new Error(`${FONT_FILES_ENV} must contain 1-${MAX_FONT_FILES} font file paths`);
  }

  // Keep browser HTML/SVG render paths free of Node builtins. This function is
  // reached only by the native PNG/WebP branches with an explicit authority.
  const fileSystemSpecifier = "node:fs/promises";
  const pathSpecifier = "node:path";
  const [{ open, realpath, stat }, { isAbsolute }] = await Promise.all([
    import(/* @vite-ignore */ fileSystemSpecifier) as Promise<typeof import("node:fs/promises")>,
    import(/* @vite-ignore */ pathSpecifier) as Promise<typeof import("node:path")>,
  ]);
  const fontFiles = await Promise.all(
    requested.map(async (path) => {
      if (!isAbsolute(path)) throw new Error(`${FONT_FILES_ENV} paths must be absolute`);
      const canonical = await realpath(path);
      const metadata = await stat(canonical);
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_FONT_FILE_BYTES) {
        throw new Error(`Configured artifact raster font is not a bounded regular file: ${path}`);
      }
      const handle = await open(canonical, "r");
      try {
        const signature = new Uint8Array(4);
        const { bytesRead } = await handle.read(signature, 0, signature.byteLength, 0);
        const tag = new TextDecoder().decode(signature);
        if (
          bytesRead !== 4 ||
          (tag !== "OTTO" && tag !== "ttcf" && !sameBytes(signature, [0, 1, 0, 0]))
        ) {
          throw new Error(`Configured artifact raster font has an unsupported signature: ${path}`);
        }
      } finally {
        await handle.close();
      }
      return canonical;
    }),
  );
  if (new Set(fontFiles).size !== fontFiles.length) {
    throw new Error(`${FONT_FILES_ENV} must not contain duplicate files`);
  }
  return {
    defaultFontFamily,
    fontFiles,
    loadSystemFonts: false,
  };
}

function sameBytes(actual: Uint8Array, expected: readonly number[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}
