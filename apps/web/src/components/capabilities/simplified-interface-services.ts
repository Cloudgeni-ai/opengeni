/**
 * The apps the simplified interface puts first on Capabilities: mail,
 * calendar, files, chat, social and payments, in that order. Matched by the
 * name people see, so a provider counts under whichever catalog id it has.
 */
const SIMPLIFIED_INTERFACE_APPS: readonly RegExp[] = [
  /^gmail$/,
  /^outlook( mail)?$/,
  /^google calendar$/,
  /^outlook calendar$/,
  /^google drive$/,
  /^google sheets$/,
  /^(microsoft )?excel$/,
  /^(microsoft )?word$/,
  /^google business profile$/,
  /^whatsapp( business)?$/,
  /^(microsoft )?teams$/,
  /^slack$/,
  /^facebook( pages)?$/,
  /^instagram$/,
  /^stripe$/,
  /^mailchimp$/,
];

/**
 * Splits a list of services into the simplified interface's apps, in its own
 * order, and everything else in the order given.
 */
export function partitionSimplifiedInterfaceServices<Service extends { name: string }>(
  services: readonly Service[],
): { apps: Service[]; others: Service[] } {
  const rank = (service: Service) => {
    const name = service.name.trim().toLowerCase();
    return SIMPLIFIED_INTERFACE_APPS.findIndex((pattern) => pattern.test(name));
  };
  const ranked = services.map((service) => ({ service, rank: rank(service) }));
  return {
    apps: ranked
      .filter((entry) => entry.rank >= 0)
      .sort((left, right) => left.rank - right.rank)
      .map((entry) => entry.service),
    others: ranked.filter((entry) => entry.rank < 0).map((entry) => entry.service),
  };
}
