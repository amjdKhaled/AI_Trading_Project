import { logger } from "../logger.js";
import { OLLAMA_BASE_URL } from "./ollama.js";

// Preferred default — overridable by env var
export const VISION_MODEL_DEFAULT = process.env.OLLAMA_VISION_MODEL ?? "qwen2.5-vl:7b";
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "60000", 10);

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

export async function ollamaVisionGenerate(
  prompt: string,
  imageBase64: string,
  system?: string,
  numPredict = 512,
): Promise<string> {
  // Always use the *actual* model name Ollama reports, not the hardcoded default
  const model = (await resolveVisionModel()) ?? VISION_MODEL_DEFAULT;

  logger.info(
    { model, imageBytes: Math.round(imageBase64.length * 0.75), numPredict },
    "Vision model called — sending image",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body: Record<string, unknown> = {
      model,
      prompt,
      images: [imageBase64],
      stream: false,
      options: {
        temperature: 0.1,
        top_p: 0.9,
        num_predict: numPredict,
      },
    };
    if (system) body.system = system;

    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama vision HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as OllamaVisionResponse;
    const responseText = data.response.trim();

    logger.info(
      { model, responseChars: responseText.length },
      "Vision model response received",
    );

    return responseText;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Ollama vision timeout after ${TIMEOUT_MS}ms — model may still be loading`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Log detected model at module load (startup) ───────────────
// Fires async — doesn't block server startup
resolveVisionModel().then(model => {
  if (model) {
    logger.info({ model, endpoint: OLLAMA_BASE_URL }, "Vision model ready at startup");
  }
}).catch(() => { /* ignore — already logged inside resolveVisionModel */ });
