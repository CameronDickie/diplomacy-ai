# Rules Engine Adapter

This executable wraps Godip `v0.6.5` behind a JSON-over-stdio protocol. Keeping
the rules implementation in a separate process gives the Node application a
small, replaceable adjudication boundary.

Build from the repository root:

```bash
npm run build:engine
```

The resulting ignored binary is `engine/bin/diplomacy-engine`.

Godip and the SVG map are GPL-3.0 licensed. See
[../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
