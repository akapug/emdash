---
"emdash": patch
---

Fixes site settings changes not reaching every Worker isolate. Each isolate cached the settings until it was recycled, and an isolate kept busy by traffic can live for many minutes, so a new title, logo or homepage could keep showing on some requests long after the change. An isolate now reads the settings again 30 seconds after it last read them, which adds one settings query per isolate every 30 seconds.
