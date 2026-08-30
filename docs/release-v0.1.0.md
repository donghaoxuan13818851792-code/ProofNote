# Proofnote v0.1 — First public release

Proofnote is an AI-friendly editor, validator, and renderer for structured mathematical and computer-science solution notes.

## Highlights

- Structured **Solution Note Format 1.0**
- Simplified **AI Authoring Profile**
- LaTeX-safe JSON using `\u005C` encoding
- Precise JSON diagnostics with line, column, likely cause, and suggested fixes
- Tiered validation: syntax → schema → content → rendering
- KaTeX-powered mathematical rendering
- Standalone self-contained HTML export
- Chinese / English interface
- Safe markdown links and HTML escaping
- Prototype-pollution guards
- Offline-first: clone and open `index.html`
- 58 regression and i18n tests

## Example diagnostic

```text
JSON_INVALID_ESCAPE
Line 6, Column 42

Found:
\sqrt

Likely cause:
LATEX_BACKSLASH_NOT_ENCODED

Suggested:
\u005Csqrt
```

Proofnote doesn't just tell you that your JSON is broken — it tells you where, why, and how to fix it.

## Status

This is the first public release of Proofnote. The application itself currently identifies as `3.1.0-rc.1`; the public open-source release line begins at `v0.1.0`.
