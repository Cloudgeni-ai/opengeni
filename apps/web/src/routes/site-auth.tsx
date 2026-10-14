import type { SiteAuthAuthorizeRequest } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { GlobeIcon, LockKeyholeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { LoadingPanel } from "@/components/common";
import { ConsentFrame } from "@/components/organization-access/mcp-consent-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormPage } from "@/components/ui/form-dialog";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import { apiErrorFacts, userErrorText } from "@/lib/api-error";
import { useNativeSignInContext } from "@/lib/native-sign-in-context";
import {
  isFramedWindow,
  safeSiteRedirect,
  siteAuthCancelUrl,
  siteAuthRequest,
  type SiteAuthSearch,
} from "@/lib/site-auth";
import { sitesClientConfig } from "@/lib/site-publishing";

/* ----------------------------------------------------------------------------
   /site-auth/authorize: a published Site asks the signed-in person to open
   it as themselves. The page shows which Site and which account, with one
   action. Continue asks the API for a one-time code bound to the Site's host
   and PKCE challenge and hands it to the Site's gateway, which redeems it
   server-to-server for a session that works only on that Site. Nothing is
   minted before Continue, the page never renders inside another page, and
   it only ever navigates to a Site under the deployment's Sites domain.
   -------------------------------------------------------------------------- */

type SiteAuthClient = Pick<OpenGeniBrowserClient, "authorizeSiteViewer" | "getClientConfig">;

type Phase =
  | { kind: "idle" }
  | { kind: "continuing" }
  /** The API confirmed the Site and refused this account. */
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

export function SiteAuthorizeRoute({ search }: { search: SiteAuthSearch }) {
  const signedIn = useNativeSignInContext();
  if (signedIn)
    return (
      <SiteAuthorizePage
        client={signedIn.client}
        email={signedIn.email}
        search={search}
        onUseAnotherAccount={() => {
          // Sign-out returns home; come back here to sign in as someone else.
          const request = window.location.href;
          void signedIn.handleManagedSignOut().then(() => window.location.replace(request));
        }}
      />
    );
  return <SiteAuthorizeWithAppContext search={search} />;
}

/** Deployments without managed sign-in reach this page through the ordinary app. */
function SiteAuthorizeWithAppContext({ search }: { search: SiteAuthSearch }) {
  const { client, authSession, clientConfig } = useAppContext();
  return (
    <SiteAuthorizePage
      client={client}
      email={authSession?.user?.email ?? "your account"}
      search={search}
      sitesDomain={sitesClientConfig(clientConfig).domain ?? null}
    />
  );
}

function assignLocation(url: string) {
  window.location.assign(url);
}

/** The Sites domain from the client config, when the caller doesn't already know it. */
function useSitesDomain(
  client: SiteAuthClient,
  known: string | null | undefined,
  skip: boolean,
): { state: "loading" } | { state: "ready"; domain: string | null } {
  const [loaded, setLoaded] = useState<string | null | undefined>(undefined);
  const clientRef = useRef(client);
  clientRef.current = client;
  useEffect(() => {
    if (known !== undefined || skip) return;
    let current = true;
    void clientRef.current
      .getClientConfig()
      .then((config) => sitesClientConfig(config).domain ?? null)
      .catch(() => null)
      .then((domain) => {
        if (current) setLoaded(domain);
      });
    return () => {
      current = false;
    };
  }, [known, skip]);
  const domain = known !== undefined ? known : loaded;
  return domain === undefined ? { state: "loading" } : { state: "ready", domain };
}

export function SiteAuthorizePage({
  client,
  email,
  search,
  sitesDomain,
  onUseAnotherAccount,
  navigate = assignLocation,
  isFramed = isFramedWindow,
}: {
  client: SiteAuthClient;
  email: string;
  search: SiteAuthSearch;
  /** Known Sites domain; when omitted, the page reads it from the client config. */
  sitesDomain?: string | null | undefined;
  onUseAnotherAccount?: (() => void) | undefined;
  navigate?: (url: string) => void;
  isFramed?: () => boolean;
}) {
  const framed = useMemo(() => isFramed(), [isFramed]);
  const domain = useSitesDomain(client, sitesDomain, framed);
  const request = useMemo(
    () => (domain.state === "ready" ? siteAuthRequest(search, domain.domain) : null),
    [domain, search],
  );
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  if (framed)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<LockKeyholeIcon />}
          title="Open this page in its own tab"
          description="For your safety, sign-in to a Site can't be shown inside another page."
        />
      </ConsentFrame>
    );

  if (domain.state === "loading") return <LoadingPanel />;

  if (!request)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<GlobeIcon />}
          title="Nothing to sign in to here"
          description="Open this page from Sign in on a published Site."
        />
      </ConsentFrame>
    );

  if (phase.kind === "unavailable")
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<GlobeIcon />}
          title="This Site isn't available"
          description={`There is no published Site at ${request.host}.`}
        />
      </ConsentFrame>
    );

  const anotherAccount = onUseAnotherAccount ? (
    <Button type="button" variant="ghost" onClick={onUseAnotherAccount}>
      Use another account
    </Button>
  ) : null;

  if (phase.kind === "denied") {
    // The API answered for this Site, so its callback is a real Site to return to.
    const back = siteAuthCancelUrl(request, domain.domain);
    return (
      <ConsentFrame>
        <FormPage
          leading={<LogoTile icon={<LockKeyholeIcon />} />}
          title="You can't open this Site"
          description={`${email} doesn't have access to ${request.host}. Ask the Site's owner to invite this email, or use another account.`}
          submitLabel="Back to the Site"
          submitDisabled={!back}
          cancelLabel={null}
          footerStart={anotherAccount}
          onSubmit={() => {
            if (back) navigate(back);
            return false;
          }}
        />
      </ConsentFrame>
    );
  }

  return (
    <ConsentFrame>
      <FormPage
        leading={<LogoTile icon={<GlobeIcon />} />}
        title={`Continue to ${request.host}`}
        description="The Site sees your name and email. It can't use your account anywhere else."
        submitLabel="Continue"
        pendingLabel="Continuing…"
        pending={phase.kind === "continuing"}
        onCancel={() => {
          // Nothing has confirmed this Site yet, so Cancel stays in Opengeni.
          navigate("/");
        }}
        footerStart={anotherAccount}
        onSubmit={async () => {
          // The one-time code is minted only now, and used at once.
          setPhase({ kind: "continuing" });
          const next = await authorize(client, request);
          if (next.kind !== "ready") {
            setPhase(next);
            return false;
          }
          const target = safeSiteRedirect(next.redirectTo, request, domain.domain);
          if (!target) {
            setPhase({ kind: "idle" });
            throw new Error("The Site's sign-in link isn't valid. Open the Site again.");
          }
          navigate(target);
          return false;
        }}
      >
        {phase.kind === "failed" ? (
          <Notice tone="failed">{phase.message}</Notice>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
            <dt className="text-fg-muted">Site</dt>
            <dd className="truncate text-fg">{request.host}</dd>
            <dt className="text-fg-muted">Account</dt>
            <dd className="truncate text-fg">{email}</dd>
          </dl>
        )}
      </FormPage>
    </ConsentFrame>
  );
}

async function authorize(
  client: SiteAuthClient,
  request: SiteAuthAuthorizeRequest,
): Promise<
  { kind: "ready"; redirectTo: string } | Exclude<Phase, { kind: "idle" | "continuing" }>
> {
  try {
    const response = await client.authorizeSiteViewer(request);
    return { kind: "ready", redirectTo: response.redirectTo };
  } catch (error) {
    const { status, code } = apiErrorFacts(error);
    if (code === "site_access_denied" || status === 403) return { kind: "denied" };
    if (code === "site_not_found" || status === 404) return { kind: "unavailable" };
    return { kind: "failed", message: userErrorText(error, "Couldn't reach the Site. Try again.") };
  }
}
