import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@opengeni/react/ui/button";
import { ACCOUNT_DELETION_RECEIPT } from "@/lib/account-deletion-api";

export function AccountDeletionRequested() {
  const ios = new URLSearchParams(window.location.search).get("client") === "ios";
  const [receipt] = useState(() => {
    try {
      return sessionStorage.getItem(ACCOUNT_DELETION_RECEIPT);
    } catch {
      return null;
    }
  });
  const accepted = receipt === "email" || receipt === "no-email";
  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4 py-8">
      <div className="grid w-full max-w-sm gap-4 rounded-xl border border-border bg-surface p-6">
        {accepted && (
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <CheckIcon aria-hidden="true" className="size-4" />
          </span>
        )}
        <h1 className="text-lg font-semibold">
          {accepted ? "Your account is being deleted" : "Account deletion"}
        </h1>
        <p className="text-sm text-fg-subtle">
          {accepted
            ? `You’re signed out on all devices. Deletion usually takes a few minutes and can take up to 30 days.${receipt === "email" ? " We’ll email you when it’s complete." : ""}`
            : "If you requested deletion, you’ll be signed out. Deletion usually takes a few minutes and can take up to 30 days."}
        </p>
        <Button asChild variant="outline" className="w-fit">
          <Link to="/" search={ios ? { client: "ios" } : {}}>
            Back to Opengeni
          </Link>
        </Button>
      </div>
    </section>
  );
}
