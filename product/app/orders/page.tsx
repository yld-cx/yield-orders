import type { Metadata } from "next";
import { OrdersScreen } from "@/components/orders/orders-screen";
export const metadata: Metadata = {
  title: "Yield Orders",
  description: "Manage your current Provide and Use positions.",
  alternates: { canonical: "/orders" },
  robots: { index: false, follow: true },
};
export default function Page() {
  return <OrdersScreen />;
}
