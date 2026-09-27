# Development checkpoint — September 27, 2026

## Where development stopped

The active September 15 submission-recovery work has been reviewed, verified,
and saved in a local Git checkpoint titled
`Make phase submissions idempotent and recoverable`.

- Orders, retreats, and builds carry phase IDs and request IDs.
- Identical requests share one attempt; accepted receipts remain idempotent
  after the phase changes. Reusing an ID with different content is rejected.
- The server owns editing/submitting/accepted/failed status and restores it on
  reconnect. Rejected submissions can be corrected and retried.
- Mandatory Winter disbands no longer fail against a negative build allowance.
- Browser forms reflect server acceptance and retain local drafts during a
  network disconnect. Full page reloads do not preserve unsent drafts.

Verification on September 27: `npm run check` passed, including the production
build, all 69 server tests, and all 10 Go tests. No paid provider calls,
deployment, or live Discord tests were performed. Manual browser checks for
errors, retry/reconnect behavior, and form locking remain open.

## Next work

[code-review-backlog.md](code-review-backlog.md) is the current prioritized
repair checklist. The older roadmap and playtest notebooks retain the broader
feature plans; a planned feature is not necessarily implemented.

1. Finish the browser smoke checks for submission recovery and error visibility
   (R15/R16), ideally using two human clients.
2. Implement authoritative human legal-order menus (R17): friendly-occupied
   destinations, convoy support, cooperative convoys, and reachable split coasts.
   Godip already supplies legal-order catalogs for LLM decisions.
3. Repair chat delivery/retry behavior (R18), then persist games and recover
   interrupted phases transactionally (R7). Games currently disappear when the
   server process restarts.
4. Coordinate ongoing negotiations with phase resolution (R4), preserve all
   production AI configuration (R8), and account for every provider attempt (R20).

Future features include deadlines and pause/resume, draw/end-game rules, richer
power activity, and bounded all-LLM simulations. Voice and Discord repairs are
deferred behind reliable browser play and recovery. Product choices such as
deadline defaults and disconnected-seat replacement still need decisions.

## Set up another computer

Install Node.js 22.12 or newer, npm, Git, and Go 1.23 or newer. Once the
repository has been published, clone it using your GitHub SSH access:

```bash
git clone git@github.com:CameronDickie/diplomacy-ai.git
cd diplomacy-ai
npm ci
npm run check
npm run dev
```

Open `http://localhost:5173`. The development commands build the Go engine for
the current computer; neither Terraform nor deployment is needed for local play.

The server can start without a `.env` file using stub LLM controllers and no
Discord integration. For optional paid AI or Discord features, create a local
`.env` using [../.env.example](../.env.example) and the integration setup notes.
Local secrets, Terraform state, and generated build/dependency directories are
not part of the portable source checkout.
