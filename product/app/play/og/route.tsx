import { ImageResponse } from "next/og";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import {
  socialImageFrame,
  socialImageNetworkStyle,
  tokenLogoData,
} from "@/components/layout/social-image";
import {
  playTokens,
  readPlayNetwork,
  readPlaySelection,
} from "@/lib/play-market";
import { priceText } from "@/lib/market-values";
import {
  orientPlayPrice,
  playDecimal,
  playFieldLabels,
  playFieldUnits,
  playFormat,
  playOutcome,
  playOutcomeText,
  playQuoteText,
  playSigned,
  readPlayValues,
} from "@/lib/play";

const brandColor = "#00ff4c";
const headerRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 24,
};

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const network = readPlayNetwork(params);
  const networkName = network && getNetwork(network).name;
  const selection = readPlaySelection(params);
  const values = selection && readPlayValues(selection.settings);
  const tokens =
    selection && (await playTokens(selection.market, selection.settings));
  const logo = tokens && (await tokenLogoData(tokens.asset));
  const strategy = selection?.strategy;
  const asset = tokens?.asset.symbol.slice(0, 24) ?? "";
  const quote = tokens?.quote.symbol.slice(0, 24) ?? "";
  const outcome =
    strategy && values ? playOutcome(strategy.id, values) : undefined;
  const result = playOutcomeText(outcome, asset, quote);
  const quoteText = playQuoteText(outcome, quote);
  const description = strategy?.description(asset, quote);
  const labels = strategy && playFieldLabels(strategy.id);
  const units = selection && playFieldUnits(selection.settings, asset, quote);
  const entry =
    selection && orientPlayPrice(selection.settings, selection.settings.entry);
  const fields =
    labels && units && values
      ? [
          {
            label: labels.amount,
            value: `${playFormat(values.amount)} ${units.amount}`,
          },
          {
            label: labels.entry,
            value:
              entry === undefined
                ? "—"
                : `${playFormat(Number(entry))} ${units.entry}`,
          },
          ...(labels.target && values.target !== undefined
            ? [
                {
                  label: labels.target,
                  value: `${selection.settings.targetTick === undefined ? playFormat(values.target) : priceText(playDecimal(values.target))} ${quote}`,
                },
              ]
            : []),
          ...(labels.rate
            ? [
                {
                  label: labels.rate,
                  value:
                    values.rate === undefined
                      ? "—"
                      : `${playFormat(values.rate)}%`,
                },
              ]
            : []),
        ]
      : [];

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: strategy ? "flex-start" : "center",
        width: "100%",
        height: "100%",
        gap: 75,
        ...socialImageFrame,
        color: "#f5f7f6",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders embedded data.
          <img
            src={logo}
            width={64}
            height={64}
            alt=""
            style={{ borderRadius: 32, flexShrink: 0 }}
          />
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            gap: 6,
          }}
        >
          <div style={headerRow}>
            {description && (
              <span
                style={{
                  minWidth: 0,
                  flexShrink: 1,
                  fontSize: description.length > 42 ? 32 : 40,
                  fontWeight: 700,
                }}
              >
                {description}
              </span>
            )}
            <div
              style={{
                display: "flex",
                flexShrink: 0,
                fontSize: strategy ? 28 : 68,
                fontWeight: 700,
                letterSpacing: strategy ? -0.5 : -1.5,
              }}
            >
              <span>Yield Explorer</span>
              <span style={{ color: brandColor }}>.</span>
            </div>
          </div>
          <div style={headerRow}>
            {strategy && (
              <span style={{ fontSize: 24, color: "#8e989f" }}>
                {strategy.emoji} {strategy.title} | Strategy
              </span>
            )}
            <div
              style={{
                display: "flex",
                flexShrink: 0,
                gap: 6,
                fontSize: 24,
                color: "#8e989f",
              }}
            >
              <span>Play</span>
              <span style={{ color: brandColor }}>yld.cx</span>
              <span>{networkName ? "way on" : "way"}</span>
              {networkName && (
                <span style={socialImageNetworkStyle}>{networkName}</span>
              )}
            </div>
          </div>
        </div>
      </div>
      {fields.length > 0 && (
        <div style={{ display: "flex", gap: 16 }}>
          {fields.map(({ label, value }) => (
            <div
              key={label}
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minWidth: 0,
                gap: 4,
              }}
            >
              <span style={{ fontSize: 20, color: "#8e989f" }}>{label}</span>
              <span
                style={{
                  fontSize: value.length > 20 ? 18 : 24,
                  fontWeight: 600,
                  wordBreak: "break-all",
                }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      )}
      {strategy && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{ fontSize: 24, color: "#8e989f" }}>
            {outcome?.label ?? "Simulated outcome"}
          </span>
          <span
            style={{
              fontSize: result.length > 28 ? 38 : 62,
              fontWeight: 700,
              color:
                outcome?.value === undefined
                  ? "#f5f7f6"
                  : outcome.value < 0
                    ? "#f1a2a8"
                    : "#9fe4be",
              wordBreak: "break-all",
            }}
          >
            {result}
          </span>
          {outcome?.percent !== undefined && (
            <span
              style={{ fontSize: 24 }}
            >{`${playSigned(outcome.percent)}%`}</span>
          )}
          {quoteText && (
            <span style={{ fontSize: 24, color: "#8e989f" }}>{quoteText}</span>
          )}
        </div>
      )}
    </div>,
    {
      width: 1200,
      height: 630,
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
    },
  );
}
