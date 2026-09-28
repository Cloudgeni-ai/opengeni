import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { HelpLink } from "@/components/ui/inline-help";

/** A HelpLink to a page inside the app: a plain click navigates without a page load. */
export function InAppHelpLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <HelpLink href={href} onClick={() => void navigate({ href })} className={className}>
      {children}
    </HelpLink>
  );
}
