import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { makeWagmiConfig } from "@/lib/wagmi";
import { Providers } from "@/components/layout/providers";
import { AppShell } from "@/components/layout/app-shell";
import { isNetworkSlug, ORIGIN } from "@/lib/registry";
import "./globals.css";
export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: {
    default: "yld.cx — liquidity rental markets",
    template: "%s | yld.cx",
  },
  description:
    "Provide or rent tokens at your price. Asset moves. Quote locks.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "yld.cx",
    title: "yld.cx — liquidity rental markets",
    description: "Provide or rent tokens at your price.",
    url: ORIGIN,
    images: [{ url: `${ORIGIN}/opengraph-image`, width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "yld.cx — liquidity rental markets",
    description: "Provide or rent tokens at your price.",
    images: [`${ORIGIN}/opengraph-image`],
  },
  icons: { icon: "/icon.svg" },
};
export const dynamic = "force-dynamic";
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers(),
    jar = await cookies();
  const selected = jar.get("yld.network")?.value;
  const initialState = cookieToInitialState(
    makeWagmiConfig(),
    requestHeaders.get("cookie"),
  );
  return (
    <html lang="en" className="dark">
      <body className="min-w-[320px] font-sans antialiased">
        <Providers
          initialState={initialState}
          initialNetwork={
            selected && isNetworkSlug(selected) ? selected : "base"
          }
        >
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
