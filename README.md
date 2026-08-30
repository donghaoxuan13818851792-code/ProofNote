# Proofnote

**Structured math, without the JSON pain.**

Proofnote is an editor, validator and renderer for the **Solution Note** format —
a portable, validated record of a mathematical or computer-science result. It
turns results into beautifully rendered, offline, standalone HTML notes that
survive being pasted into forums, Discord, or a GitHub issue.

`AI-friendly` · `LaTeX-safe` · `Diagnosable` · `Offline` · `Standalone HTML`

## Quick start

Open `index.html` in any modern browser (Safari, Chrome, Firefox). No build
step, no server, no network needed — everything runs locally.

Run the test suite:

```bash
npm install
npm test
```

## What it does

- **Dual-language UI** — Chinese and English, switchable in the toolbar.
- **JSON import/export** — paste an AI-produced note or a hand-edited file; get
  tiered diagnostics (JSON syntax → schema → content → render), never a silent
  failure.
- **LaTeX-safe by construction** — every math expression is real KaTeX; the AI
  authoring profile requires `\u005C` JSON-encoded backslashes, and the
  validator catches raw backslashes with actionable suggestions.
- **Standalone HTML export** — one self-contained file with embedded KaTeX and
  body fonts, styled for reading, printing, and sharing.
- **Safe by default** — HTML escaping (including quotes), `safeHref` filtering
  of markdown links, KaTeX `trust: false`, prototype-pollution guards, and a
  strict block whitelist for imported content.

## Format

Proofnote speaks one canonical format — **Solution Note Format 1.0** — defined
in [`schema/solution-note-1.0.schema.json`](schema/solution-note-1.0.schema.json).

A separate, simplified **AI Authoring Profile** describes the compact JSON an
LLM should emit; Proofnote normalizes it into the canonical form before
rendering. See [`docs/ai-authoring.md`](docs/ai-authoring.md).

## Diagnostics

JSON errors are reported with structure, not jargon:

```
JSON_INVALID_ESCAPE
Line 6, Column 42

Found: \sqrt
Suggested: \u005Csqrt
```

See [`docs/diagnostics.md`](docs/diagnostics.md) for the full error taxonomy.

## Repository layout

```
proofnote/
├── index.html              ← the whole app (single file, self-contained)
├── src/doc-page.js         ← preview page shell
├── vendor/                 ← vendored dependencies (KaTeX, fonts, design system)
├── schema/                 ← Solution Note Format 1.0 JSON Schema
├── docs/                   ← format, AI authoring, escaping, diagnostics
├── examples/               ← sample notes (incl. the Gaussian integer showcase)
└── tests/                  ← regression + i18n suites (npm test)
```

## License

MIT — see [LICENSE](LICENSE).
