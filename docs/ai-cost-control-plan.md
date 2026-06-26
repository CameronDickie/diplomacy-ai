# AI Cost Control Plan

## Goal

Reduce paid model spend while keeping authenticated AI games playable and
diagnosable. Paid providers remain authentication-gated by default.

## Current Baseline

- `OPENAI` and `GEMINI` are implemented provider adapters.
- Lobby defaults have used expensive free-form model strings.
- Run artifacts capture tokens, retries, latency, and fallback reason, but not
  estimated spend or model role.
- Non-stub AI rooms are already locked behind authenticated access.

## Implementation Plan

- Route model choice through server-owned roles instead of trusting each UI
  model string directly.
- Default OpenAI paid text decisions to cheaper models and keep `gpt-5.5`
  opt-in via an explicit allowlist.
- Add provider/model allowlists, per-game estimated spend caps, retry limits,
  output-token limits, and request timeouts from environment configuration.
- Record model role and estimated cost in private LLM run artifacts.
- Add `GEMINI` as a provider adapter behind the same structured JSON interface,
  but keep it authenticated until a separate public-provider budget exists.

## Running Log

- 2026-06-25: Initial plan created. First implementation cut will add routing,
  policy, telemetry, and cheaper OpenAI defaults before making Gemini a public
  option.
- 2026-06-25: Implemented role-based server model resolution, paid provider
  and model allowlists, per-game estimated spend cap, retry/timeout/output
  policy, artifact model-role/cost telemetry, Gemini adapter, and cheaper lobby
  defaults. `gpt-5.5` is rejected unless explicitly allowlisted by server env.
