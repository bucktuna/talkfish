export const OPEN_GAME_FEN =
  "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

export const CLOSED_CENTER_FEN =
  "r1bq1rk1/pp2bppp/2n1pn2/2ppP3/3P4/2NB4/PP1N1PPP/R1BQR1K1 w - - 0 10";

export const SAMPLES = [
  { id: "open", label: "Open game", fen: OPEN_GAME_FEN },
  { id: "closed", label: "Closed center", fen: CLOSED_CENTER_FEN },
] as const;
