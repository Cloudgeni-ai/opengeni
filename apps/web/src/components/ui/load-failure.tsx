import { RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { apiErrorFacts } from "@/lib/api-error";

/** A page or section that could not load, with its server facts and one retry action. */
export function LoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  const { status, reference, serverMessage } = apiErrorFacts(error);
  let message = serverMessage ?? "";
  if (message && !/[.!?]$/u.test(message)) message = `${message}.`;
  if (message) message = message.charAt(0).toUpperCase() + message.slice(1);
  return (
    <ErrorMessage
      variant="block"
      align="center"
      title={title}
      reference={reference}
      details={[
        ...(status ? [{ label: "Status", value: String(status) }] : []),
        { label: "Message", value: message || "Something went wrong. Try again." },
      ]}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCcwIcon aria-hidden="true" />
          Try again
        </Button>
      }
    >
      Check your connection, then try again.
    </ErrorMessage>
  );
}
