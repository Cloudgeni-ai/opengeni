import { FormPage, type FormFrameProps } from "@/components/ui/form-dialog";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   A FormPage inside a content column that already has its gutter (settings
   pages, ContentPage). The back link, title, fields and footer start where a
   DetailPage with `px-0` starts, so moving between an object's page and its
   edit page doesn't shift anything.
   -------------------------------------------------------------------------- */

export const FLUSH_FORM_PAGE_CLASS = [
  "[&>form>header]:mx-0 [&>form>header]:px-0 [&>form>header]:pt-0",
  "[&>form>[data-slot=form-body]]:mx-0 [&>form>[data-slot=form-body]]:px-0",
  "[&>form>footer>div]:mx-0 [&>form>footer>div]:px-0",
  // The footer's hairline ends where the 640px column does, like the header's.
  "[&>form>footer]:max-w-[640px]",
].join(" ");

/** DetailPage classes for the same column: no extra gutter or centring. */
export const FLUSH_DETAIL_PAGE_CLASS = "max-w-none px-0 pt-0 pb-0 max-sm:px-0";

/** A full-page create or edit form with a back link and a sticky Cancel + primary footer. */
export function FlushFormPage({
  onClose,
  backLabel,
  className,
  ...props
}: Omit<FormFrameProps, "variant" | "back" | "onCancel"> & {
  onClose: () => void;
  /** The page the back link returns to: "Variable sets", or the object's name. */
  backLabel: string;
}) {
  return (
    <FormPage
      back={{ label: backLabel, onClick: onClose }}
      onCancel={onClose}
      className={cn(FLUSH_FORM_PAGE_CLASS, className)}
      {...props}
    />
  );
}
