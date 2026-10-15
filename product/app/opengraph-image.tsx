import { ImageResponse } from "next/og";
import { SocialImage } from "@/components/layout/social-image";
export const alt =
  "yld.cx — liquidity rental markets. Provide or rent tokens at your price.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default function Image() {
  return new ImageResponse(<SocialImage />, size);
}
