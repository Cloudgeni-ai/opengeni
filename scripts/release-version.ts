import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function readReleaseVersion(chartPath: string): Promise<string> {
  const source = await readFile(resolve(chartPath), "utf8");
  const chart = Bun.YAML.parse(source) as Record<string, unknown> | null;
  if (!chart || chart.name !== "opengeni") {
    throw new Error("release chart must be named opengeni");
  }
  if (typeof chart.version !== "string" || !versionPattern.test(chart.version)) {
    throw new Error("release chart version must be exact semver");
  }
  if (chart.appVersion !== chart.version) {
    throw new Error("source chart appVersion must equal its release version");
  }
  return chart.version;
}

if (import.meta.main) {
  const [chartPath, ...extra] = process.argv.slice(2);
  if (!chartPath || extra.length > 0) {
    throw new Error("usage: bun scripts/release-version.ts <Chart.yaml>");
  }
  console.log(await readReleaseVersion(chartPath));
}
