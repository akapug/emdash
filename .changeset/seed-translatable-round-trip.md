---
"emdash": patch
---

Fixes seed handling of `translatable` so non-translatable fields survive an `applySeed` → `export-seed` round-trip.

Seed files can now declare `"translatable": false` on fields; the flag is persisted to `_emdash_fields` and emitted by `emdash export-seed` when a field is non-translatable. The default stays `true` when the key is omitted.
