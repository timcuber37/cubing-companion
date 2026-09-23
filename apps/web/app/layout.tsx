import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * `viewportFit: "cover"` is what makes `env(safe-area-inset-*)` report anything at all.
 *
 * Without it the browser keeps the page inside the safe area and every inset reads as zero — so
 * the tab bar's clearance for the home indicator silently did nothing. With it, the page owns the
 * full screen and the insets become real numbers the layout has to respect.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export const metadata: Metadata = {
  title: "Cubing Companion",
  description: "Record solves from a smart cube and see where the time went.",
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
