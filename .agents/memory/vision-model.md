---
name: Vision model client
description: ollama-vision.ts calls qwen2.5-vl:7b via /api/generate with images[] array; availability check differs from text model.
---

# Vision Model Client

## The rule
The vision model (qwen2.5-vl:7b) uses the **same** `/api/generate` endpoint as the text model but requires an `images` array field containing base64-encoded image strings. `isVisionAvailable()` checks `/api/tags` and looks for a model name that **starts with** "qwen2.5-vl" or exactly matches `VISION_MODEL`, because Ollama tag names include version suffixes.

**Why:** `isOllamaAvailable()` (text model) only checks if Ollama is reachable at all — not whether the vision model is pulled. Vision model must be pulled separately: `ollama pull qwen2.5-vl:7b`.

**How to apply:** Always call `isVisionAvailable()` before routing to the vision model. If it returns false, return HTTP 503 with the pull hint. Never share clients between models — the vision payload shape differs.

## Config

| Constant | Value | Env override |
|----------|-------|-------------|
| `VISION_MODEL` | `qwen2.5-vl:7b` | `OLLAMA_VISION_MODEL` |
| Timeout | 60 000 ms | `OLLAMA_TIMEOUT_MS` |

## Files

- `artifacts/api-server/src/lib/ai/ollama-vision.ts` — client
- `artifacts/api-server/src/lib/ai/analyze-chart.ts` — structured chart analysis using vision model
- `artifacts/api-server/src/routes/ai.ts` — POST /api/ai/analyze-chart endpoint
