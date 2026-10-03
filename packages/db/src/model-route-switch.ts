import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows } from "./database";

/**
 * The newest revision per product of the deployment-level credits model route
 * switch (migration 0597). A product whose newest revision is `fallback` and
 * whose database catalog declares a fallback route is served by that route for
 * new turns. Operators change it only through the owner-only audited SQL setter
 * `set_model_route`; runtime roles can only read it. Catalog resolution reads
 * it only when the catalog declares at least one fallback route.
 */
export type ModelRouteSwitchState = {
  productModelId: string;
  route: "primary" | "fallback";
  revision: number;
  changedAt: Date;
};

/** Newest revision per product; a product with no revision is on its primary route. */
export async function readModelRouteSwitchStates(db: Database): Promise<ModelRouteSwitchState[]> {
  const rows = await rawRows<{
    product_model_id: string;
    route: string;
    revision: number | string;
    changed_at: Date | string;
  }>(
    db,
    sql`
    select distinct on (revision.product_model_id)
      revision.product_model_id, revision.route, revision.revision, revision.changed_at
    from opengeni_private.model_route_switch_revisions revision
    order by revision.product_model_id, revision.revision desc
  `,
  );
  return rows.flatMap((row) =>
    row.route === "primary" || row.route === "fallback"
      ? [
          {
            productModelId: row.product_model_id,
            route: row.route,
            revision: Number(row.revision),
            changedAt: row.changed_at instanceof Date ? row.changed_at : new Date(row.changed_at),
          },
        ]
      : [],
  );
}
