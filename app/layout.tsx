import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MilestoneStake — escrow that blooms a milestone at a time",
  description:
    "Programmable milestone escrow for project teams on ARC. A customer funds a USDC pool over N milestones; each confirmed milestone releases its share to the contractor, late ones pay a penalty back. Settled in native USDC by agents.",
  keywords: "MilestoneStake, ARC, USDC, escrow, milestones, freelance, DeFi, agentic, payments, web3",
};

export const viewport: Viewport = { themeColor: "#1b3ceb" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
