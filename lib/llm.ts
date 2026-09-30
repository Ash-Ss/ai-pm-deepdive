/**
 * The single entry point for every LLM call (server-side only).
 *
 *   callLLM({ name, system, prompt, schema, temperature }) → { data, meta }
 *
 * - Gemini JSON mode with a response schema derived from the zod schema, then
 *   strict zod validation of whatever comes back (the schema only guides Gemini).
 * - 1 retry on invalid output, with the validation error fed back.
 * - Exponential backoff on 429 / 5xx.
 * - Dev cache (LLM_CACHE=true): hash(model + system + prompt + schema) → /.cache/llm.
 * - Logs name, timing and token counts only — never the prompt or the key.
 */
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { z } from "zod";

const DEFAULT_MODEL = "gemini-flash-latest"; // alias that tracks the current Flash model
const CACHE_DIR = path.join(process.cwd(), ".cache", "llm");
const BACKOFF_MS = [1000, 2000, 4000, 8000];

export type LLMUsage = { promptTokens: number; outputTokens: number; totalTokens: number };
export type TransportRequest = { model: string; system: string; prompt: string; jsonSchema: unknown; temperature: number };
export type TransportResponse = { text: string; usage?: LLMUsage };
/** Anything that can answer a request; swapped out in tests. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export type LLMMeta = { name: string; model: string; ms: number; attempts: number; cached: boolean; usage: LLMUsage };
export type LLMResult<T> = { data: T; meta: LLMMeta };

export class LLMError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "invalid_output" | "rate_limited", readonly status?: number) {
    super(message);
  }
}

export const llmModel = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

/** AI features are on only when asked for AND a key exists, so a missing key degrades gracefully. */
export function isAIEnabled(): boolean {
  return process.env.USE_AI === "true" && !!process.env.GEMINI_API_KEY;
}

// ---------------------------------------------------------------------------
// Transport (Gemini by default)
// ---------------------------------------------------------------------------

let transport: Transport | null = null;

export function setLLMTransport(t: Transport | null) {
  transport = t;
}

async function geminiTransport(req: TransportRequest): Promise<TransportResponse> {
  if (typeof window !== "undefined") throw new Error("callLLM is server-only");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new LLMError("GEMINI_API_KEY is not set", "unavailable");
  // Imported lazily so builds and heuristic-only runs never load the SDK.
  const { GoogleGenAI, ThinkingLevel } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });
  // Optional: less "thinking" = faster, cheaper calls. Gemini 3 models only, so opt-in.
  const level = process.env.GEMINI_THINKING_LEVEL?.toUpperCase() as keyof typeof ThinkingLevel | undefined;
  const res = await ai.models.generateContent({
    model: req.model,
    contents: req.prompt,
    config: {
      systemInstruction: req.system,
      responseMimeType: "application/json",
      responseJsonSchema: req.jsonSchema,
      temperature: req.temperature,
      ...(level && ThinkingLevel[level] ? { thinkingConfig: { thinkingLevel: ThinkingLevel[level] } } : {}),
    },
  });
  const u = res.usageMetadata;
  return {
    text: res.text ?? "",
    usage: {
      promptTokens: u?.promptTokenCount ?? 0,
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      totalTokens: u?.totalTokenCount ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

/**
 * zod → JSON Schema, minus keywords Gemini's response schema doesn't accept.
 * Dropped constraints (regex patterns etc.) are still enforced by zod afterwards.
 */
export function toGeminiSchema(schema: z.ZodType): unknown {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "propertyNames" || k === "pattern") continue;
      if (k === "const") { out.enum = [v]; continue; }
      out[k] = clean(v);
    }
    return out;
  };
  return clean(z.toJSONSchema(schema, { io: "input" }));
}

// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e: unknown) => (typeof e === "object" && e && "status" in e ? Number((e as { status: unknown }).status) : undefined);

function parseJson(text: string): unknown {
  // JSON mode should return bare JSON, but tolerate a ```json fence.
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(trimmed);
}

function cacheKey(model: string, system: string, prompt: string, jsonSchema: unknown) {
  return createHash("sha256").update(JSON.stringify([model, system, prompt, jsonSchema])).digest("hex").slice(0, 32);
}

