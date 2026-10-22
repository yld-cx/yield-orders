/* eslint-disable @next/next/no-img-element -- ImageResponse renders embedded image data, not a browser page. */
import type { Token } from "@yld-cx/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { tokenImageUrl } from "@/lib/token-metadata";
export async function tokenLogoData(
  token: Pick<Token, "imageUrl">,
): Promise<string> {
  const fallback = async () =>
    `data:image/svg+xml;base64,${(await readFile(path.join(process.cwd(), "public/token.svg"))).toString("base64")}`;
  const url = tokenImageUrl(token.imageUrl);
  if (!url) return fallback();
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (
      !response.ok ||
      !/^image\/(png|jpeg|webp|gif|avif|svg\+xml)(;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      throw new Error("Invalid image");
    }
    const limit = 2 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new Error("Image too large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing image");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("Image too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    // Rasterize all remote formats and bound decoded pixels before embedding.
    const png = await sharp(bytes, { limitInputPixels: 16_000_000 })
      .resize(140, 140, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return fallback();
  }
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
        padding: "100px",
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
          Yield Orders {network ? `on ${network}` : ""} 👑
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {logos && (
          <div style={{ display: "flex", gap: 20 }}>
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
          yld.cx ·{" "}
          {label ? "provide or use tokens at your price." : "time to yield."}
        </span>
      </div>
    </div>
  );
}
