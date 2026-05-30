---
name: ollamaGenerate argument order
description: Correct call signature for ollamaGenerate — easy to get wrong since prompt is first, system is second.
---

`ollamaGenerate(prompt, system?, numPredict?)` — prompt is the FIRST argument, system prompt is SECOND (optional).

The third arg is `numPredict` (number), not an options object. There is no per-call `timeout` option; timeout is controlled globally via `OLLAMA_TIMEOUT_MS` env var.

**Why:** Was written with prompt-first convention but it's easy to accidentally swap with system-first (as in some OpenAI SDKs). Writing `ollamaGenerate(SYSTEM, prompt, { timeout })` compiles but silently passes the system string as the user prompt and ignores the system entirely.

**How to apply:** Any new call site: `ollamaGenerate(buildPrompt(...), SYSTEM_CONSTANT)`. Never pass an object as the third arg.
