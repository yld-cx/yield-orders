import { ImageResponse } from "next/og";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import { PRODUCT_MARKET } from "@yld-cx/sdk";
import { tokenLogoData } from "@/components/layout/social-image";
import { readPlaySelection, playTokens } from "@/lib/play-market";
import { readPlayValues, playOutcome, playFormat, playSigned, isRentalPlay } from "@/lib/play";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const selection = readPlaySelection(params);
  const values = readPlayValues(params);
  const tokens = selection ? await playTokens(selection.market) : undefined;
  const asset = tokens?.asset.symbol.slice(0, 24);
  const quote = tokens?.quote.symbol.slice(0, 24);
  const outcome = selection && values ? playOutcome(selection.strategy.id, values) : undefined;
  const rental = selection && isRentalPlay(selection.strategy.id);
  const title = selection ? `${selection.strategy.emoji} ${selection.strategy.title} ${asset}` : "Discover your next strategy.";
  const unit = outcome?.unit === "asset" ? asset : quote;
  const amount = outcome?.value === undefined ? undefined : (outcome.signed ? playSigned(outcome.value) : playFormat(outcome.value)) + " " + unit;
  const logo = tokens ? await tokenLogoData(tokens.asset) : undefined;
  return new ImageResponse(
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "44px 72px", background: "#090c0f", color: "#f5f7f6", fontFamily: "sans-serif", border: "2px solid #26342d" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 48, fontWeight: 900, letterSpacing: -2, color: "#00ff4c" }}>yld˙ᶜˣ</span>
        <span style={{ fontSize: 26, color: "#e7b94d" }}>👑 Yield Explorer{selection ? " · " + getNetwork(selection.network).name : ""}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders embedded data. */}
          {logo && <img src={logo} width={56} height={56} alt="" style={{ borderRadius: 28 }} />}
          <span style={{ fontSize: title.length > 30 ? 40 : 58, fontWeight: 700 }}>{title}</span>
        </div>
        {values && selection && <span style={{ fontSize: 29, color: "#b3bfb7" }}>{rental ? "What if the price reaches" : "Order price"} {playFormat(values.target)} {quote}{rental ? "?" : ""}</span>}
        {outcome && <span style={{ fontSize: 24, color: "#b3bfb7" }}>{outcome.label}</span>}
        <span style={{ fontSize: amount && amount.length > 26 ? 48 : 78, fontWeight: 700, color: outcome?.value !== undefined && outcome.value < 0 ? "#f1a2a8" : "#00ff4c" }}>{amount ?? (outcome ? "—" : "Play your way.")}</span>
        {values && selection && <span style={{ fontSize: 23, color: "#b3bfb7" }}>{playFormat(values.amount)} {quote} {rental ? "exposure" : "position value"} · Entry {playFormat(values.entry)} · {PRODUCT_MARKET.duration} days</span>}
        {values && selection && <span style={{ fontSize: 22, color: "#e7b94d" }}>{values.rate === undefined ? (rental ? "Rental cost not included" : "Rental Yield not included") : `Assumed ${rental ? "rental cost" : "net term Yield"}: ${playFormat(values.rate)}%`}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid #26342d", paddingTop: 18 }}>
        <span style={{ fontSize: 20, color: "#b3bfb7" }}>Hypothetical · Not a forecast · Excludes trading fees and gas</span>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 23, color: "#e7b94d" }}>
          <span>{selection ? (rental ? "Repay by maturity or lose locked assets" : "Yield and fills are not guaranteed") : "Discover · Simulate · Share"}</span><span>yld.cx/play</span>
        </div>
      </div>
    </div>,
    { width: 1200, height: 630, headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } },
  );
}
