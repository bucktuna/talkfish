const SECRET_ENV = ["OPENAI_API_KEY", "BOOTSTRAP_TOKEN"] as const;

export function redact(text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  out = out.replace(/bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "bearer [redacted]");
  out = out.replace(/talkfish_session=[^;\s]+/gi, "talkfish_session=[redacted]");
  return out;
}
