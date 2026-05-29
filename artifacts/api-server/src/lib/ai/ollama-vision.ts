import { logger } from "../logger.js";
import { OLLAMA_BASE_URL } from "./ollama.js";

// Preferred default — overridable by env var
export const VISION_MODEL_DEFAULT = process.env.OLLAMA_VISION_MODEL ?? "qwen2.5-vl:7b";
// Default 0 = NO timeout. Ollama loads the model into VRAM on the first request
// and may take several minutes. Set OLLAMA_TIMEOUT_MS to a positive number to
// impose a hard limit (e.g. OLLAMA_TIMEOUT_MS=300000 for 5 min).
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "0", 10);

// Retry configuration — transient failures (network drop, Ollama restart, OOM)
// are retried up to MAX_RETRIES times with linear backoff.
// 4xx errors (model not found, bad request) are never retried.
const MAX_RETRIES  = 3;
const RETRY_BASE_MS = 8_000; // delay between attempts: 8 s → 16 s

// ── Flexible model detection ──────────────────────────────────
// Accepts any of the known naming variants Ollama may report:
//   qwen2.5-vl:7b  qwen2.5vl:7b  qwen2.5-vl  qwen2.5vl  (+ :latest, :instruct-*, etc.)
function matchesVisionModel(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("qwen2.5-vl") || n.startsWith("qwen2.5vl");
}

// Resolved model name cache — set once on first successful lookup
let _resolvedModel: string | null = null;

/** Query /api/tags, find the first installed vision model, cache the result. */
export async function resolveVisionModel(): Promise<string | null> {
  if (_resolvedModel) return _resolvedModel;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const found = (data.models ?? []).find(m => matchesVisionModel(m.name));
    if (found) {
      _resolvedModel = found.name;
      logger.info({ model: _resolvedModel, endpoint: OLLAMA_BASE_URL }, "Vision model detected");
      return _resolvedModel;
    }
    // Log what IS available to help debug name mismatches
    const names = (data.models ?? []).map(m => m.name).join(", ") || "(none)";
    logger.warn(
      { available: names, wanted: "qwen2.5-vl* or qwen2.5vl*" },
      "Vision model not found — no qwen2.5-vl/qwen2.5vl variant in Ollama",
    );
    return null;
  } catch (err) {
    logger.warn({ err }, "Vision model probe failed (Ollama unreachable?)");
    return null;
  }
}

/** Returns the resolved model name, or falls back to the default constant. */
export async function getVisionModel(): Promise<string> {
  return (await resolveVisionModel()) ?? VISION_MODEL_DEFAULT;
}

/** Clears the detection cache — call this to force a re-probe (e.g. after a pull). */
export function clearVisionModelCache(): void {
  _resolvedModel = null;
}

// ── Availability check ────────────────────────────────────────

export async function isVisionAvailable(): Promise<boolean> {
  return (await resolveVisionModel()) !== null;
}

// ── Keep VISION_MODEL export for backward compat with existing imports ──
// It reflects the env-var preference but the *actual* model used for
// API calls is always the resolved name from resolveVisionModel().
export const VISION_MODEL = VISION_MODEL_DEFAULT;

// ── Vision generation ─────────────────────────────────────────

export interface OllamaVisionResponse {
  model: string;
  response: string;
  done: boolean;
}

// ── Inner single-attempt generator (no retry logic) ──────────────
async function doVisionGenerate(
  model: string,
  prompt: string,
  imageBase64: string,
  system?: string,
  numPredict = 512,
): Promise<string> {
  const controller = new AbortController();
  const timer = TIMEOUT_MS > 0 ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  const t0 = Date.now();

  try {
    const body: Record<string, unknown> = {
      model,
      prompt,
      images: [imageBase64],
      stream: false,
      options: { temperature: 0.1, top_p: 0.9, num_predict: numPredict },
    };
    if (system) body.system = system;

    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: TIMEOUT_MS > 0 ? controller.signal : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama vision HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as OllamaVisionResponse;
    const responseText = data.response.trim();
    const elapsedMs = Date.now() - t0;
    logger.info(
      { model, responseChars: responseText.length, elapsedMs, elapsedSec: Math.round(elapsedMs / 100) / 10 },
      "Vision model response received",
    );
    return responseText;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    if ((err as Error).name === "AbortError") {
      throw new Error(`Ollama vision timeout after ${elapsedMs}ms (OLLAMA_TIMEOUT_MS=${TIMEOUT_MS}ms) — set OLLAMA_TIMEOUT_MS=0 to disable`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Public entry point — retries up to MAX_RETRIES times ──────────
export async function ollamaVisionGenerate(
  prompt: string,
  imageBase64: string,
  system?: string,
  numPredict = 512,
): Promise<string> {
  // Always use the *actual* model name Ollama reports, not the hardcoded default
  const model = (await resolveVisionModel()) ?? VISION_MODEL_DEFAULT;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    logger.info(
      {
        model, attempt, maxRetries: MAX_RETRIES,
        imageBytes: Math.round(imageBase64.length * 0.75),
        numPredict, timeoutMs: TIMEOUT_MS,
      },
      `Vision model called — attempt ${attempt}/${MAX_RETRIES}`,
    );
    try {
      return await doVisionGenerate(model, prompt, imageBase64, system, numPredict);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? String(err);
      // Never retry on 4xx (model not found, bad request)
      const is4xx = /HTTP 4\d\d/.test(msg);
      if (attempt === MAX_RETRIES || is4xx) {
        logger.error({ attempt, maxRetries: MAX_RETRIES, model, err: msg }, "Vision model failed — all retries exhausted");
        throw err;
      }
      const delayMs = attempt * RETRY_BASE_MS;
      logger.warn({ attempt, maxRetries: MAX_RETRIES, delayMs, err: msg }, "Vision attempt failed — retrying after delay");
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr; // unreachable — loop always throws or returns
}

// ── Log detected model at module load (startup) ───────────────
// Fires async — doesn't block server startup
resolveVisionModel().then(model => {
  if (model) {
    logger.info({ model, endpoint: OLLAMA_BASE_URL }, "Vision model ready at startup");
  }
}).catch(() => { /* ignore — already logged inside resolveVisionModel */ });
