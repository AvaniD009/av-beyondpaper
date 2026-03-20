import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BeyondPaper — Find Elite Overlooked Engineers",
  description:
    "AI-powered GitHub talent discovery. Finds engineers with real depth — not GitHub stars.",
  keywords: ["hiring", "engineers", "github", "talent", "AI recruiting"],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
