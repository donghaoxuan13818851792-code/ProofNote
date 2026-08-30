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
