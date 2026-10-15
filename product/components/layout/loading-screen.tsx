import { cn } from "@yld-cx/ui/lib/utils";
import { LoaderIcon } from "lucide-react";

export default function LoadingScreen({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[70svh] items-center justify-center",
        className,
      )}
    >
      <span role="status" className="inline-flex items-center justify-center">
        <LoaderIcon
          aria-hidden="true"
          strokeWidth={1}
          className="size-50 text-brand opacity-3 motion-safe:animate-[spin_10s_linear_infinite]"
        />
        <span className="sr-only">{label}</span>
      </span>
    </div>
  );
}
