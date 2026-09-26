---
"@emdash-cms/plugin-forms": patch
---

Fixes a select field's `placeholder` being ignored. The list now opens on it as an empty, disabled, selected first option (unless one of its choices is the default), so a required list is not answered until the visitor picks a choice.
