import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cubing Companion — smart cube link",
  description: "Connect a smart cube and watch a virtual one follow.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
