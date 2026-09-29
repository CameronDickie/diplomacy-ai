# Public showcase review

Implementation is tracked in [Linear](https://linear.app/dickielabs/project/diplomacy-public-showcase-mvp-65f956fd6c82).
See [the issue index and working convention](public-showcase-tracking.md).

Reviewed September 27, 2026. This is an assessment and proposed implementation
sequence, not a claim that public AI hosting is ready. No runtime behavior was
changed, no deployment was performed, and no paid provider calls were made.

## Recommendation

Keep one codebase and offer a small public game experience with server-owned
presets. Give visitors a useful rules-based opponent without login; offer a
fixed, budgeted hosted LLM preset when funding is available. Keep provider/model
configuration, Discord, voice, and diagnostics behind an actual admin capability.
Support Ollama separately for people who clone and self-host the project.

The visitor's goal is to choose a country and play, not configure six agents.
Default to one human plus six opponents. Offer a clearly labelled short challenge
as well as standard play when durable recovery and game pacing are ready. A
challenge's turn limit and scoring are product decisions, not standard Diplomacy
rules. Include a prepared public replay so the project can always be explored.

Do not simply set `DIPLOMACY_AUTH_ENABLED=false` on a server containing paid API
keys: disabled auth currently means everyone is considered authenticated.

## What to preserve

- Godip movement adjudication and generated board adjacency provide a much
  better foundation than asking models or handwritten logic to resolve combat.
- AI selects authoritative legal order IDs, and the server validates its choices.
- Private press is delivered to the participating powers; public history is a
  separate representation. Preserve that distinction in persistence and exports.
- Random seat tokens, server ownership checks, event payload validators, phase
  IDs, and idempotent submission receipts are useful existing boundaries.
- `PowerController` and `LlmProvider` give local providers and non-LLM opponents
  natural extension points. A framework replacement is unnecessary.

## Verified barriers and design concerns

| Priority | Finding | Why it matters / proposed action |
| --- | --- | --- |
| Launch blocker | All automated seats require auth, including STUB. `add_llm_player` unconditionally checks auth; `addLlmPlayer` locks room access; `requiresAuthenticatedAccess` treats every LLM seat as private. | Guests can create/join human games, but cannot independently start a solo game. Make room access a deliberate policy, separate from controller type. |
| Launch blocker | Disabling authentication returns `authenticated: true`; Socket.IO caches that boolean at connection time. | Auth-disabled is not a guest capability, and cookie expiration/logout does not revoke an already connected custom client. Separate admin identity from public access, enforce expiry/revocation on privileged commands, and retain seat identity separately. |
| Launch blocker | Usage is recorded only after successful validation. Retry attempts, parsing errors, and controller rejection can discard billable usage. | Move accounting into the provider attempt boundary, before parsing/domain validation. Preserve provider usage even when the decision is invalid. |
| Launch blocker | The per-game cap is checked before a run, with no reservation; six order calls can run concurrently. No site-wide budget exists. | Reserve a conservative maximum before every attempt and reconcile actual usage. Enforce durable site/day, guest/game, call, token, and concurrency budgets. A per-game cap alone permits unlimited new games. |
| Launch blocker | Allowlisted models without a price return `null`; unknown usage/prices add nothing to spend. | Public paid requests must fail closed or retain a conservative reservation when accounting is unknown. Adding Luna only to the allowlist would currently bypass cost accounting. |
| Launch blocker | `render-production-env.cjs` drops `LLM_*` and `GEMINI_API_KEY`; it requires OpenAI and Discord credentials even though runtime integration is optional. | Share configuration definitions and test rendering end to end. Otherwise deployment silently restores the default $5/game cap and loses provider restrictions. |
| Launch blocker | Rooms, tokens, submissions, histories, and spend are in memory. The `/data` volume has no persistence implementation. | Add SQLite checkpoints and transactional phase transitions with restart reconciliation. Persist attempt reservations too; a restart must not reset the public funding ledger. |
| Launch blocker | No command/login throttling, global room limit, room expiration, or bounded AI queue is implemented. | Guests can consume memory even without paid AI; chat can enqueue repeated work. Rate-limit HTTP and socket commands, bound queues, limit active games, expire abandoned rooms, and add a global stop switch. IP limits are supplementary because visitors can change identity/IP. |
| High | Final order generation does not drain human-initiated diplomacy or use its per-power queue; context holds the live `GameState`. | A reply and order decision can overwrite memory or use different phase assumptions. Close negotiation intake, drain/cancel accepted work, freeze the phase snapshot, and revision-check returned decisions. |
| High | Human action menus use separate client rules; friendly destinations are blocked and convoy discovery excludes allied fleets. | Use the existing authoritative legal catalog for humans too. Preserve ownership checks; legal action availability does not mean an action will succeed against opponents. |
| High | Browser chat IDs are not deduplicated; drafts clear immediately and errors can claim a message was stored even when validation rejected it. | Add durable message receipts and truthful pending/delivered/failed states before public paid chat. Duplicate deliveries must not purchase duplicate replies. |
| High | `execFileSync` runs Godip on the Node event loop, without an execution timeout. | One slow engine invocation can block every room and health check. Use asynchronous execution with concurrency, timeout, output, and cancellation limits. |
| Medium | `getState()` returns mutable state; a roughly 2,300-line room mixes sessions, rules, scheduling, integration, telemetry, and history. | Introduce immutable snapshots and explicit commands. Extract budget/attempt accounting and phase orchestration incrementally after regressions are covered. Avoid a simultaneous full rewrite. |
| Medium | Histories, artifacts, receipts, completed-phase markers, and legal-order caches grow without retention limits. | Keep a bounded hot working set and durable paginated archives; expire deduplication data according to an explicit retry window. |
| Medium | Room host is used as the operational privilege boundary. | An anonymous creator becomes a host. Room ownership must never grant paid-model configuration, Discord administration, or site diagnostics. |

Primary code: `server/src/GameRoom.ts`, `server/src/index.ts`, `server/src/auth.ts`,
`server/src/handlers/{gameHandler,authz,clientEvent}.ts`,
`server/src/diplomacy/DiplomacyService.ts`, `server/src/llm/policy.ts`,
`server/src/adjudication/GodipAdjudicator.ts`,
`scripts/render-production-env.cjs`, `client/src/lib/game.ts`.

The existing code-review backlog already identifies many lifecycle problems.
These findings were checked against the implementation rather than assuming
that the checklist represents completed repairs.

## Access and deployment policy

Avoid two frontend modes that merely hide controls. Resolve a server-owned
capability set for every command and select a server-owned room policy at creation.

| Capability | Public guest | Signed-in admin | Self-hosted local profile |
| --- | --- | --- | --- |
| Create/play/resume a game | Yes, bounded | Yes | Yes |
| Use a rules-based opponent | Yes | Yes | Yes |
| Use sponsored LLM preset | If site budget admits it | Yes, with budgets | Optional |
| Set providers/models/personas/negotiation limits | No | Within server allowlists | Host controlled |
| Configure Discord/voice | No | Optional, separate limits | Optional |
| Access operational AI artifacts | No | Explicit authorization | Host controlled |

Authentication controls who can configure services. A public preset explicitly
authorizes a restricted server-side service without giving the guest credentials
or general provider access. Thus public AI play and admin-only API configuration
are compatible. Keys never belong in browser code.

Suggested room policies: `PUBLIC_BOT`, `PUBLIC_LLM`, `PRIVATE`. Derive controllers
from presets, not arbitrary visitor model strings. Advertise capabilities through
a public endpoint so the browser need not maintain a second model catalog. Keep
anonymous seat identity/reconnect tokens independent from admin cookies.

Use explicit deployment profiles (`showcase`, `private`, `local`) with validated
configuration. The showcase profile should neither initialize Discord nor attach
its handlers. Retaining its source in an optional module is enough; deleting it
is not necessary to deliver a browser demo.

## Local AI: three different approaches

1. **Ollama on the clone owner's machine.** The Node server calls a host-configured
   local endpoint through an `OllamaProvider`. Local Ollama supports JSON schema
   output, which fits the existing controller interface. `OLLAMA` is currently
   only a type/policy placeholder: no adapter is implemented. Keep its endpoint
   in trusted configuration, never a guest-supplied URL. This is the best initial
   local LLM path, but does require running the application and model locally.
2. **A model on your hosting machine.** Visitors still only use their browsers;
   they do not run a server. You pay for compute and handle throughput. Benchmark
   the actual model, prompt, hardware, and six-seat latency before choosing this
   over an inexpensive API. Open weights do not make inference free.
3. **A model inside the visitor's browser.** WebLLM provides WebGPU inference and
   structured JSON generation. This could support an optional solo experiment,
   but requires model downloads, adequate hardware, and compatible browsers.
   Every AI power's private context on that device becomes inspectable by the
   human. It therefore cannot preserve the existing secrecy assumptions for
   competitive multiplayer. Truly serverless play also requires porting/replacing
   the current Go process bridge and server orchestration; an inference adapter
   alone does not achieve it.

A rules-based bot is a fourth option, with no LLM at all. Replace auto-hold with
legal center-seeking moves, defensive/support coordination, retreats, and builds.
The current `MoveSuggestionEngine` offers a starting point, not a complete bot:
most candidates change just one move or one supported pair while other units
hold, and destination scoring does not simulate opposing orders. Improve whole
power plans before treating it as a tactical opponent. Label its limitations
honestly; keep strategic natural-language diplomacy for the LLM preset.

Sources: [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs),
[WebLLM setup](https://webllm.mlc.ai/docs/user/get_started.html),
[WebLLM project](https://github.com/mlc-ai/web-llm).

## Cost and harness changes

GPT-6 Luna is documented at **$0.10 per million input tokens and $0.50 per
million output tokens** for standard short-context text, with cached input at
$0.01/million. It is absent from this repository's default model allowlist and
price table. The Responses API path already exists, but this game harness has
not been verified against Luna. Explicitly set/evaluate reasoning effort and
output limits; the model default is medium reasoning. Do not assume its default
will fit the current 2,048-output-token budget.

Illustrative arithmetic, not observed game costs, assuming uncached input:

| Input / output per call | Cost per call | 360 calls |
| --- | --- | --- |
| 10,000 / 1,000 tokens | $0.0015 | $0.54 |
| 30,000 / 2,000 tokens | $0.0040 | $1.44 |

360 calls represents twenty movement phases with six AI orders and up to twelve
initiative/reply calls per phase under the current two-initiator/six-message
settings. This excludes builds, retreats, human chat, retries, voice, and hosting.
There is presently no total human-chat call bound. Low legitimate traffic can
be inexpensive, but the global admission policy must bound hostile traffic too.

Recommended changes, in order:

- **Measure attempts correctly.** Record role, input/cached/output/reasoning
  usage where supplied, latency, outcome, and cost per attempt. Publish no private
  prompts. Reconcile uncertain timed-out requests conservatively rather than
  assuming cancellation means they were free.
- **Bound context.** Keep the complete transcript in storage; send a short
  strategic summary, active agreements, recent messages, and the relevant board
  state. Summaries currently coexist with the entire history, so they do not
  reduce prompt growth. Put hard byte/token bounds on model-maintained memory.
- **Specialize tasks.** Diplomacy does not need every legal move; retreats need
  only legal retreat choices; builds can often be deterministic. Avoid copying
  the entire province adjacency table into every task. Retain enough topology
  for strategic planning and evaluate any pruning for loss of play quality.
- **Use a stable prompt prefix.** Static rules/topology can precede changing
  power/state/messages. Structured-output schemas vary with the legal catalog,
  which can reduce cross-call cache reuse; measure cached tokens rather than
  projecting guaranteed savings. Shorter prompts still help uncached calls.
- **Fix role routing.** Store a seat's optional model override separately from
  its resolved order model. Currently a normal seat gets a concrete order model,
  which is passed as an explicit override for replies, retreats, builds, and
  memory; most cheaper role defaults are consequently bypassed.
- **Reduce background work selectively.** Start a public preset with bounded
  human/AI conversation and fewer AI/AI exchanges. Preserve enough autonomous
  negotiation if the purpose is to showcase Diplomacy rather than just combat.
  Do not combine all six powers' private transcripts into one shared model call.
- **Provide useful degradation.** When funding/provider access is unavailable,
  offer an explicitly labelled bot game or a replay. If an active game changes
  opponent type, tell the player; silently switching to holds ruins the demo.
- **Evaluate quality, not just format.** Use opening expansion, support defense,
  convoy, coast, retreat, and agreement-consistency scenarios. Track win/center
  performance, fallback rate, latency, and total game cost across repeated runs.
  A tiny model returning legal JSON is not proof of a good opponent.

Sources: [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Practical delivery sequence

1. Define presets/capabilities and repair deployment configuration. Disable
   Discord/voice in the showcase profile. Keep admin auth enabled.
2. Deliver a playable guest bot preset, straightforward solo setup, and replay.
   Fix human legal-order menus and truthful chat/submission feedback alongside it.
3. Add persistence, phase snapshots/cutoff, restart recovery, room expiration,
   command throttles, async engine limits, and useful end/abandon flows.
4. Implement provider-bound attempt accounting, budget reservations, durable
   global funding limits, queue limits, and an admin stop switch. Test with mocks.
5. Evaluate a fixed Luna preset and reduced prompts. Only then enable anonymous
   sponsored play, with visible exhaustion/degradation behavior.
6. Add Ollama for clone owners. Treat browser inference and voice as separate
   experiments, not prerequisites for a public launch.

For open sourcing, choose and include a repository license, retain the Godip
notices/license and map attribution, document the local and showcase profiles,
and make setup reproducible. DIC-79 adds a top-level GPL-3.0 license, a
browser-visible credits page, and corresponding source in the production image;
the GitHub repository still needs to be public before the showcase launches.
The process boundary is an architectural choice, not a licensing conclusion.

## Verification and limits of this review

- Read implementation across authentication, socket handlers, room lifecycle,
  providers, prompts, move suggestions, Godip bridge, client setup/chat/orders,
  Discord linking/voice, and deployment. This is not an exhaustive security audit
  or a visual review of every UI component.
- Ran the actual policy helpers under Node: a concrete seat mini model overrides
  the configured nano retreat default; an allowlisted Luna model produces an
  unknown cost; the default cap is $5/game.
- Ran the actual production environment renderer with synthetic credentials:
  Gemini key, spend cap, and provider allowlist were all omitted.
- Measured the existing prompt builder and board context in temporary stripped
  TypeScript copies: an opening diplomacy prompt with no chat, player entries,
  legal orders, or normal unit UUIDs is 21,600 characters; the static rules
  reference is 13,260 characters (about 61%). These are character measurements,
  not tokenizer measurements or provider billing data.
- Full build/server/Go suites were not rerun: this checkout has no installed
  `node_modules`, built server/engine, or Go available on PATH. Existing recorded
  69-server/10-Go passes are prior evidence, not new verification.
- No live model-quality, browser hardware, hosting performance, or cost benchmark
  was run. Dollar examples are explicitly hypothetical.
