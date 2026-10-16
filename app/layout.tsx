import type { Metadata } from "next";

import "./globals.css";
import { RunControlOverlay } from "@/components/run-control-overlay";

export const metadata: Metadata = {
  title: "NBN Agent Control Room",
  description:
    "Agentic NBN signup runner with self-healing and isolated payment execution",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}<RunControlOverlay /></body>
    </html>
  );
}