/** One transport call with backoff on rate limits and transient server errors. */
async function send(req: TransportRequest): Promise<TransportResponse> {
  const t = transport ?? geminiTransport;
  for (let i = 0; ; i++) {
    try {
      return await t(req);
    } catch (e) {
      const status = statusOf(e);
      const message = String((e as Error).message ?? "");
      // A per-day quota won't reset in seconds: fail fast so callers fall back immediately.
      if (status === 429 && /PerDay/i.test(message)) {
        const model = /model: ([\w.\-]+)/.exec(message)?.[1] ?? req.model;
        const limit = /limit: (\d+)/.exec(message)?.[1];
        throw new LLMError(`Gemini daily free-tier quota exhausted for ${model}${limit ? ` (${limit} requests/day)` : ""}`, "rate_limited", 429);
      }
      const retryable = status === 429 || (status !== undefined && status >= 500);
      if (!retryable || i >= BACKOFF_MS.length) {
        if (status === 429) throw new LLMError("Gemini rate limit: retries exhausted", "rate_limited", 429);
        if (e instanceof LLMError) throw e;
        throw new LLMError(`Gemini call failed${status ? ` (HTTP ${status})` : ""}: ${(e as Error).message?.slice(0, 200)}`, "unavailable", status);
      }
      // Respect the server's suggested delay when it gives one ("Please retry in 8.3s").
      const suggested = Number(/retry in ([\d.]+)s/i.exec(message)?.[1] ?? 0) * 1000;
      await sleep(Math.min(30_000, Math.max(BACKOFF_MS[i], suggested)));
    }
  }
}

export async function callLLM<T>(args: {
  /** Short label for logs and the cache file, e.g. "extractConstraints". */
  name: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  temperature?: number;
}): Promise<LLMResult<T>> {
  const model = llmModel();
  const jsonSchema = toGeminiSchema(args.schema);
  const temperature = args.temperature ?? 0.2;
  const started = Date.now();
  const useCache = process.env.LLM_CACHE === "true";
  const key = cacheKey(model, args.system, args.prompt, jsonSchema);
  const cacheFile = path.join(CACHE_DIR, `${args.name}-${key}.json`);

  if (useCache) {
    try {
      const hit = JSON.parse(readFileSync(cacheFile, "utf8"));
      const parsed = args.schema.safeParse(hit);
      if (parsed.success) {
        const meta: LLMMeta = { name: args.name, model, ms: Date.now() - started, attempts: 0, cached: true, usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 } };
        log(meta);
        return { data: parsed.data, meta };
      }
    } catch {
      // no cache entry
    }
  }

  const usage: LLMUsage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  let prompt = args.prompt;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await send({ model, system: args.system, prompt, jsonSchema, temperature });
    usage.promptTokens += res.usage?.promptTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;
    usage.totalTokens += res.usage?.totalTokens ?? 0;

    let raw: unknown;
    try {
      raw = parseJson(res.text);
    } catch (e) {
      lastError = `not valid JSON: ${(e as Error).message}`;
    }
    if (raw !== undefined) {
      const parsed = args.schema.safeParse(raw);
      if (parsed.success) {
        const meta: LLMMeta = { name: args.name, model, ms: Date.now() - started, attempts: attempt, cached: false, usage };
        log(meta);
        if (useCache) {
          mkdirSync(CACHE_DIR, { recursive: true });
          writeFileSync(cacheFile, JSON.stringify(parsed.data, null, 2));
        }
        return { data: parsed.data, meta };
      }
      lastError = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    }
    // Retry once, telling the model exactly what was wrong.
    prompt = `${args.prompt}\n\nYOUR PREVIOUS REPLY WAS INVALID: ${lastError}\nReturn only JSON that matches the schema exactly.`;
  }
  log({ name: args.name, model, ms: Date.now() - started, attempts: 2, cached: false, usage }, "invalid output");
  throw new LLMError(`${args.name}: invalid output after retry (${lastError.slice(0, 300)})`, "invalid_output");
}

function log(m: LLMMeta, note = "") {
  if (process.env.LLM_LOG === "false") return;
  console.info(
    `[llm] ${m.name} model=${m.model} ${m.cached ? "cache-hit" : `attempts=${m.attempts}`} ${m.ms}ms ` +
    `tokens in=${m.usage.promptTokens} out=${m.usage.outputTokens}${note ? ` (${note})` : ""}`,
  );
}
