"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Check, CircleDashed, CircleHelp, Mic, Square } from "lucide-react";
import { ChessBoard } from "@/components/chess-board";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { importPosition, type ImportedLine } from "@/lib/import-position";
import { sideToMoveLabel, START_FEN } from "@/lib/fen";
import { SAMPLES } from "@/lib/samples";
import type { Claim, ClaimStatus, CoachResponse } from "@/lib/types";
import { OPEN_INVITATION } from "@/lib/types";

type Line = {
  fens: string[];
  sans: string[];
  cursor: number;
  anchor: number;
  notices: string[];
};

type ChatMessage = {
  id: string;
  role: "user" | "coach";
  text: string;
  fen: string;
  claims?: Claim[];
  invitation?: string;
  response?: CoachResponse;
};

type SpeechState = {
  stt: boolean;
  tts: boolean;
  error: string | null;
};

function initialLine(): Line {
  return { fens: [START_FEN], sans: [], cursor: 0, anchor: 0, notices: [] };
}

function currentFen(line: Line): string {
  return line.fens[Math.max(0, Math.min(line.cursor, line.fens.length - 1))];
}

function historyPayload(line: Line): { startFen?: string; historySans?: string[] } {
  if (line.cursor <= 0) return {};
  return { startFen: line.fens[0], historySans: line.sans.slice(0, line.cursor) };
}

