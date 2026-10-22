import type { ComponentProps } from "react";
import { cn } from "@yld-cx/ui/lib/utils";

export function ArrowLink({
  children,
  className,
  ...props
}: ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "group inline-flex items-center gap-1 transition-colors hover:text-primary focus-visible:text-primary motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      {children}
      <span
        aria-hidden="true"
        className="inline-block transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-focus-visible:-translate-y-0.5 group-focus-visible:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
      >
        ↗
      </span>
    </a>
  );
}
