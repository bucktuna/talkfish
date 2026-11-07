# Talkfish

## Mission

Talkfish is a free, open-source voice and text chess coach powered by Stockfish. Its goal is to help people understand positions and moves, not just receive a best-move recommendation.

Stockfish supplies its best move, evaluation, search depth and principal variation. A language-model layer turns that evidence into coaching explanations. It first assesses the position independently, then weighs the learner’s idea, incorporating or challenging it as the evidence warrants.

For each position or move, green marks an explanation whose concrete claims have engine support; reddish marks open or provisional interpretations: “I’m still learning this spot—want to help?” Session memory tracks positions and responses to avoid repeating understood ideas and explore recurring gaps. Unverified explanations stay explicitly provisional.

Every instance starts from shared chess knowledge; coaching requires no account. Free accounts are needed to contribute explanations. Only position-derived chess content enters shared knowledge—never private conversations or credentials. Engine-verified support outweighs popularity. The first downvote flags review; reputation impact requires review, at least three distinct eligible accounts and sufficient combined vote weight. Each voter’s weight reflects their track record of engine-verified contributions.

The interface stays simple: a Chessground board and a conversation. Paste a PGN or FEN, talk or type, and read or hear the reply.

## Current prototype status and limitations

This section is what this tree actually does. It is not the mission statement.

The engine source in this copy is the Lichess cloud evaluation: a stored Stockfish result for common positions, fetched with no key. A local Stockfish binary is not required. A position that is not in that cache is labelled provisional and unverified.

A real microphone and speaker were not used. Typing works with speech APIs missing. Browser speech, when the browser offers it, is not a guaranteed offline recognizer, and this app does not store audio. The configured coach model is whatever `OLLAMA_MODEL` names (default `qwen2.5:14b` at `http://127.0.0.1:11434`). Talkfish asks Ollama `/api/tags` and does not call a tag that is not listed. If Ollama is absent or the tag is missing, the coach stays engine-only and Explain uses a facts-only gist. It does not invent model prose.

Repeat-avoidance is session-local only. The browser tab keeps a session id in `sessionStorage`, and the server process remembers which points that tab already heard so a later reply in the same tab can be shorter. That record is not a durable personal mastery profile, it is not written into `corpus/`, and it is not an export of the conversation. Shared learning is the chess corpus shipped with the source: position keys, claims, evidence, and provenance. Raw chat, audio, accounts, passwords, and voter identities stay out of it.

The screen uses three labels, not color alone: Mapped, Provisional, and Open. The open invitation in the product is “I'm still learning this spot, want to help?” Mapped is a checked board or search fact. A high depth, a legal line, or agreement does not turn a plan into Mapped. Provisional and Open are the reddish readings.

Other limits of this copy:

- Not production-ready. One Node process. Rate limits are in memory and are not shared across instances. The Lichess client is also one process: one request at a time, an in-memory cache, and an optional file under `DATA_DIR`. There is no HTTPS, no durable database, no backups, and no shared vote service between machines.
- The public repository is https://github.com/bucktuna/talkfish. This package does not change its visibility. There is no hosted deployment.
- `npm run update:source` and `npm run corpus:pull` fast-forward one configured git remote. They refuse a dirty tree, a missing remote, and any history that is not a fast-forward. They do not send local commits anywhere and they do not delete local work. Corpus pull accepts only paths under `corpus/` and rejects private fields. `npm run corpus:export` copies the bundled chess JSON and does not read `data/`. Pending contributions are not exported. The intended remote, once access is allowed, is https://github.com/bucktuna/talkfish. It is not configured here, and these commands were not pointed at it. A zip/archive download does not keep fetching that remote; only a git clone with the remote configured can fast-forward later. Tests for this behavior use temporary local repositories.
- Docker Compose is not included.
- Dependency audit after a compatible PostCSS override to 8.5.32: the high PostCSS findings in Next's toolchain are cleared. Vitest 3.2.7 (dev only) still depends on tinypool 1.1.1. npm audit still reports those as critical ([GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)) plus Vitest path traversal [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). The audit's fix is Vitest 5, a major upgrade that was not applied. They do not run inside the coach server.

## Run

Requires Node 22. The default engine is the public Lichess cloud evaluation (`ENGINE_PROVIDER=lichess`). It needs no install and no key. A local Stockfish binary is optional: set `ENGINE_PROVIDER=uci` and install Stockfish on the PATH or at `/usr/games/stockfish` or `/usr/local/bin/stockfish`. The binary is not bundled.

Lichess stores roughly 320 million positions, mostly openings and other common positions. A miss is labelled provisional and unverified. Requests are serialized. A 429 pauses lookups for 60 seconds.

