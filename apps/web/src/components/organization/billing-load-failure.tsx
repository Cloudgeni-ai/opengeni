import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { apiErrorAdvice, apiErrorDetails, isPermissionDenied } from "@opengeni/react/ui/api-error";

/**
 * A billing read that failed: a calm line without Try again when the viewer
 * lacks the permission, otherwise what happened and what to do.
 */
export function BillingLoadFailure(props: {
  title: string;
  denied: string;
  error: Error;
  onRetry: () => void;
}) {
  if (isPermissionDenied(props.error)) {
    return <p className="text-xs leading-[18px] text-fg-muted">{props.denied}</p>;
  }
  return (
    <ErrorMessage
      variant="inline"
      title={props.title}
      announce
      action={<RowButton onClick={props.onRetry}>Try again</RowButton>}
      {...apiErrorDetails(props.error)}
    >
      {apiErrorAdvice(props.error)}
    </ErrorMessage>
  );
}
