---
"emdash": patch
---

A build now records what it lets run, and where, in the config it embeds (`virtual:emdash/config`, as `execution`): the build-time plugins that run in-process (`trusted`), the build-time `sandboxed` entries, the `sandboxRunner`, whether `sandbox: false` bypasses it (`sandboxBypassed`), and whether plugins can be installed at runtime from the `marketplace` or the `registry`. A host that deploys the build can read it as data without running anything. `EmDashRuntime.create()` refuses to start, before it opens the database, when that record is malformed or names another sandbox mode than the one the runtime was given. `emdash()` refuses a `sandbox` that is not a boolean and a `sandboxRunner` that is not a module name, instead of reading them as either answer.