Possible future fallback engines, not wired in: [chess-api.com](https://chess-api.com) and [stockfish.online](https://stockfish.online). Both are key-based. This copy does not call them and does not read a key for them.

```bash
npm install
npm run dev
```

Open http://127.0.0.1:43123 . The server binds to `127.0.0.1` port `43123`.

```bash
npm test
```

Regenerate the shared corpus from a live Stockfish search:

```bash
npm run seed:corpus
```

Copy `.env.example` to `.env.local` only if you want to change the engine limits or point at a model. A basic local run does not ask for an API key.

Default model setting is Ollama at `http://127.0.0.1:11434`, model `qwen2.5:14b` (Qwen 2.5 14B). Set `OLLAMA_MODEL` to the exact name from `ollama list` if your tag differs. The first reply can take about 100 seconds while that model loads; `LLM_TIMEOUT_MS` defaults to 180000, and Explain shows "Thinking…" while it waits. If `/api/tags` does not list the configured name, Talkfish says so and does not call it.

```bash
# optional, on a machine that already has Ollama
ollama serve
ollama pull qwen2.5:14b
```

An OpenAI-compatible server is optional and stays in environment variables read only on the server. The browser never receives the key.

## What this copy does

- Chessground board, legal moves, undo, reset, flip, and two sample positions (open game, closed center).
- One PGN or FEN box. Four-field FENs keep the turn, castling, and en passant, and fill only the halfmove clock and fullmove number with 0 and 1. PGN loads the main line to its final position, honors a `SetUp`/`FEN` pair, accepts `0-0` as castling, and tells you when a side variation was left out. A second game or an illegal move is rejected and the previous board stays.
- Engine results keep the same shape: best move, depth, White's-point-of-view score (including mate), legal PV, and SAN. The default source is Lichess cloud eval. `ENGINE_PROVIDER=uci` still runs a local Stockfish search, bounded, and killed on cancel or timeout.
- Curated opening guides for the major families (Sicilian and its main lines, Ruy Lopez, Italian, French, Caro-Kann, Queen's Gambit, King's Indian, London, English, Scandinavian, and others). A match shows a compact "How to play this opening" panel. The text is labelled curated, not engine-verified. The coach can use it when you ask about a plan.
- Explain, under the board and on each review moment, gives a short gist of that position: who is better, a plan for each side, what to watch, and the best move's idea. A stored cloud eval is labelled engine-checked. Otherwise the gist is provisional and uses board facts plus the opening guide. The model only rephrases those facts. Read-aloud says Nf3 as "knight f3".
- Game review: load a PGN, or fetch a Lichess username's recent public games, then read turning points. Cloud hits are marked engine-verified. Missing positions stay heuristic, using the board. The review ends with two or three concrete recommendations. Click a moment to jump the board there.
- Two server steps: an assessment that does not receive the question, then a look at the question. Without a model, the second step is an engine-and-board reply labeled engine-only.
- Mapped, provisional, and open claims, with the words and icons, not color alone. A high depth or a legal PV does not make a plan mapped. Open replies include "I'm still learning this spot, want to help?"
- Shared corpus in `corpus/`, loaded with no account and no private database. The closed-center note says the rook on e1 does not decide whether f4 is still a plan, and that claim stays open.
- Bundled opening names from Lichess `chess-openings` commit `3ba6b20d31b2e6125cb0e6a2e792f400717d9d39` (2026-11-05), CC0-1.0. This snapshot has 3,865 catalog lines, 3,865 unique final positions, and 500 ECO codes, including Italian Game (C50) and Sicilian Defense (B20). A match is provisional. It is not a mapped evaluation.
- Contributor accounts (scrypt passwords, HttpOnly `talkfish_session` cookie, same-origin checks). Submissions start pending or quarantined. They are not written into the packaged corpus.
- Weighted downvotes under policy `weight-policy-1`. See below. Votes do not overturn an engine-mapped fact.

## Vote weights

Computed on the server. A client-sent weight is ignored.

- `C` distinct engine-confirmed contributions, `D` distinct disproven ones, `U` upvotes received, `R` downvotes received.
- `pop = (U + 2) / (U + R + 4)`. `popMult = clamp(1 + 0.2 * (pop - 0.5), 0.9, 1)`. Popularity cannot raise a weight.
- Established only when `C >= 5` and `C >= 2 * D`.
- Otherwise the weight is `clamp(0.05 * popMult, 0.04, 0.05)`.
- If established, `strength = clamp((C - D - 5) / 10, 0, 1)` and the weight is `clamp((0.75 + 0.25 * strength) * popMult, 0.60, 1)`.
- A reputation penalty becomes eligible only after a moderator adjudication, and only when at least 3 other accounts downvoted and the counted weight is at least 1.00. Newcomer weights on one revision are capped together at 0.45. The floor of 3 cannot be configured lower (`REPUTATION_MIN_DISTINCT` may only raise it).
- Example: a new account weighs 0.05. Ten of them sum to 0.50 and count as 0.45. One account with `C = 15` and `D = 0` weighs 1.00. Three new accounts (0.15) are not eligible. That strong account plus two new accounts (1.10) is eligible. One voter alone is never enough.
- Three accounts are not three proven humans. Guest reports never count. The first downvote flags review and does not penalize anyone. At most one reversible penalty is recorded per revision. This is one process's memory, not a global vote database.

## Storage

`corpus/` ships with the source and is the shared chess baseline. `data/operational.json` is created at runtime for accounts, votes, and pending submissions. It is gitignored and is not part of the source archive. Audio is not stored. The tab keeps a short session id in `sessionStorage` so a repeat in the same tab can be shorter. That is not a mastery profile.

## Tests that were run

`npm test` covers the Lichess adapter with mocked HTTP (a stored line, White's score when Black is to move, SAN, 404, 429 backoff, cache, cancellation), terminal checkmate, invalid FEN, and the local Stockfish path when a binary is installed. It also covers PGN/FEN import, opening guides, game review, the assessment-before-question loop, the closed-center f4 challenge staying open, vote weights, guest coaching, rejected guest submissions, quarantine of an email, ignored client weights, and report rate limits. The suite does not need Stockfish installed.

A real microphone and speaker were not used. The automated `npm test` suite does not require Ollama or Stockfish. It uses a missing or mock provider, and it checks that a model tag absent from `/api/tags` stays facts-only.

## License

GPL-3.0-or-later, because the app links Chessground (GPL-3.0-or-later, https://github.com/lichess-org/chessground). `LICENSE` is the GPL text. Stockfish is GPL-3.0 and is not bundled; install the distro package (source: https://github.com/official-stockfish/Stockfish). chess.js is BSD-2-Clause.
