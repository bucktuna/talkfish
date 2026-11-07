import type { Assessment, Claim } from "@/lib/types";
import { redact } from "@/lib/redact";

export type ChatMessage = { role: "system" | "user"; content: string };

export type LlmCall = {
  purpose: "assess" | "examine" | "explain";
  signal?: AbortSignal;
};

/** Ollama library name for Qwen 2.5 14B. Override with OLLAMA_MODEL if `ollama list` shows a different tag. */
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:14b";

export const DEFAULT_LLM_TIMEOUT_MS = 180_000;

export interface LlmProvider {
  id: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  complete(messages: ChatMessage[], call: LlmCall): Promise<string>;
}

const ASSESS_SYSTEM = `You are the first pass of a chess coach. You have NOT been shown the student's question and you must not invent one.
Write a brief independent reading of the position for a student who studies pawn structures, breaks, closed centers, prophylaxis, and two weaknesses.
Return JSON only: {"summary":"","hypotheses":[{"text":"","whyProvisional":""}],"questionBack":""}.
Hypotheses are provisional. Do not say a plan is proved. Do not invent historical quotations, ratings, or a diagnosis of the student.
A finite engine line is a search report, not a cause. Be concise.`;

const EXAMINE_SYSTEM = `You are the second pass of a chess coach. An independent position reading is included. Now look at the student's question.
Be a questioning coach, not a game commentator. Stay concise and offer one question back.
Do not treat these as proved: a rook move such as Rf1-e1 retiring f4; Ndf3 having only a defensive function because it blocks the f-pawn; a knight supporting e5 proving the whole strategy is restraint.
Engine scores and a legal PV do not establish why a plan is correct. Say when you are unsure.
If openingGuide is included and the student asks about plans, you may use it, and you must describe that text as curated, not engine-verified.
Return JSON only: {"reply":"","hypotheses":[""]}. Do not assign mapped, green, or certainty labels.`;

export function buildAssessmentMessages(snapshot: Record<string, unknown>): ChatMessage[] {
  if ("question" in snapshot || "userQuestion" in snapshot || "user" in snapshot) {
    throw new Error("The assessment prompt must not receive the user question.");
  }
  return [
    { role: "system", content: ASSESS_SYSTEM },
    { role: "user", content: JSON.stringify(snapshot) },
  ];
}

