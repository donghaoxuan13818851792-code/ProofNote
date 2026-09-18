# Diagnostics

Proofnote validates imported JSON in four tiers. Syntax and schema-structural
problems **block** the import; enum/type mismatches and content issues **warn**
and import as-is; render problems are non-blocking.

## 1. JSON syntax (fatal)

A custom state-machine scanner (`scanJsonError`) returns a structured error:

| code | meaning |
|---|---|
| `JSON_INVALID_ESCAPE` | `\x` where `x` is not a valid JSON escape (e.g. `\sqrt`) |
| `JSON_INVALID_UNICODE_ESCAPE` | `\u` not followed by exactly four hex digits |
| `JSON_UNTERMINATED_STRING` | string missing its closing `"` |
| `JSON_UNESCAPED_NEWLINE` | literal newline inside a string |
| `JSON_SINGLE_QUOTE` | `'` used where JSON requires `"` |
| `JSON_TRAILING_COMMA` | `,` immediately before `}` or `]` |
| `JSON_EXPECTED_COLON` | `:` missing after a property name |
| `JSON_EXPECTED_COMMA` | `,` missing between values |
| `JSON_UNEXPECTED_TOKEN` | stray character or token |
| `JSON_INVALID_NUMBER` | malformed number (e.g. `01`, `1.2.3`, `1e`) |
| `JSON_EXTRA_CONTENT` | content after the top-level JSON value |
| `JSON_UNEXPECTED_EOF` | input ends inside a container |

Every error carries `line`, `column`, `offset`, `length`, a `snippet`, a
`likelyCause` and a `suggestion`.

**Domain diagnosis** for `JSON_INVALID_ESCAPE` distinguishes:

- `LATEX_BACKSLASH_NOT_ENCODED` — the text looks like a LaTeX command
  (`\sqrt{2}`). Suggestion: write `\u005Csqrt{2}`. The scanner reads the full
  command (`[A-Za-z]+`), so `\sqrt` is never misreported as `\s`.
- `LATEX_SPACING_COMMAND` — a bare TeX spacing command (`\,`, `\;`, `\!`).
- `CODE_INVALID_JSON_ESCAPE` — a backslash in code/text; JSON-escape it (`\\`).

## 2. Schema (fatal vs warning)

`validateRaw` walks the raw parsed object before any sanitizing:

- **Fatal**: top level is not an object; `format` is not `solution-note`;
  `version` major mismatch.
- **Warning (kept as-is, never auto-modified)**: unknown fields; wrong-typed
  fields; invalid `meta.status` / `core.result.type` enum values; malformed
  block arrays; invalid `ui.sections` values.

## 3. Content preflight (warning)

`contentPreflight` scans parsed strings for problems that are valid JSON but
render wrong:

- a display-math opener missing its backslash (a line starting with bare `[`)
- control characters (from `\b` / `\f`-style mis-escapes)

## 4. Render (non-blocking)

KaTeX errors render as inline error spans (`math-error`) in the preview and in
the exported HTML; the source text is shown escaped.

## Import report

The import dialog shows a structured report: fatal errors list code, line/
column, problem, snippet, likely cause and suggestion; warnings list each
`path` with its message. Both languages are supported.

## Editable HTML transport diagnostics

**Import editable HTML** is deliberately separate from JSON import. It accepts
only the versioned Proofnote Editable HTML protocol; **Export editable HTML**
produces that form. It never executes the file, inserts imported DOM into the
live editor, or tries to infer a document from arbitrary HTML, CSS, classes, or
a rendered Proofnote-looking page.

Editable HTML 2 distinguishes an intact baseline canonical document from the
current, protocol-marked semantic HTML. The importer therefore reports one of
four clear transport outcomes instead of treating every changed file as broken:

