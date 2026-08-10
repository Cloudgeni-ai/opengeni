const path = require("node:path");
const upstream = require("@react-native/metro-babel-transformer");

const projectionSuffix = path.normalize("packages/react/src/timeline/projection.ts");
const correctedImport = 'import fleetDecisionItem from "./fleet-decision-projection";';
const oldTopLevelImport =
  'const { default: fleetDecisionItem } = await import("./fleet-decision-projection");';

module.exports = {
  ...upstream,
  getCacheKey() {
    const upstreamKey = upstream.getCacheKey?.() ?? "";
    return `${upstreamKey}:opengeni-hermes-plant:${process.env.OPENGENI_PLANT_HERMES_TLA ?? "0"}`;
  },
  transform(input) {
    if (
      process.env.OPENGENI_PLANT_HERMES_TLA === "1" &&
      path.normalize(input.filename).endsWith(projectionSuffix)
    ) {
      if (!input.src.includes(correctedImport)) {
        throw new Error(`Could not plant the historical top-level import in ${input.filename}`);
      }
      input = {
        ...input,
        src: input.src.replace(correctedImport, oldTopLevelImport),
      };
    }
    return upstream.transform(input);
  },
};
