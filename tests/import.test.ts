import { describe, expect, it } from "vitest";
import { importPosition } from "@/lib/import-position";
import { CLOSED_CENTER_FEN } from "@/lib/samples";

const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("import", () => {
  it("accepts a standard FEN and a four-field FEN", () => {
    const full = importPosition("  \n" + start + "\n");
    expect(full.finalFen).toBe(start);
    const four = importPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    expect(four.finalFen).toBe(start);
    expect(four.notices.join(" ")).toMatch(/default to 0 and 1/);
  });

  it("rejects an illegal FEN without inventing a board", () => {
    expect(() => importPosition("8/8/8/8/8/8/8/8 w - - 0 1")).toThrow(/king/i);
    expect(() => importPosition("not a fen")).toThrow();
  });

  it("loads a PGN main line, comments, castling zeros, and a variation notice", () => {
    const pgn = "\uFEFF[Event \"T\"]\r\n[Result \"*\"]\r\n\r\n1. e4 e5 2. Nf3 Nc6 3. Bb5 {Lopez} a6 (3... Nf6 {Berlin}) 4. Ba4 *\r\n";
    const loaded = importPosition(pgn);
    expect(loaded.sans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4"]);
    expect(loaded.notices.join(" ")).toMatch(/main line only/);
    expect(loaded.finalFen.startsWith("r1bqkbnr/1ppp1ppp/p1n5/4p3/B3P3")).toBe(true);
    const castle = importPosition("[Event \"C\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0 *\n");
    expect(castle.sans).toContain("O-O");
    expect(castle.finalFen.split(" ")[2]).toBe("kq");
  });

  it("honors SetUp and FEN, keeps castling, and can step back", () => {
    const pgn = `[SetUp "1"]\n[FEN "${CLOSED_CENTER_FEN}"]\n\n1. f4 c4 *\n`;
    const loaded = importPosition(pgn);
    expect(loaded.startFen).toBe(CLOSED_CENTER_FEN);
    expect(loaded.fens[0].split(" ")[2]).toBe("-");
    expect(loaded.fens[0].split(" ")[1]).toBe("w");
    expect(loaded.sans).toEqual(["f4", "c4"]);
    expect(loaded.fens.at(-2)?.split(" ")[1]).toBe("b");
  });

  it("rejects a second game and an illegal move", () => {
    expect(() => importPosition("[Event \"A\"]\n\n1. e4 e5 *\n\n[Event \"B\"]\n\n1. d4 *\n")).toThrow(/one game/i);
    expect(() => importPosition("1. e4 e5 2. Nf5 *")).toThrow(/illegal|invalid move/i);
  });
});
