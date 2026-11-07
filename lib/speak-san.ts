const PIECE: Record<string, string> = {
  N: "knight",
  B: "bishop",
  R: "rook",
  Q: "queen",
  K: "king",
  P: "pawn",
};

/** Speak one SAN, for example Nf3 as "knight f3". */
export function speakSan(san: string): string {
  const check = san.includes("#") ? " checkmate" : san.includes("+") ? " check" : "";
  const clean = san.replace(/[+#!?]/g, "");
  if (clean === "O-O" || clean === "0-0") return `castles kingside${check}`;
  if (clean === "O-O-O" || clean === "0-0-0") return `castles queenside${check}`;
  const promo = clean.match(/=([QRBN])/);
  let body = clean.replace(/=[QRBN]/, "");
  const takes = body.includes("x");
  body = body.replace("x", "");
  let piece = "pawn";
  if (/^[NBRQK]/.test(body)) {
    piece = PIECE[body[0]] ?? "piece";
    body = body.slice(1);
  }
  const dest = body.slice(-2);
  const disambiguation = body.slice(0, -2);
  const from = disambiguation ? ` ${disambiguation}` : "";
  const promoWord = promo ? ` promotes to ${PIECE[promo[1]] ?? "piece"}` : "";
  if (takes) return `${piece}${from} takes ${dest}${promoWord}${check}`;
  return `${piece}${from} ${dest}${promoWord}${check}`;
}

const SAN_TOKEN =
  /\b(?:O-O-O|O-O|0-0-0|0-0|[NBRQK][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?)\b/g;

/** Replace SAN tokens in a sentence so read-aloud says "knight f3" rather than the letters Nf3. */
export function speakChessText(text: string): string {
  return text.replace(SAN_TOKEN, (token) => speakSan(token));
}
