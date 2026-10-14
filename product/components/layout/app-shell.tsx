import type { ReactNode } from "react";
import { AppHeader } from "@/components/layout/app-header";
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <AppHeader />
      <main
        id="main"
        className="mx-auto min-h-[70vh] max-w-[1380px] px-4 pb-16 sm:px-6 lg:px-9"
      >
        {children}
        <footer className="mt-10 flex flex-wrap justify-between gap-4 border-t pt-6 text-xs text-muted-foreground">
          <span>
            ♛ yld˙ᶜˣ · Open. Permissionless. Immutable.{" "}
            <span className="text-foreground">Time to yield.</span>
          </span>
          <span className="flex flex-wrap gap-4">
            <a
              href="https://github.com/yld-cx"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub ↗
            </a>
            <a
              href="https://x.com/yld_cx"
              target="_blank"
              rel="noopener noreferrer"
            >
              X ↗
            </a>
            <a
              href="https://t.me/yld_cx"
              target="_blank"
              rel="noopener noreferrer"
            >
              Telegram ↗
            </a>
          </span>
        </footer>
      </main>
    </>
  );
}
