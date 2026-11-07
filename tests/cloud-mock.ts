import { Chess } from "chess.js";
import type { CloudFetcher } from "@/lib/lichess-cloud";

export const defaultCloudFetch: CloudFetcher = async (url) => {
  const parsed = new URL(url);
  if (parsed.pathname.includes("/api/games/user/")) {
    return { status: 404, body: JSON.stringify({ error: "not found" }) };
  }
  const fen = parsed.searchParams.get("fen");
  if (!fen) return { status: 400, body: "" };
  const chess = new Chess(fen);
  const move = chess.moves({ verbose: true })[0];
  if (!move) return { status: 404, body: JSON.stringify({ error: "none" }) };
  const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
  return {
    status: 200,
    body: JSON.stringify({ fen, knodes: 12, depth: 24, pvs: [{ moves: uci, cp: 12 }] }),
  };
};