export function CoachApp() {
  const [line, setLine] = useState<Line>(initialLine);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [pendingPromo, setPendingPromo] = useState<{ from: string; to: string } | null>(null);
  const [pv, setPv] = useState<{ sans: string[]; cursor: number; base: string } | null>(null);
  const [speech, setSpeech] = useState<SpeechState>({ stt: true, tts: true, error: null });
  const [listening, setListening] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const fen = pv ? pvFen(pv) : currentFen(line);
  const displayFen = fen;

  useEffect(() => {
    const key = "talkfish-session";
    const existing = window.sessionStorage.getItem(key);
    const id = existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing) ? existing : crypto.randomUUID().replace(/-/g, "");
    window.sessionStorage.setItem(key, id);
    sessionRef.current = id;
    const speechWindow = window as Window & { webkitSpeechRecognition?: unknown; SpeechRecognition?: unknown };
    setSpeech({
      stt: Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition),
      tts: "speechSynthesis" in window,
      error: null,
    });
  }, []);

  useEffect(() => {
    const token = ++seq.current;
    void refresh(currentFen(line), token);
    return () => {
      abortRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
    // Orientation follows the board. The seq check drops a late response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.fens, line.cursor]);

  const notices = line.notices;

  function stopSpeech() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }

  function speak(text: string) {
    if (!readAloud || !speech.tts) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      setSpeech((current) => ({ ...current, error: "Reading aloud failed in this browser." }));
    };
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  function adopt(next: Line) {
    abortRef.current?.abort();
    setPv(null);
    setPendingPromo(null);
    setLine(next);
    setMessages([]);
    setAskError(null);
  }

  async function refresh(boardFen: string, token: number) {
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const corpusResponse = await fetch(`/api/corpus?fen=${encodeURIComponent(boardFen)}`, { signal: controller.signal });
      const corpus = (await corpusResponse.json()) as {
        version?: string;
        baseline?: { explanation: string; claims: Claim[]; revisionId: string } | null;
        error?: string;
      };
      if (token !== seq.current) return;
      const orientResponse = await fetch("/api/orient", {
        method: "POST",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({ fen: boardFen, ...historyPayload(line) }),
        signal: controller.signal,
      });
      const orient = (await orientResponse.json()) as CoachResponse & { error?: string };
      if (token !== seq.current || orient.fen !== boardFen) return;
      const text = corpus.baseline?.explanation
        ? `${corpus.baseline.explanation}\n\n${orient.reply}`
        : orient.reply;
      const claims = [...(corpus.baseline?.claims ?? []), ...(orient.claims ?? [])].slice(0, 6);
      setMessages([
        {
          id: crypto.randomUUID(),
          role: "coach",
          text,
          fen: boardFen,
          claims,
          invitation: claims.some((claim) => claim.status === "open") ? OPEN_INVITATION : undefined,
          response: orient,
        },
      ]);
      if (orient.engine?.pvSan?.length) {
        setPv(null);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (token === seq.current) setAskError("The position check did not finish.");
    } finally {
      if (token === seq.current) setBusy(false);
    }
  }

  function loadImport() {
    try {
      const imported = importPosition(importText);
      const anchor = imported.fens.length - 1;
      adopt({
        fens: imported.fens,
        sans: imported.sans,
        cursor: anchor,
        anchor,
        notices: imported.notices,
      });
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not load that position.");
    }
  }

  function playUserMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n") {
    if (pv) return;
    const chess = new Chess(currentFen(line));
    const choices = chess.moves({ verbose: true }).filter((move) => move.from === from && move.to === to);
    if (!choices.length) return;
    if (!promotion && choices.some((move) => move.promotion)) {
      setPendingPromo({ from, to });
      return;
    }
    const move = chess.move({ from, to, promotion: promotion ?? "q" });
    if (!move) return;
    setPendingPromo(null);
    const sans = line.sans.slice(0, line.cursor).concat(move.san);
    const fens = line.fens.slice(0, line.cursor + 1).concat(chess.fen());
    adopt({ ...line, sans, fens, cursor: sans.length });
  }

  async function ask() {
    const text = question.trim();
    if (!text) return;
    const boardFen = currentFen(line);
    const token = ++seq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setQuestion("");
    setAskError(null);
    setBusy(true);
    setMessages((current) => current.concat({ id: crypto.randomUUID(), role: "user", text, fen: boardFen }));
    try {
      const response = await fetch("/api/coach", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: window.location.origin,
          "x-coach-session": sessionRef.current,
        },
        body: JSON.stringify({ fen: boardFen, question: text, requestId: crypto.randomUUID(), ...historyPayload(line) }),
        signal: controller.signal,
      });
      const body = (await response.json()) as CoachResponse & { error?: string };
      if (token !== seq.current || body.fen !== currentFen(line)) return;
      if (!response.ok) {
        setAskError(body.error || "The coach did not answer.");
        return;
      }
      setMessages((current) =>
        current.concat({
          id: crypto.randomUUID(),
          role: "coach",
          text: body.reply,
          fen: body.fen,
          claims: body.claims,
          invitation: body.invitation,
          response: body,
        }),
      );
      speak(body.reply);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (token === seq.current) setAskError("The coach did not answer.");
    } finally {
      if (token === seq.current) setBusy(false);
    }
  }

  function toggleMic() {
    const speechWindow = window as Window & {
      webkitSpeechRecognition?: new () => SpeechRec;
      SpeechRecognition?: new () => SpeechRec;
    };
    const Ctor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Ctor) {
      setSpeech((current) => ({
        ...current,
        stt: false,
        error: "Speech recognition isn't available in this browser. Typing still works.",
      }));
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const said = event.results?.[0]?.[0]?.transcript ?? "";
      setQuestion((current) => (current ? `${current} ${said}` : said));
    };
    recognition.onerror = (event) => {
      setListening(false);
      const code = event.error || "error";
      const detail =
        code === "not-allowed"
          ? "Microphone permission was denied. Typing still works. This app does not receive audio unless the browser recognizer runs."
          : `Speech recognition failed (${code}). Typing still works.`;
      setSpeech((current) => ({ ...current, error: detail }));
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  const side = sideToMoveLabel(displayFen);
  const openingLabel = [...messages].reverse().find((message) => message.response?.opening)?.response?.opening?.label;

  const speechNote = useMemo(() => {
    if (speech.error) return speech.error;
    if (!speech.stt || !speech.tts) {
      return "Voice input or reading aloud isn't available in this browser. Typing and on-screen text still use the same coach. Browser speech is not a guaranteed offline recognizer, and this app does not store audio.";
    }
    return "Typing and the microphone use the same coach. Speech stays in the browser, may be sent to the browser vendor, and is not stored here.";
  }, [speech]);

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">Talkfish</h1>
        <div className="top-actions">
          <button className="linkish" type="button" onClick={() => dialogRef.current?.showModal()}>
            Contribute
          </button>
        </div>
      </header>
      <main className="stage">
        <section className="board-column" data-fen={displayFen} data-testid="board">
          <div className="board-frame">
            <ChessBoard fen={displayFen} orientation={orientation} interactive={!pv} onMove={(from, to) => playUserMove(from, to)} />
          </div>
          <div className="under-board">
            <span className="turn-label">{side} to move</span>
            {openingLabel ? <span className="turn-label">{openingLabel}</span> : null}
            <Button variant="outline" size="sm" type="button" onClick={() => setLine((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) }))} disabled={Boolean(pv) || line.cursor === 0}>
              Undo
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => adopt({ ...line, fens: line.fens.slice(0, line.anchor + 1), sans: line.sans.slice(0, line.anchor), cursor: line.anchor })}
              disabled={Boolean(pv) || (line.cursor === line.anchor && line.fens.length === line.anchor + 1)}
            >
              Reset
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => setOrientation((value) => (value === "white" ? "black" : "white"))}>
              Flip
            </Button>
            {line.fens.length > 1 ? (
              <>
                <Button variant="outline" size="sm" type="button" aria-label="Previous ply" onClick={() => setLine((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) }))}>
                  Previous ply
                </Button>
                <Button variant="outline" size="sm" type="button" aria-label="Next ply" disabled={line.cursor >= line.fens.length - 1} onClick={() => setLine((current) => ({ ...current, cursor: Math.min(current.fens.length - 1, current.cursor + 1) }))}>
                  Next ply
                </Button>
              </>
            ) : null}
          </div>
          {pendingPromo ? (
            <div className="under-board" role="group" aria-label="Choose promotion">
              {(["q", "r", "b", "n"] as const).map((piece) => (
                <Button key={piece} size="sm" type="button" onClick={() => playUserMove(pendingPromo.from, pendingPromo.to, piece)}>
                  {piece.toUpperCase()}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="examples">
            {SAMPLES.map((sample) => (
              <button
                key={sample.id}
                className="linkish"
                type="button"
                onClick={() => {
                  setImportText(sample.fen);
                  const imported = importPosition(sample.fen);
                  adopt({ fens: imported.fens, sans: imported.sans, cursor: 0, anchor: 0, notices: imported.notices });
                }}
              >
                {sample.label}
              </button>
            ))}
          </div>
          <div className="import-box">
            <label>
              PGN or FEN
              <Textarea
                aria-label="PGN or FEN"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                rows={3}
                placeholder="Paste a FEN or one PGN game"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") loadImport();
                }}
              />
            </label>
            <div className="row-actions">
              <Button type="button" onClick={loadImport}>
                Load
              </Button>
            </div>
            {importError ? <p className="alert" role="alert">{importError}</p> : null}
            {notices.map((notice) => (
              <p className="note" key={notice}>{notice}</p>
            ))}
          </div>
        </section>
        <section className="talk" aria-label="Conversation" data-testid="conversation" data-current-fen={currentFen(line)}>
          <div className="messages">
            {messages.length === 0 ? (
              <p>Paste a game or a FEN, then ask about the position. Typed text and speech go through the same check.</p>
            ) : null}
            {messages.map((message) => (
              <article key={message.id} className={`bubble ${message.role}`} data-fen={message.fen}>
                <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{message.text}</p>
                {message.claims?.length ? (
                  <ul className="chips">
                    {message.claims.filter((claim) => claim.kind !== "catalog").slice(0, 4).map((claim) => (
                      <li key={claim.id} className={`chip ${claim.status}`}>
                        <StatusIcon status={claim.status} />
                        <span><span className="badge-word">{labelFor(claim.status)}. </span>{claim.text}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {message.invitation ? <p className="note">{message.invitation}</p> : null}
                {message.response?.engine ? (
                  <details>
                    <summary>Evidence</summary>
                    <p className="note">
                      {message.response.engine.engineName} depth {message.response.engine.depth}. {message.response.engine.scoreWhiteLabel}. Preference is {message.response.engine.preference.status}, separate from explanation status.
                    </p>
                    {message.response.engine.pvSan.length ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setPv({ sans: message.response!.engine!.pvSan, cursor: 0, base: message.fen })}
                      >
                        Play line
                      </Button>
                    ) : null}
                    <div className="row-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const revisionId = message.response?.baselineRevisionId;
                          if (!revisionId) return;
                          void fetch("/api/reports", {
                            method: "POST",
                            headers: { "content-type": "application/json", origin: window.location.origin },
                            body: JSON.stringify({ revisionId }),
                          });
                        }}
                      >
                        Report
                      </Button>
                    </div>
                  </details>
                ) : null}
              </article>
            ))}
            {busy ? <p className="note">Checking the position…</p> : null}
            {askError ? <p className="alert" role="alert">{askError}</p> : null}
            {pv ? (
              <div className="row-actions">
                <span className="note">Engine line {pv.cursor}/{pv.sans.length}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => setPv({ ...pv, cursor: Math.min(pv.sans.length, pv.cursor + 1) })}>Next</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setPv(null)}>Back to the position</Button>
              </div>
            ) : null}
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <div className="composer-row">
              <label style={{ flex: 1 }}>
                <span className="note">Question</span>
                <Textarea
                  aria-label="Question"
                  value={question}
                  rows={2}
                  placeholder="Ask about the plan. Ctrl+Enter sends."
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      void ask();
                    }
                  }}
                />
              </label>
              <Button type="button" size="icon" variant="outline" aria-label="Microphone" aria-pressed={listening} onClick={toggleMic}>
                <Mic aria-hidden="true" size={16} />
              </Button>
              <Button type="submit" disabled={busy || !question.trim()}>Ask</Button>
            </div>
            <div className="row-actions">
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={readAloud}
                  onChange={(event) => {
                    setReadAloud(event.target.checked);
                    if (!event.target.checked) stopSpeech();
                  }}
                />
                Read replies aloud
              </label>
              {speaking ? (
                <Button type="button" size="sm" variant="outline" onClick={stopSpeech} aria-label="Stop reading">
                  <Square aria-hidden="true" size={12} /> Stop
                </Button>
              ) : null}
            </div>
            <p className="note">{speechNote}</p>
          </form>
        </section>
      </main>
      <dialog ref={dialogRef} aria-label="Contribute">
        <ContributePanel fen={currentFen(line)} onClose={() => dialogRef.current?.close()} />
      </dialog>
      </div>
  );
}

