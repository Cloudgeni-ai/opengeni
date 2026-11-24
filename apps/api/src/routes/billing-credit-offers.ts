import {
  ActivateCreditOfferRequest,
  CreditOffer,
  ListCreditOffersResponse,
} from "@opengeni/contracts";
import { requireAccessContext } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  activateCreditOffer,
  creditOfferSelfServeActivation,
  listCreditOffers,
  nestedPostgresSqlState,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseRequestBody } from "../http/request-body";
import { requireSelectedAccount } from "./billing";

/**
 * Custom credit offers (docs/custom-credit-offers.md). Operators assign them
 * with `bun run credits:offers`; billing readers see them and billing
 * managers activate them.
 */
export function registerBillingCreditOfferRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/billing/credit-offers", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.query("accountId"), "billing:read");
    c.header("cache-control", "private, no-store");
    const [offers, selfServeActivation] = await Promise.all([
      listCreditOffers(deps.db, accountId),
      creditOfferSelfServeActivation(deps.db),
    ]);
    return c.json(ListCreditOffersResponse.parse({ offers, selfServeActivation }));
  });
  app.post("/v1/billing/credit-offers/:offerId/activate", async (c) => {
    const context = await requireAccessContext(c, deps);
    const body = parseRequestBody(
      ActivateCreditOfferRequest,
      await c.req.json().catch(() => ({})),
      { status: 400, message: "Invalid credit offer activation" },
    );
    const offerId = CreditOffer.shape.id.safeParse(c.req.param("offerId"));
    if (!offerId.success) throw new HTTPException(404, { message: "Credit offer not found." });
    const accountId = requireSelectedAccount(context, body.accountId, "billing:manage");
    try {
      return c.json(
        CreditOffer.parse(
          await activateCreditOffer(deps.db, {
            accountId,
            offerId: offerId.data,
            subjectId: context.subjectId,
          }),
        ),
      );
    } catch (error) {
      const state = nestedPostgresSqlState(error);
      if (state === "P0002") throw new HTTPException(404, { message: "Credit offer not found." });
      if (state === "42501") {
        throw new HTTPException(409, {
          message: "Contact Opengeni support to activate this offer.",
        });
      }
      if (state === "55000") {
        throw new HTTPException(409, {
          message:
            "This offer can no longer be activated. Contact support if you think that's wrong.",
        });
      }
      throw error;
    }
  });
}
