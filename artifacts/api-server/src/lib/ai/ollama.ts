import { logger } from "../logger.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:14b";
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "45000", 10);

export interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
}

export async function ollamaGenerate(prompt: string, system?: string, numPredict = 512): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body: Record<string, unknown> = {
      model: MODEL,
      prompt,
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
      throw new Error(`Ollama HTTP ${res.status}: ${text}`);
    }

    const data = (await res.json()) as OllamaResponse;
    return data.response.trim();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Ollama timeout after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models ?? [];
    return models.some(m => m.name.startsWith(MODEL.split(":")[0]) || m.name === MODEL);
  } catch {
    return false;
  }
}

export function parseJsonFromResponse(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  const jsonStart = raw.search(/[{[]/);
  if (jsonStart === -1) throw new Error("No JSON object found in response");
  const jsonStr = raw.slice(jsonStart);
  const jsonEnd = Math.max(jsonStr.lastIndexOf("}"), jsonStr.lastIndexOf("]"));
  return JSON.parse(jsonStr.slice(0, jsonEnd + 1));
}

export { MODEL, OLLAMA_BASE_URL };