| Outcome | What it means | Safe next step |
|---|---|---|
| **EXACT** | The generated file is unchanged and its canonical baseline is usable. | Import it directly, or replace the current document if that document is still at the same revision. |
| **RECOVERED** | The file changed, but every Proofnote semantic block and field can still be uniquely reconstructed. | Review the recovered content edits, added/deleted/moved blocks, and any warning before import. |
| **STALE** | The file is valid but was exported from an older local baseline. | Import it as a new document or branch. It cannot silently overwrite newer local work. |
| **INVALID** | The protocol or semantic mapping is absent, corrupted, unsafe, or ambiguous. | Repair/re-export the file, or use the `.proofnote.json` backup. Proofnote will not guess. |

### Visual-only changes are recovered, not imported as content

Editable HTML is a semantic protocol, not a CSS round-trip format. A full-file
fingerprint mismatch can be caused by an external stylesheet, a changed class,
a layout wrapper, or regenerated KaTeX markup. Those changes do not alter the
canonical Proofnote document.

When the protocol fields still represent the same canonical content, the
importer reports a `RECOVERED` visual-only result similar to:

```text
No ProofNote content changes detected; external visual-only changes were ignored.
```

The next Editable HTML export regenerates Proofnote's own CSS, classes, and
derived previews. By contrast, schema-owned values such as heading level,
callout type, table shape, and raw equation source are semantic fields and are
recovered normally when their protocol fields have changed.

### Typical blocking diagnostics

| Diagnostic | Meaning | Safe next step |
|---|---|---|
| Missing Proofnote Editable HTML protocol | The file is an ordinary webpage, a presentation export, or lacks required version-2 identity/source data. | Use a file from **Export editable HTML**, or import a `.proofnote.json` backup. |
| Proofnote presentation HTML cannot be re-imported | The file may look like a Proofnote export but has no baseline plus semantic block/field protocol. | Reopen the source document and export Editable HTML 2. Rendered or KaTeX fragments cannot recover hidden fields, stable IDs, or authoring state. |
| Unsupported Editable HTML version | The carrier version is not supported by this workspace. | Re-export from a compatible Proofnote version. An older 1.0 carrier, when supported, is an intact-source compatibility transport rather than a version-2 reconciliation file. |
| Baseline source integrity mismatch | The embedded canonical baseline was changed, truncated, duplicated, or cannot be validated. | Re-export from Proofnote or use the JSON backup. |
| Ambiguous semantic block identity | A block ID is duplicated, unknown, invalid, or appears in an invalid protocol position. | Restore the unique `data-pn-block-id` mapping, or re-export before editing again. |
| Ambiguous semantic field | A field is duplicated, unsupported, belongs to the wrong block, crosses a block boundary, or cannot be uniquely attributed. | Restore the required `data-pn-type` / `data-pn-field` relationship. Do not rely on classes or DOM position. |
| Unsupported block type or invalid semantic value | The external HTML names a block or schema value that Proofnote cannot represent safely. | Use a supported Proofnote block type and valid schema field values. |
| Resource or safety limit exceeded | HTML, source, decoded image, DOM, text, or rendering complexity is beyond a safe import limit. | Reduce the file or split the document; do not bypass the limit. |

The document/source fingerprints detect change and accidental corruption; they
are **not** digital signatures or proof of origin. Any accepted reconstructed
document still passes the ordinary JSON, schema, image, resource, and
remote-image approval boundaries before it is allowed into the editor.

On **Replace current document**, the dialog creates a recovery copy first and
uses a revision-checked write. If local work changed while the import was being
prepared, the replacement is stopped and reported as stale/conflicted instead
of overwriting it silently. **Import as new document** never changes the
currently open document and receives a fresh Editable HTML lineage. Library
duplicates, template instances, and recovery copies do too, so an independently
created local copy cannot later overwrite its source by accident. For a library
created by older releases, Proofnote repairs shared historical lineages using
revision-checked writes; an unresolved concurrent collision disables Replace
instead of guessing which local document should own the file.