export function buildExamineMessages(payload: Record<string, unknown>): ChatMessage[] {
  return [
    { role: "system", content: EXAMINE_SYSTEM },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

export function parseModelJson(text: string): { summary?: string; reply?: string; hypotheses?: { text?: string; whyProvisional?: string }[] | string[]; questionBack?: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as {
      summary?: string;
      reply?: string;
      hypotheses?: { text?: string; whyProvisional?: string }[] | string[];
      questionBack?: string;
    };
  } catch {
    return null;
  }
}

export function modelAssessmentFromText(text: string): Pick<Assessment, "summary" | "hypotheses"> | null {
  const parsed = parseModelJson(text);
  if (!parsed?.summary) return null;
  const hypotheses = (parsed.hypotheses ?? []).map((item) => {
    const value = typeof item === "string" ? item : item.text || "";
    return {
      text: value,
      status: "provisional" as const,
      reason: "The model offered this before the student's question. It is not engine proof.",
    };
  }).filter((item) => item.text);
  return { summary: parsed.summary, hypotheses };
}

export function modelReplyFromText(text: string): { reply: string; hypotheses: string[] } | null {
  const parsed = parseModelJson(text);
  if (!parsed?.reply) return null;
  const hypotheses = (parsed.hypotheses ?? []).map((item) => (typeof item === "string" ? item : item.text || "")).filter(Boolean);
  return { reply: parsed.reply, hypotheses };
}

export function getProvider(): LlmProvider {
  const choice = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
  if (choice === "none" || choice === "off") return unavailable("LLM_PROVIDER is none. Engine checks still run.");
  if (choice === "openai") return openAiProvider();
  return ollamaProvider();
}

function unavailable(reason: string): LlmProvider {
  return {
    id: "none",
    async available() {
      return { ok: false, reason };
    },
    async complete() {
      throw new Error(reason);
    },
  };
}

export function configuredOllamaModel(): string {
  const value = process.env.OLLAMA_MODEL?.trim();
  return value || DEFAULT_OLLAMA_MODEL;
}

/** Exact tag match against Ollama `/api/tags` names. A near-miss is not treated as the configured model. */
export function ollamaModelPresent(names: string[], configured: string): boolean {
  const want = configured.trim();
  return names.some((name) => name.trim() === want);
}

export function ollamaAvailability(input: {
  reachable: boolean;
  status?: number;
  names: string[];
  model: string;
  host: string;
}): { ok: boolean; reason?: string } {
  if (!input.reachable) {
    return {
      ok: false,
      reason: `Ollama at ${input.host} returned ${input.status ?? "an error"}. Talkfish will not invent model prose. The coach stays engine-only, and Explain uses a facts-only gist.`,
    };
  }
  if (!ollamaModelPresent(input.names, input.model)) {
    const listed = input.names.filter(Boolean).slice(0, 8).join(", ");
    return {
      ok: false,
      reason: `Ollama at ${input.host} is up, but ${input.model} is not in /api/tags${listed ? ` (listed: ${listed})` : ""}. Set OLLAMA_MODEL to a listed name. Talkfish will not invent model prose. The coach stays engine-only, and Explain uses a facts-only gist.`,
    };
  }
  return { ok: true };
}

function ollamaProvider(): LlmProvider {
  const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = configuredOllamaModel();
  return {
    id: "ollama",
    async available() {
      try {
        const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) return ollamaAvailability({ reachable: false, status: response.status, names: [], model, host: hostOf(base) });
        const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
        const names = (body.models ?? []).flatMap((item) => [item.name, item.model].filter((value): value is string => Boolean(value)));
        return ollamaAvailability({ reachable: true, names, model, host: hostOf(base) });
      } catch {
        return {
          ok: false,
          reason: `No local model responded at ${hostOf(base)} (OLLAMA_MODEL=${model}). Talkfish will not invent model prose. The coach stays engine-only, and Explain uses a facts-only gist.`,
        };
      }
    },
    complete(messages, call) {
      return postJson(
        `${base}/api/chat`,
        {
          model,
          messages,
          stream: false,
          format: "json",
          options: { temperature: 0.2 },
        },
        undefined,
        call.signal,
        async (body) => {
          const content = (body as { message?: { content?: string } }).message?.content;
          if (!content) throw new Error("Ollama returned an empty message.");
          return content;
        },
      );
    },
  };
}

function openAiProvider(): LlmProvider {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const key = process.env.OPENAI_API_KEY;
  return {
    id: "openai",
    async available() {
      if (!key) return { ok: false, reason: "An OpenAI-compatible provider is selected, but OPENAI_API_KEY is not set. No model text was invented." };
      return { ok: true };
    },
    complete(messages, call) {
      if (!key) throw new Error("OPENAI_API_KEY is not set.");
      return postJson(
        `${base}/chat/completions`,
        { model, messages, temperature: 0.2, response_format: { type: "json_object" } },
        key,
        call.signal,
        async (body) => {
          const content = (body as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
          if (!content) throw new Error("The provider returned an empty message.");
          return content;
        },
      );
    },
  };
}

async function postJson(
  url: string,
  payload: unknown,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
  read: (body: unknown) => Promise<string>,
): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const configured = Number(process.env.LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured >= 1000 ? configured : DEFAULT_LLM_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: composed });
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : "Model request failed"));
  }
  if (!response.ok) {
    throw new Error(`The model provider returned ${response.status}.`);
  }
  return read(await response.json());
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured host";
  }
}

export function provisionalModelClaims(hypotheses: string[]): Claim[] {
  return hypotheses.filter(Boolean).map((text, index) => ({
    id: `model-hypothesis-${index + 1}`,
    text,
    status: "provisional" as const,
    kind: "strategic" as const,
    reason: "The model suggested this. It was not promoted because a model said it.",
    evidence: ["Second-pass model text, after the independent assessment."],
  }));
}
