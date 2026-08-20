import { cn } from "@/lib/utils";

export function PersonalWorkspaceBadge({
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <span
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : "Personal workspace"}
      className={cn(
        "shrink-0 rounded-full border border-brand/35 bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-brand",
        className,
      )}
    >
      Personal
    </span>
  );
}
