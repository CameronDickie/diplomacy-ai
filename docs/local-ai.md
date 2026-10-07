# Local AI with Ollama

Clone owners can run opponents on their own hardware through
[Ollama](https://ollama.com). No cloud key, no paid switch and no funding ledger
are involved: the server sends each decision to an Ollama server you run.

This applies to **hosted rooms** (the lobby's AI seats) in the `local` and
`private` profiles. It does not apply to the public daily challenge: the
`showcase` profile refuses Ollama, and sponsored attempts use only the fixed
`gpt-6-luna` contract in [luna-preset.md](luna-preset.md).

## Set up

1. Install Ollama **0.5 or newer** (structured JSON output is required) and start
   it: `ollama serve`.
2. Pull a model: `ollama pull <model>`.
3. Configure the game server:

   ```
   LLM_ALLOWED_PROVIDERS=STUB,OLLAMA
   LLM_ALLOWED_MODELS_OLLAMA=<model>[,<another>]
   # Optional. Defaults shown.
   OLLAMA_BASE_URL=http://127.0.0.1:11434
   LLM_DEFAULT_OLLAMA_MODEL=<first allowed model>
   LLM_REQUEST_TIMEOUT_MS=30000
   ```

   `DIPLOMACY_PAID_AI_ENABLED` stays `false`. Cloud providers remain disabled
   unless you separately enable them.
4. Check it before starting a game:

   ```
   npm run build
   npm run ollama:smoke -- <model>
   ```

   The command reads the same environment variables as the server, sends one
   small structured request and prints the answer, latency and token counts. It
   exits non-zero with the reason if anything is wrong.
5. In the lobby, an operator adds an AI seat with provider **Ollama (local)**.
   Leave the model empty for the configured default, or name another model from
   the allowlist.

## What the server guarantees

- **The endpoint is server configuration only.** `OLLAMA_BASE_URL` must be a
  plain HTTP(S) origin with no path or credentials. No player, request or lobby
  setting can change where requests go, and redirects are not followed.
- **Only allowlisted models run.** A model not on `LLM_ALLOWED_MODELS_OLLAMA` is
  refused before any request.
- **Only operators configure AI providers**, as for every non-stub provider.
- **Unsupported models fail clearly.** Before first use of a model the server
  asks Ollama about it. A model that is not installed, or cannot generate text,
  produces an error naming the fix (`ollama pull <model>`); the check is retried
  on the next decision, so installing the model fixes play without a restart.
- **A bad answer is never treated as a decision.** Prose instead of JSON, an
  answer cut off by the output limit, an empty answer, a server error or a
  timeout all fail the call. The room then applies its usual retry and fallback
  (`LLM_MAX_RETRIES`, then holds), and records why.
- **Every order is still validated** against the legal-order catalog; local
  models get the same private per-power context and bounded prompts as cloud
  ones.
- Usage is recorded in tokens; estimated cost is zero.

## Choosing a model: hardware and latency

There is no built-in model list because the right choice depends on your
machine. What matters:

- **It must follow a JSON schema.** Small or older models often answer in prose
  or invent order IDs. `npm run ollama:smoke` catches the first; invalid orders
  show up in play as retries and fallback holds.
- **Memory.** A model needs roughly its download size in RAM or VRAM, plus the
  context window. If it does not fit on the GPU, Ollama runs it partly on the
  CPU and it becomes several times slower.
- **Context window.** Order prompts for a full board can reach several thousand
  tokens (bounded by `LLM_MAX_INPUT_TOKENS`). Ollama's default context is small
  and it **silently truncates** longer prompts, which looks like a model ignoring
  the board. Raise it on the Ollama side (`OLLAMA_CONTEXT_LENGTH`, or a
  Modelfile `PARAMETER num_ctx`) to cover the prompt plus
  `LLM_MAX_OUTPUT_TOKENS`. A larger context uses more memory.
- **Latency adds up.** Every AI power makes at least one request per phase, more
  with negotiation enabled, and each must finish inside
  `LLM_REQUEST_TIMEOUT_MS` (maximum 120000). The first request after a model
  loads is much slower than the rest. Ollama answers one request at a time per
  model unless `OLLAMA_NUM_PARALLEL` is raised, which multiplies context memory.
  A model that answers the smoke test in a few seconds is comfortable; tens of
  seconds per request makes a seven-power game slow and prone to timeouts.

As a rule of thumb: prefer the largest instruction-following model that fits
entirely on your GPU and passes the smoke test in a few seconds, and raise the
request timeout rather than the retry count if answers are good but slow.

## Running Ollama on another machine

Set `OLLAMA_BASE_URL` to that machine's origin, for example
`http://gpu-box.lan:11434`. Ollama has no authentication: keep it on a private
network and never expose the port publicly. The game server is the only client
that needs to reach it.

## Verification

`server/src/test/OllamaProvider.test.ts` runs the adapter against a stand-in
HTTP server: request shape, single capability check, missing and unsupported
models, unreachable and non-Ollama endpoints, malformed, truncated and empty
answers, timeout cancellation, refused redirects, and the configuration rules
above. These are contract tests against Ollama's documented API; they do not
measure any real model's quality or speed. Use `npm run ollama:smoke` on your
own hardware for that.
