import type { Metadata } from "next";

import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
