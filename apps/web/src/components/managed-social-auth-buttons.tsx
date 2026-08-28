import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

export type ManagedSocialProvider = "google" | "github";

export function ManagedSocialAuthButtons(props: {
  providers: readonly ManagedSocialProvider[];
  busyProvider?: ManagedSocialProvider | null;
  disabled?: boolean;
  onSelect: (provider: ManagedSocialProvider) => void;
}) {
  if (props.providers.length === 0) return null;
  return (
    <div className="grid gap-2">
      {props.providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          className="min-h-11 w-full justify-center"
          disabled={props.disabled || props.busyProvider != null}
          onClick={() => props.onSelect(provider)}
        >
          {props.busyProvider === provider ? (
            <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
          ) : provider === "google" ? (
            <GoogleIcon />
          ) : (
            <GitHubIcon />
          )}
          Continue with {provider === "google" ? "Google" : "GitHub"}
        </Button>
      ))}
    </div>
  );
}

export function ManagedAuthDivider() {
  return (
    <div className="my-4 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
        or use email
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.3Z"
      />
      <path
        fill="#34A853"
        d="M 12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.8 5.8 0 0 1-5.5-4H3.2v2.6A10 10 0 0 0 12 22Z"
      />
      <path fill="#FBBC05" d="M6.5 14.1a6 6 0 0 1 0-4.2V7.3H3.2a10 10 0 0 0 0 9.4l3.3-2.6Z" />
      <path
        fill="#EA4335"
        d="M 12 5.9c1.5 0 2.9.5 4 1.5l3-3A10 10 0 0 0 3.2 7.3l3.3 2.6a5.8 5.8 0 0 1 5.5-4Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M 12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C17 4.8 18 5.1 18 5.1c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.8 5.4-5.5 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .7Z"
      />
    </svg>
  );
}
