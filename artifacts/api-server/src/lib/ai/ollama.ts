import { logger } from "../logger.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

// ── Model configuration ───────────────────────────────────────────────────────
// Primary model : OLLAMA_MODEL env var          → default qwen3:14b
// Fallback model: OLLAMA_MODEL_FALLBACK env var → default qwen2.5:14b
//
// Runtime override via POST /api/ai/config persists for the server lifetime
// but resets on restart.  Env vars set the initial values.

const ENV_PRIMARY  = process.env.OLLAMA_MODEL          ?? "qwen3:14b";
const ENV_FALLBACK = process.env.OLLAMA_MODEL_FALLBACK ?? "qwen2.5:14b";

let _primary  = ENV_PRIMARY;
let _fallback = ENV_FALLBACK;

export function getActiveModel():   string { return _primary;  }
export function getFallbackModel(): string { return _fallback; }
export function setActiveModel(m: string):   void { _primary  = m; }
export function setFallbackModel(m: string): void { _fallback = m; }

// Legacy constant exports — callers that import MODEL at module load get the
// initial env value.  Prefer getActiveModel() for runtime-accurate values.
export const MODEL          = ENV_PRIMARY;
export const FALLBACK_MODEL = ENV_FALLBACK;
export { OLLAMA_BASE_URL };

// ── Thinking-token suppression ────────────────────────────────────────────────
// qwen3 emits <think>…</think> blocks when think mode is on (the default).
// We set think=false at the API level AND strip thinking blocks inside the
// JSON parser as defence-in-depth for older Ollama builds that ignore the flag.

// No hard timeout — large models can take minutes on first VRAM load.
// Set OLLAMA_TIMEOUT_MS to a positive integer to impose a cap.
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "0", 10);

export interface OllamaResponse {
  model:    string;
  response: string;
  done:     boolean;
}

// ── Low-level generate ────────────────────────────────────────────────────────

async function generate(
  model:      string,
  prompt:     string,
  system?:    string,
  numPredict = 512,
): Promise<string> {
  const controller = new AbortController();
  const timer = TIMEOUT_MS > 0 ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  const t0 = Date.now();

  try {
    const body: Record<string, unknown> = {
      model,
      prompt,
      stream: false,
      think:  false,   // disable qwen3 thinking mode — keeps output as pure JSON
      options: {
        temperature: 0.1,
        top_p:       0.9,
        num_predict: numPredict,
      },
    };
    if (system) body.system = system;

    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  TIMEOUT_MS > 0 ? controller.signal : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${text}`);
    }

    const data = (await res.json()) as OllamaResponse;
    const elapsedMs = Date.now() - t0;
    logger.info(
      { model, elapsedMs, elapsedSec: Math.round(elapsedMs / 100) / 10, responseChars: data.response.length },
      "Ollama generate complete",
    );
    return data.response.trim();
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `Ollama timeout after ${elapsedMs}ms (OLLAMA_TIMEOUT_MS=${TIMEOUT_MS}ms) — set OLLAMA_TIMEOUT_MS=0 to disable`,
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Public generate functions ─────────────────────────────────────────────────

/** Generate with the currently active (primary) model. */
export async function ollamaGenerate(
  prompt:     string,
  system?:    string,
  numPredict = 512,
): Promise<string> {
  return generate(_primary, prompt, system, numPredict);
}

/**
 * Generate with the primary model; automatically retries with the fallback
 * model if the primary call fails (model not loaded, Ollama error, etc.).
 */
export async function ollamaGenerateWithFallback(
  prompt:     string,
  system?:    string,
  numPredict = 512,
): Promise<string> {
  try {
    return await generate(_primary, prompt, system, numPredict);
  } catch (primaryErr) {
    logger.warn(
      { primaryModel: _primary, fallback: _fallback, err: primaryErr },
      "Primary model failed — retrying with fallback",
    );
    return generate(_fallback, prompt, system, numPredict);
  }
}

// ── Availability checks ───────────────────────────────────────────────────────

async function listInstalledModels(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

function modelInstalled(installed: string[], target: string): boolean {
  const prefix = target.split(":")[0];
  return installed.some(m => m === target || m.startsWith(prefix + ":") || m === prefix);
}

/** True if the primary OR fallback model is installed in Ollama. */
export async function isOllamaAvailable(): Promise<boolean> {
  const installed = await listInstalledModels();
  return modelInstalled(installed, _primary) || modelInstalled(installed, _fallback);
}

/** Check whether a specific model name is installed. */
export async function isModelAvailable(model: string): Promise<boolean> {
  const installed = await listInstalledModels();
  return modelInstalled(installed, model);
}

/** All model names currently installed in Ollama. */
export async function getAvailableModels(): Promise<string[]> {
  return listInstalledModels();
}

/** Detailed per-model status — used by /ai/status and /ai/config. */
export async function getModelStatus(): Promise<{
  primaryModel:    string;
  fallbackModel:   string;
  primaryReady:    boolean;
  fallbackReady:   boolean;
  installedModels: string[];
}> {
  const installed = await listInstalledModels();
  return {
    primaryModel:    _primary,
    fallbackModel:   _fallback,
    primaryReady:    modelInstalled(installed, _primary),
    fallbackReady:   modelInstalled(installed, _fallback),
    installedModels: installed,
  };
}

// ── JSON response parser ──────────────────────────────────────────────────────

export function parseJsonFromResponse(text: string): unknown {
  // Strip qwen3 thinking blocks — defence-in-depth for older Ollama builds
  // where the think=false API flag is not honoured.
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : stripped;
  const jsonStart = raw.search(/[{[]/);
  if (jsonStart === -1) throw new Error("No JSON object found in response");
  const jsonStr = raw.slice(jsonStart);
  const jsonEnd = Math.max(jsonStr.lastIndexOf("}"), jsonStr.lastIndexOf("]"));
  return JSON.parse(jsonStr.slice(0, jsonEnd + 1));
}
