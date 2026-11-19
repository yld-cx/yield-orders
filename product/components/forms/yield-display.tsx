"use client";

import { useId, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@yld-cx/ui/components/ui/tooltip";
import { APY_DESCRIPTION } from "@/lib/yield";

export function ApyLabel({ children = "APY" }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const descriptionId = `${triggerId}-description`;
  return (
    <span className="inline-flex items-center gap-1">
      <span>{children}</span>
      <Tooltip open={open} onOpenChange={setOpen} triggerId={triggerId}>
        <TooltipTrigger
          id={triggerId}
          type="button"
          aria-label="About APY"
          aria-describedby={open ? descriptionId : undefined}
          closeOnClick={false}
          onClick={() => setOpen(true)}
          className="inline-flex shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent id={descriptionId} side="top">
          {APY_DESCRIPTION}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
