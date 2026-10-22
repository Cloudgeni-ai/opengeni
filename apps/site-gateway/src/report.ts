import type { SiteAbuseReportRequest } from "@opengeni/contracts";
import { rateLimitKeys, underRateLimit } from "./api";
import { formToken, mintVisitor, verifyFormToken } from "./cookies";
import { utf8 } from "./crypto";
import { messagePage, reportFormPage } from "./pages";
import { isAbuseCategory } from "./report-categories";
import { signedApiRequest } from "./signing";
import { isSameOriginRequest, siteCaller, type SiteContext } from "./site-context";

const MAX_REPORT_FORM_BYTES = 16 * 1024;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}$/u;

/**
 * /_og/report: a script-free form (GET) that posts a SiteAbuseReportRequest
 * to the signed `POST /v1/site-runtime/site/reports`. CSRF-safe: the POST
 * must be same-origin and carry a form token bound to this host and visitor.
 */
export async function handleReport(site: SiteContext): Promise<Response> {
  const method = site.request.method;
  if (method === "GET" || method === "HEAD") return await reportForm(site);
  if (method !== "POST") return messagePage(site, 405, "Not allowed", "Use the report form.");
  if (!isSameOriginRequest(site.request, site.siteOrigin))
    return messagePage(site, 403, "Not allowed", "Send the report from this Site's report page.");
  const type = site.request.headers.get("content-type") ?? "";
  const declared = Number(site.request.headers.get("content-length") ?? "0");
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded"))
    return messagePage(site, 415, "Unsupported report", "Use the report form.");
  if (declared > MAX_REPORT_FORM_BYTES)
    return messagePage(site, 413, "Report too long", "Shorten the report and try again.");
  const text = await site.request.text();
  if (text.length > MAX_REPORT_FORM_BYTES)
    return messagePage(site, 413, "Report too long", "Shorten the report and try again.");
  const form = new URLSearchParams(text);
  const token = form.get("token") ?? "";
  if (!(await verifyFormToken(site.config.secret, "report", token, site.hostname, site.visitor)))
    return await reportForm(site, "The form expired. Please send it again.");
  const category = form.get("category");
  const message = (form.get("message") ?? "").trim();
  const contactEmail = (form.get("contactEmail") ?? "").trim();
  if (!isAbuseCategory(category)) return await reportForm(site, "Choose a reason.");
  if (message.length > 4000) return await reportForm(site, "Shorten the details.");
  if (contactEmail && (contactEmail.length > 320 || !EMAIL.test(contactEmail)))
    return await reportForm(site, "Enter a valid email address or leave it empty.");
  if (!(await underRateLimit(site, rateLimitKeys(site, "report"))))
    return messagePage(site, 429, "Too many reports", "Please wait a minute and try again.");
  const report: SiteAbuseReportRequest = {
    category,
    message,
    contactEmail: contactEmail || null,
  };
  let status: number;
  try {
    const response = await fetch(
      await signedApiRequest(site.config, siteCaller(site), {
        method: "POST",
        suffix: "/site/reports",
        body: utf8(JSON.stringify(report)),
        headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
      }),
    );
    status = response.status;
    await response.body?.cancel();
  } catch {
    status = 502;
  }
  if (status >= 200 && status < 300)
    return messagePage(
      site,
      200,
      "Report sent",
      "Thank you. Your report was sent to the Site's owners and to the abuse team of this service. For anything urgent, email the abuse team too.",
      { href: `mailto:${site.config.abuseEmail}`, label: site.config.abuseEmail },
    );
  if (status === 429)
    return messagePage(site, 429, "Too many reports", "Please wait a minute and try again.");
  return messagePage(
    site,
    502,
    "Report not sent",
    "The report could not be sent. Email the abuse team of this service instead.",
    { href: `mailto:${site.config.abuseEmail}`, label: site.config.abuseEmail },
  );
}

async function reportForm(site: SiteContext, error?: string): Promise<Response> {
  const cookies: string[] = [];
  let visitor = site.visitor;
  if (!visitor) {
    const minted = await mintVisitor(site.config.secret);
    visitor = minted.id;
    cookies.push(minted.setCookie);
  }
  const headers = new Headers();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return reportFormPage(site, {
    title: site.record.title,
    abuseEmail: site.config.abuseEmail,
    token: await formToken(site.config.secret, "report", site.hostname, visitor),
    headers,
    ...(error ? { error } : {}),
  });
}
