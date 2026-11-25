/**
 * Custom credit offers (docs/custom-credit-offers.md).
 *
 *   bun run credits:offers list --account <org id>
 *   bun run credits:offers assign --account <org id> --amount-usd 2000 \
 *     (--models <id,id> | --models-matching gemini) --valid-days 56 \
 *     [--activate-by 2027-01-31T00:00:00Z] [--label "Design partner credits"] \
 *     --operator <name> --reason <reason>
 *   bun run credits:offers revoke --account <org id> --offer <offer id> \
 *     --operator <name> --reason <reason>
 *   bun run credits:offers activate --account <org id> --offer <offer id> \
 *     --operator <name>
 *
 * Runs as the database owner (OPENGENI_MIGRATIONS_DATABASE_URL or
 * OPENGENI_DATABASE_ADMIN_URL); the runtime role cannot assign or revoke.
 * `activate` starts the offer's validity on the organization's behalf.
 */
import { parseArgs } from "node:util";
import { configuredModels, dbSearchPath, getSettings } from "@opengeni/config";
import { resolveCatalogSettings } from "@opengeni/core";
import {
  activateCreditOffer,
  assignCreditOffer,
  createDb,
  listCreditOffers,
  revokeCreditOffer,
} from "@opengeni/db";

const USAGE =
  "Use: list --account <id> | assign --account <id> --amount-usd <n> (--models <a,b> | --models-matching <text>) --valid-days <n> [--activate-by <ISO date>] [--label <text>] --operator <name> --reason <reason> | revoke --account <id> --offer <id> --operator <name> --reason <reason> | activate --account <id> --offer <id> --operator <name>";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: true,
  options: {
    account: { type: "string" },
    offer: { type: "string" },
    "amount-usd": { type: "string" },
    models: { type: "string" },
    "models-matching": { type: "string" },
    "valid-days": { type: "string" },
    "activate-by": { type: "string" },
    label: { type: "string" },
    operator: { type: "string" },
    reason: { type: "string" },
  },
});
const command = positionals[0];
if (positionals.length !== 1 || !["list", "assign", "revoke", "activate"].includes(command ?? "")) {
  throw new Error(USAGE);
}
const accountId = values.account?.trim();
if (!accountId) throw new Error(`--account is required. ${USAGE}`);
const audit = () => {
  const operator = values.operator?.trim();
  const reason = values.reason?.trim();
  if (!operator || !reason || reason.length < 6) {
    throw new Error("Provide --operator and --reason (at least six characters)");
  }
  return { operator, reason };
};

const settings = getSettings();
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL");
const searchPath = dbSearchPath(settings);
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  if (command === "list") {
    console.log(JSON.stringify(await listCreditOffers(client.db, accountId), null, 2));
  } else if (command === "activate") {
    const offerId = values.offer?.trim();
    const operator = values.operator?.trim();
    if (!offerId || !operator) throw new Error(`--offer and --operator are required. ${USAGE}`);
    console.log(
      JSON.stringify(
        await activateCreditOffer(client.db, {
          accountId,
          offerId,
          subjectId: `operator:${operator}`,
        }),
        null,
        2,
      ),
    );
  } else if (command === "revoke") {
    const offerId = values.offer?.trim();
    if (!offerId) throw new Error(`--offer is required. ${USAGE}`);
    console.log(
      JSON.stringify(
        await revokeCreditOffer(client.db, { accountId, offerId, ...audit() }),
        null,
        2,
      ),
    );
  } else {
    const amountUsd = Number(values["amount-usd"]);
    const amountMicros = Math.round(amountUsd * 1_000_000);
    if (!Number.isFinite(amountUsd) || amountMicros < 1) {
      throw new Error("--amount-usd must be a positive number of US dollars");
    }
    const validDays = Number(values["valid-days"]);
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 730) {
      throw new Error("--valid-days must be a whole number of days between 1 and 730");
    }
    const activateBy = values["activate-by"] ? new Date(values["activate-by"]) : null;
    if (activateBy && Number.isNaN(activateBy.getTime())) {
      throw new Error("--activate-by must be an ISO date");
    }
    // Same rule as the promotion policy: only canonical credit-funded models
    // can be paid for by promotional credit.
    const catalog = configuredModels((await resolveCatalogSettings(client.db, settings)).settings);
    const creditModels = catalog.filter((model) => model.cost === "credits");
    const matching = values["models-matching"]?.trim().toLowerCase();
    // The allowlist is fixed when the offer is assigned: models added to the
    // catalog later are not covered.
    const eligibleModelIds = [
      ...new Set([
        ...(values.models ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
        ...(matching
          ? creditModels
              .filter((model) => model.id.toLowerCase().includes(matching))
              .map((model) => model.id)
          : []),
      ]),
    ];
    if (eligibleModelIds.length < 1 || eligibleModelIds.length > 40) {
      throw new Error(
        "--models and --models-matching must select 1 to 40 credit-funded model ids in total",
      );
    }
    for (const id of eligibleModelIds) {
      if (!creditModels.some((model) => model.id === id)) {
        throw new Error(
          `Model ${id} must be a canonical credit-funded model in the current catalog`,
        );
      }
    }
    const offer = await assignCreditOffer(client.db, {
      accountId,
      label: values.label?.trim() || "Sponsored credits",
      amountMicros,
      eligibleModelIds,
      validDays,
      activateBy,
      ...audit(),
    });
    console.log(JSON.stringify({ assigned: true, offer }, null, 2));
  }
} finally {
  await client.close();
}
