---
"emdash": patch
---

Fixes images and galleries inside a `columns` block (in any column, including a columns block nested in a column) or a `cover` block not being counted as media usage, so a media item used only there no longer looks unused. Indexes built before this read as stale until they are rebuilt. `extractPlainText`, which the Vectorize and AI Search plugins index, now includes the words inside columns and cover blocks.
