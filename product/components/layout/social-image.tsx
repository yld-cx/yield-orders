/* eslint-disable @next/next/no-img-element -- ImageResponse renders embedded image data, not a browser page. */
import type { Token } from "@yld-cx/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
export async function tokenLogoData(
  token: Pick<Token, "logoURI">,
): Promise<string> {
  const uri =
    token.logoURI?.replace("https://yld.cx", "") ?? "/tokens/fallback.svg";
  if (!/^\/tokens\/[a-z0-9-]+\.(svg|png|webp)$/.test(uri))
    throw new Error("Invalid local token logo");
  const bytes = await readFile(path.join(process.cwd(), "public", uri));
  // ImageResponse's SVG rasterizer cannot render embedded WebP images.
  if (uri.endsWith(".webp")) {
    const png = await sharp(bytes).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  }
  const mime = uri.endsWith(".svg") ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
export function SocialImage({
  label,
  network,
  logos,
}: {
  label?: string;
  network?: string;
  logos?: readonly [string, string];
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "66px 72px",
        backgroundColor: "#000000",
        backgroundImage:
          "radial-gradient(circle at 50% -10%, rgba(0,255,76,0.07), rgba(0,255,76,0) 28%), linear-gradient(rgba(0,255,76,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,76,0.03) 1px, transparent 1px)",
        backgroundSize: "auto, 28px 28px, 28px 28px",
        color: "#f5f7f6",
        fontFamily: "sans-serif",
        border: "1px solid #26342d",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 58,
            fontWeight: 900,
            letterSpacing: -3,
            color: "#00ff4c",
          }}
        >
          yld˙ᶜˣ
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 24,
            color: "#b3bfb7",
            fontWeight: "bold",
          }}
        >
          Yield Orders {network ? `on ${network}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {logos && (
          <div style={{ display: "flex", gap: 18 }}>
            {logos.map((src, index) => (
              <img
                key={index}
                src={src}
                width={70}
                height={70}
                alt="Token logo"
                style={{ borderRadius: "50%" }}
              />
            ))}
          </div>
        )}
        <div
          style={{
            display: "flex",
            fontSize: label ? 56 : 68,
            fontWeight: 700,
            letterSpacing: -2,
          }}
        >
          {label ?? "Provide or rent tokens"}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: label ? 34 : 68,
            fontWeight: 700,
            color: "#e7b94d",
            letterSpacing: -2,
          }}
        >
          {label ? "Liquidity Rental Market" : "at your price."}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 24,
          color: "#95a59a",
        }}
      >
        <span>Asset moves. Quote locks.</span>
        <span>
          yld.cx —{" "}
          {label
            ? "provide or use tokens at your price."
            : "liquidity rental markets"}
        </span>
      </div>
    </div>
  );
}
