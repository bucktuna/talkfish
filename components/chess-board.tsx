"use client";

import { useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Color, Key } from "chessground/types";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";

function dests(fen: string): Map<Key, Key[]> {
  const chess = new Chess(fen);
  const map = new Map<Key, Key[]>();
  for (const move of chess.moves({ verbose: true })) {
    const from = move.from as Key;
    const list = map.get(from) ?? [];
    list.push(move.to as Key);
    map.set(from, list);
  }
  return map;
}

export function ChessBoard({
  fen,
  orientation = "white",
  interactive = true,
  onMove,
}: {
  fen: string;
  orientation?: "white" | "black";
  interactive?: boolean;
  onMove: (from: string, to: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    if (!host.current) return;
    const ground = Chessground(host.current, { coordinates: true });
    api.current = ground;
    return () => {
      ground.destroy();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    const chess = new Chess(fen);
    const turn = (chess.turn() === "w" ? "white" : "black") as Color;
    api.current?.set({
      fen,
      orientation,
      turnColor: turn,
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        color: interactive ? turn : undefined,
        dests: interactive ? dests(fen) : new Map(),
        events: { after: (from, to) => onMoveRef.current(from, to) },
      },
      animation: { enabled: true },
    });
  }, [fen, orientation, interactive]);

  return <div ref={host} className="cg-wrap" aria-label="Chessboard" />;
}
