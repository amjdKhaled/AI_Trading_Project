import { logger } from "../logger.js";
import { OLLAMA_BASE_URL } from "./ollama.js";

export const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? "qwen2.5-vl:7b";
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "60000", 10);

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body: Record<string, unknown> = {
      model: VISION_MODEL,
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
      throw new Error(`Ollama vision HTTP ${res.status}: ${text}`);
    }

    const data = (await res.json()) as OllamaVisionResponse;
    return data.response.trim();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Ollama vision timeout after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function isVisionAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    return models.some(m => m.name.startsWith("qwen2.5-vl") || m.name === VISION_MODEL);
  } catch {
    return false;
  }
}

logger.debug({ model: VISION_MODEL, endpoint: OLLAMA_BASE_URL }, "Vision model client loaded");
