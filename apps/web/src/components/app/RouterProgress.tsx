import { useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

export function RouterProgress() {
  const isLoading = useRouterState({
    select: (state) => state.status === "pending" || state.isLoading,
  });

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px] overflow-hidden",
        isLoading ? "opacity-100" : "opacity-0",
        "transition-opacity duration-200",
      )}
    >
      <div className="router-progress-bar h-full bg-[color:var(--color-brand)]" />
      <style>{`
        .router-progress-bar {
          transform-origin: left;
          animation: router-progress 1.2s ease-in-out infinite;
        }
        @keyframes router-progress {
          0% { transform: translateX(-100%) scaleX(0.3); }
          50% { transform: translateX(0%) scaleX(0.6); }
          100% { transform: translateX(100%) scaleX(0.3); }
        }
      `}</style>
    </div>
  );
}
