# DIC-49 build baseline

Recorded September 27, 2026 on an Apple Silicon Mac running macOS 27.0.
The [GitHub Actions workflow](../.github/workflows/check.yml) uses the same
repository-root `npm ci` and `npm run check` commands.

## Toolchains

- Local Node.js: 26.9.0; npm: 12.0.2 (existing Homebrew installation).
- Local Go: 1.27.1, installed with `brew install go`.
- Documented minimums: Node.js 22.16 and Go 1.23. The CI matrix checks
  Node 22 / Go 1.23 on Linux and Node 26 / Go 1.27 on macOS. Those remote
  combinations still need a GitHub Actions run after the workflow is pushed.

## Results

- `npm ci --no-audit --no-fund`: 242 locked npm packages installed. npm 12
  reported that lifecycle scripts for `fsevents` and `esbuild` were blocked by
  its install-script policy. The build nevertheless completed successfully;
  no allowlist or lockfile change was necessary for this baseline.
- `npm run check`: Go executable built; shared and server TypeScript compiled;
  client TypeScript compiled and Vite produced a production bundle; 69 server
  tests passed with no failures; 10 Go test functions passed.
- A fresh temporary checkout from `git archive HEAD`, overlaid with the new
  README and workflow, also passed `npm ci --no-audit --no-fund` and
  `npm run check`. It contained no `.env`; provider, Discord, and game settings
  were removed from its inherited environment. This confirms the source
  checkout does not rely on this Mac's local secrets or previous build output.
- `actionlint` v1.7.7 reported no errors in the workflow. The three pinned
  action commit IDs were resolved against their upstream v7 tags.
- Git ignore checks confirmed `.env`, the compiled engine, Go build cache,
  and generated client/server/shared output are ignored.

There were no pre-existing build or test failures in these local runs. The
tests use local stubs and do not call OpenAI, Gemini, or Discord services.
This record does not establish that the GitHub-hosted Linux/macOS jobs have
passed; inspect their run before treating remote CI as verified.
