import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The two authKind cases that ever need a dialog. Connect otherwise branches
 * with zero screen of ours: `none` connects immediately, and a reviewed
 * `oauth2` connector redirects straight through the provider's own consent
 * screen. `api_key` shows exactly one field and no scope bullet list;
 * unreviewed `oauth2` is one line naming the domain, not a confirmation form.
 */
export type QuickConnectRequest =
  | {
      authKind: "api_key";
      itemName: string;
      providerDomain: string;
      fieldLabel: string;
      onConnect: (value: string) => Promise<void>;
    }
  | {
      authKind: "oauth2_unreviewed";
      itemName: string;
      providerDomain: string;
      onConnect: () => Promise<void>;
    };

/**
 * One shared dialog for both the multi-account "+ Add account" action and the
 * Connectors row-icon quick-connect fast path. Closes on outside click and
 * Escape like every other dialog/sheet - a busy submit only disables the
 * submit button, it never suppresses closing.
 */
export function QuickConnectDialog({
  request,
  onOpenChange,
}: {
  request: QuickConnectRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue("");
    setBusy(false);
    setError(null);
  }, [request]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (request.authKind === "api_key") {
        await request.onConnect(value.trim());
      } else {
        await request.onConnect();
      }
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  }

  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {request ? (
          <form onSubmit={(event) => void submit(event)}>
            <DialogHeader>
              <DialogTitle>Connect {request.itemName}</DialogTitle>
              {request.authKind === "oauth2_unreviewed" ? (
                <DialogDescription>
                  You&apos;ll sign in at {request.providerDomain}.
                </DialogDescription>
              ) : (
                <DialogDescription>
                  Enter the credential {request.itemName} needs.
                </DialogDescription>
              )}
            </DialogHeader>

            {request.authKind === "api_key" ? (
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="quick-connect-value">{request.fieldLabel}</Label>
                <Input
                  id="quick-connect-value"
                  autoFocus
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : null}

            {error ? <p className="mt-3 text-xs text-status-failed">{error}</p> : null}

            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || (request.authKind === "api_key" && value.trim().length === 0)}
              >
                Connect
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
