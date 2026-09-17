# AI authoring: Proofnote Document Format 1.0

Proofnote Document is the default format for AI-created documents. It is a
structured exchange format, not a request for users to write JSON by hand: the
editor creates and changes all blocks visually.

An AI response should be one valid JSON object with:

```json
{
  "format": "proofnote-document",
  "version": "1.0",
  "metadata": {
    "name": "A concise document name",
    "templateName": "Optional source template name"
  },
  "blocks": []
}
```

Use the small, reusable block vocabulary below. Do not add CSS, HTML, arbitrary
fonts, colours, margins, or coordinates; Proofnote owns those decisions.

| Purpose | Block shape |
| --- | --- |
| Page title | `{ "type": "title", "content": "…" }` |
| Subtitle | `{ "type": "subtitle", "content": "…" }` |
| Section | `{ "type": "heading", "level": 1, "content": "…" }` where level is 1–3 |
| Body text | `{ "type": "paragraph", "content": "…" }` |
| Display math | `{ "type": "equation", "content": "x^2+y^2=z^2" }` |
| Code | `{ "type": "code", "language": "python", "content": "…" }` |
| Table | `{ "type": "table", "columns": ["A", "B"], "rows": [["…", "…"]] }` |
| Quote | `{ "type": "quote", "content": "…", "citation": "…" }` |
| Callout | `{ "type": "callout", "kind": "note", "title": "…", "content": "…" }` |
| Mathematical/technical module | `{ "type": "semantic", "kind": "theorem", "title": "…", "label": "Theorem", "content": "…", "summary": "…" }` |

`semantic.kind` is one of `problem`, `theorem`, `proof`, `result`, or
`verification`. `callout.kind` is one of `note`, `tip`, `warning`, or `info`.
Proofnote assigns the matching `preset` when importing. Omit it from
AI-authored JSON; it is a derived compatibility field, not an authoring
control.

For the Proof Note template only, an optional display setting can control its
editorial metadata row without deleting document metadata values:

```json
"proofMetadata": { "fields": ["author", "date"] }
```

Use any subset of `author`, `date`, and `status`; use an empty `fields` list to
hide the entire row. Omit `proofMetadata` to show all three.

For a semantic block that must override its template's presentation, use
`"appearance": "editorial"` or `"appearance": "card"`. Normally omit this
field: Proof Note uses the editorial treatment by default, while other
templates may choose cards where appropriate.

For prose containing LaTeX, return valid JSON. That means a literal backslash
must be JSON-escaped, for example `"content": "\\(x \\le \\sqrt{2}\\)"`.
Do not apply this rule to code content beyond normal JSON escaping. The importer
continues to diagnose invalid JSON and unsafe content before normalising it.

Use a string `src` for image blocks. Prefer an `https` URL when an image is
already available; ordinary users can instead choose a local image directly in
the editor.

The older [Solution Note AI authoring profile](ai-authoring.md) remains valid
when a caller explicitly needs `solution-note` version `1.0`.
