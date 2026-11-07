import type { EngineScore } from "@/lib/types";

export function formatWhiteScore(score: EngineScore | null): string {
  if (!score) return "no score";
  if (score.kind === "mate") {
    if (score.value > 0) return `mate in ${score.value} for White`;
    if (score.value < 0) return `mate in ${-score.value} for Black`;
    return "mate";
  }
  const pawns = (score.value / 100).toFixed(2);
  const sign = score.value > 0 ? "+" : "";
  const bound =
    score.bound === "lower" ? ", or better for White" : score.bound === "upper" ? ", or worse for White" : "";
  return `${sign}${pawns} from White's side${bound}`;
}

/** Centipawn-like magnitude from White's side. Mate in 1 outranks mate in 5. */
export function whiteMilli(score: EngineScore): number {
  if (score.kind === "cp") return score.value;
  const sign = Math.sign(score.value) || 0;
  return sign * (100_000 - Math.abs(score.value));
}
