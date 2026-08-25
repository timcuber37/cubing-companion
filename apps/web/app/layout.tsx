import type { Metadata } from "next";
import "./globals.css";

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
