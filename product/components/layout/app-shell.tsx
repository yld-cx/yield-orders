import type { ReactNode } from "react";
import deployment from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { ArrowLink } from "@/components/arrow-link";
import { AppHeader } from "@/components/layout/app-header";
import { Badge } from "@/packages/ui/src/components/ui/badge";
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <AppHeader />
      <main
        id="main"
        className="mx-auto max-w-[1380px] px-4 pb-16 sm:px-6 lg:px-9"
      >
        <div className="min-h-[70svh]">{children}</div>
        <footer className="mt-10 flex flex-wrap justify-between gap-4 border-t pt-6 text-xs text-muted-foreground">
          <div className="flex flex-col gap-1">
            yld˙ᶜˣ · Open. Permissionless. Immutable.
            <p>
              <span className="text-foreground">Time to yield</span> · ⩇⩇:⩇⩇
              <Badge
                variant="ghost"
                className="text-green-500! cursor-pointer"
                title="Public Beta"
              >
                v{deployment.version}
              </Badge>
            </p>
          </div>
          <div className="flex flex-wrap gap-4">
            <ArrowLink
              href="https://github.com/yld-cx"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </ArrowLink>
            <ArrowLink
              href="https://x.com/yld_cx"
              target="_blank"
              rel="noopener noreferrer"
            >
              X
            </ArrowLink>
            <ArrowLink
              href="https://t.me/yld_cx"
              target="_blank"
              rel="noopener noreferrer"
            >
              Telegram
            </ArrowLink>
          </div>
        </footer>
      </main>
    </>
  );
}