function StatusIcon({ status }: { status: ClaimStatus }) {
  if (status === "mapped") return <Check aria-hidden="true" size={16} />;
  if (status === "provisional") return <CircleDashed aria-hidden="true" size={16} />;
  return <CircleHelp aria-hidden="true" size={16} />;
}

function labelFor(status: ClaimStatus): string {
  if (status === "mapped") return "Mapped";
  if (status === "provisional") return "Provisional";
  return "Open";
}

function pvFen(pv: { sans: string[]; cursor: number; base: string }): string {
  const chess = new Chess(pv.base);
  for (const san of pv.sans.slice(0, pv.cursor)) {
    const move = chess.move(san);
    if (!move) break;
  }
  return chess.fen();
}

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results?: { 0?: { 0?: { transcript?: string } } } }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function ContributePanel({ fen, onClose }: { fen: string; onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [explanation, setExplanation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/auth/me")
      .then((response) => response.json())
      .then((body: { anonymous?: boolean; user?: { username: string } }) => {
        setMe(body.user?.username ?? null);
      })
      .catch(() => setMe(null));
  }, []);

  async function auth(path: "signup" | "login") {
    const response = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: window.location.origin },
      body: JSON.stringify({ username, password }),
    });
    const body = (await response.json()) as { error?: string; user?: { username: string } };
    if (!response.ok) {
      setMessage(body.error || "Could not sign in.");
      return;
    }
    setMe(body.user?.username ?? username);
    setPassword("");
    setMessage(null);
  }

  async function submit() {
    const response = await fetch("/api/contributions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: window.location.origin },
      body: JSON.stringify({ fen, explanation }),
    });
    const body = (await response.json()) as { error?: string; revision?: { status: string } };
    setMessage(response.ok ? `Saved as ${body.revision?.status}. It is not the trusted baseline.` : body.error || "Not saved.");
  }

  return (
    <div className="stack">
      <h2 style={{ fontFamily: "Georgia, serif", margin: 0 }}>Contribute</h2>
      <p className="note">Coaching does not need an account. An account is only for submitting an explanation to the review queue on this machine.</p>
      {me ? <p>Signed in as {me}.</p> : null}
      {!me ? (
        <>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
          </label>
          <div className="row-actions">
            <Button type="button" onClick={() => void auth("login")}>Sign in</Button>
            <Button type="button" variant="outline" onClick={() => void auth("signup")}>Create account</Button>
          </div>
        </>
      ) : (
        <>
          <label>
            Explanation for this position
            <Textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} rows={4} />
          </label>
          <Button type="button" onClick={() => void submit()}>Submit for review</Button>
        </>
      )}
      {message ? <p role="status">{message}</p> : null}
      <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
    </div>
  );
}
