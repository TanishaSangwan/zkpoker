import type { Metadata } from "next";
import PokerPageClient from "./PokerPageClient";

export const metadata: Metadata = {
  title: "zkpoker · PokerGame",
  description: "Provably fair on-chain poker for the STRK20 hackathon — drive PokerGame's contract actions directly.",
};

export default function PokerPage() {
  return <PokerPageClient />;
}
