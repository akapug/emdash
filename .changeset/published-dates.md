---
"emdash": minor
---

Adds `getPublishedDates()`, which returns the publication dates of a collection's published entries, newest first, with a cache hint. It loads no entry, so a template can list the months or years its posts fall in, or link each one's archive, without loading every post:

```astro
---
import { getPublishedDates } from "emdash";

const { dates, cacheHint } = await getPublishedDates("posts");
if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
---
```

It is the query EmDash's Archives widget already runs.
