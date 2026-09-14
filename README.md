# Proofnote

### Structured documents, without the JSON pain.

**Proofnote** is an AI-friendly, structured document editor and renderer.
Its original Solution Note workflow remains available as a built-in template
and a fully compatible import/export format.

Build a document from designed blocks, catch broken LaTeX and malformed input
with precise diagnostics, save reusable templates, and export beautiful
standalone HTML — entirely offline.

**AI-friendly · LaTeX-safe · Structured · Diagnosable · Portable**

[Try Proofnote](https://donghaoxuan13818851792-code.github.io/ProofNote/?sample) · [Document format](docs/document-format.md) · [Document AI guide](docs/ai-document-authoring.md) · [Solution Note AI guide](docs/ai-authoring.md) · [Schemas](schema/) · [Examples](examples/)

<p align="center">
  <img src="docs/assets/proofnote-hero.png" width="850" alt="Proofnote — the Gaussian integer showcase note, rendered">
</p>

## It tells you where, why, and how to fix it

```
✗ Import failed

JSON_INVALID_ESCAPE
Line 6, Column 42

Found:
\sqrt

Likely cause:
LATEX_BACKSLASH_NOT_ENCODED

Suggested:
\u005Csqrt
```

Proofnote doesn't just tell you your JSON is broken. It tells you **where, why,
and how to fix it**.

<p align="center">
  <img src="docs/assets/error-diagnostics.png" width="700" alt="Proofnote import diagnostics">
</p>

## Quick start

Open `index.html` in any modern browser (Safari, Chrome, Firefox). No build
step, no server, no network needed — everything runs locally.

Run the test suite:

```bash
npm install
npm test
```

## What it does

- **Structured block documents** — compose title, headings, body text,
  equations, code, tables, images, quotes, dividers, page breaks, callouts,
  semantic mathematics blocks, lists, key–value lists, and stat cards.
- **Designed presets, not fiddly formatting** — choose a semantic block or
  heading level; Proofnote controls the typography, spacing, and print rules.
- **Built-in and personal templates** — start blank or from Proof Note,
  Research Note, Lab Report, and Essay / Report; save personal templates on
  the device and exchange them as JSON.
- **Dual-language UI** — Chinese and English, switchable in the toolbar.
- **JSON import/export** — `proofnote-document` is the default format;
  Solution Note 1.0 remains validated, automatically migrated, and explicitly
  exportable for compatibility.
- **LaTeX-safe by construction** — every math expression is real KaTeX; the AI
  authoring profile requires `\u005C` JSON-encoded backslashes, and the
  validator catches raw backslashes with actionable suggestions.
- **Standalone HTML export** — one self-contained file with embedded KaTeX and
  body fonts, styled for reading, printing, and sharing.
- **Safe by default** — HTML escaping (including quotes), `safeHref` filtering
  of markdown links, KaTeX `trust: false`, prototype-pollution guards, and a
  strict block whitelist for imported content.

## Formats

The general-purpose **Proofnote Document Format 1.0** is defined in
[`schema/proofnote-document-1.0.schema.json`](schema/proofnote-document-1.0.schema.json).
It is the default format for new documents and AI integrations. Read the
[format guide](docs/document-format.md) for block, preset, template, migration,
and offline-image rules.

**Solution Note Format 1.0** remains a separately versioned compatibility
format, defined in [`schema/solution-note-1.0.schema.json`](schema/solution-note-1.0.schema.json).
Its simplified AI authoring profile is documented in [`docs/ai-authoring.md`](docs/ai-authoring.md).

## Diagnostics

JSON errors are reported with structure, not jargon. See
[`docs/diagnostics.md`](docs/diagnostics.md) for the full error taxonomy, and
[`docs/escaping.md`](docs/escaping.md) for the security model.

## Repository layout

```
proofnote/
├── index.html              ← app entry point; runs fully offline from the clone
├── src/document-model.js   ← Document Format + Solution Note migration adapter
├── src/document-store.js   ← IndexedDB-first local document/template storage
├── src/document-editor.*   ← generic block editor and document preview
├── src/doc-page.js         ← print-aware preview page shell
├── vendor/                 ← vendored dependencies (KaTeX, fonts, design system)
├── schema/                 ← Document and Solution Note JSON Schemas
├── docs/                   ← format, AI authoring, escaping, diagnostics
├── examples/               ← sample notes (incl. the Gaussian integer showcase)
└── tests/                  ← regression + i18n suites (npm test)
```

> Note: `index.html` is the app's entry point and needs its `vendor/` and `src/`
> resources — it is *not* a single self-contained file. The **exported HTML**
> (via the editor) is the truly self-contained, offline artifact.

## License

MIT — see [LICENSE](LICENSE).
