import { afterAll, describe, expect, test } from "bun:test";

import { rasterizeSvgToPng } from "../src/native-raster";

const FILES_ENV = "OPENGENI_ARTIFACT_RASTER_FONT_FILES";
const FAMILY_ENV = "OPENGENI_ARTIFACT_RASTER_DEFAULT_FONT_FAMILY";
const previousFiles = process.env[FILES_ENV];
const previousFamily = process.env[FAMILY_ENV];

afterAll(() => {
  restoreEnvironment(FILES_ENV, previousFiles);
  restoreEnvironment(FAMILY_ENV, previousFamily);
});

describe("native raster font authority", () => {
  test("fails closed when an explicit font file is unavailable", async () => {
    process.env[FILES_ENV] = JSON.stringify(["/definitely-missing/opengeni-font.ttf"]);
    process.env[FAMILY_ENV] = "Missing Test Font";

    await expect(
      rasterizeSvgToPng(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>proof</text></svg>',
      ),
    ).rejects.toThrow();
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
