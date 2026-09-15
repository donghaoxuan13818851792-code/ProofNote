# Proofnote Document Format 1.0

`proofnote-document-1.0` is the general-purpose interchange format for
Proofnote. It represents a document as ordered, typed blocks while leaving
typography under Proofnote's control.

```json
{
  "format": "proofnote-document",
  "version": "1.0",
  "metadata": {
    "name": "A compact research note",
    "templateName": "Research Note",
    "author": "Ada Lovelace",
    "date": "2026-09-14"
  },
  "blocks": [
    { "id": "title_1", "type": "title", "preset": "document-title", "content": "A compact research note" },
    { "id": "heading_1", "type": "heading", "preset": "heading-1", "level": 1, "content": "Main result" },
    { "id": "result_1", "type": "semantic", "preset": "semantic-result", "kind": "result", "appearance": "editorial", "label": "Theorem", "title": "Result", "content": "…" }
  ]
}
```

## Model principles

- `type` describes structure: a heading, image, table, paragraph, code block,
  or another reusable content component.
- `preset` is a Proofnote-owned typography or component preset. It is recorded
  for portability, but users do not enter arbitrary fonts, colours, spacing,
  or font sizes.
- `kind` adds semantic meaning where needed. A single `semantic` block supports
  `section`, `introduction`, `problem`, `theorem`, `proof`, `result`, and `verification`; a single
  `callout` supports `note`, `tip`, `warning`, and `info`.
- `appearance` is optional on semantic blocks. `editorial` renders a continuous
  publication-style section and `card` renders a component card. When omitted,
  the selected template chooses the presentation.
- A document name lives in `metadata.name`. It is deliberately separate from a
  movable `title` block, so file identity and page title are not coupled.
- `metadata` may also carry template-controlled document details such as
  `documentType`, `noteNumber`, `author`, `date`, `status`, and `source`.
  A document that uses a repeated page header may store independently editable
  `runningHeader.left` and `runningHeader.right` labels; these are distinct
  from the document name and movable title block.
  `headerSubtitle.visible` controls whether the adjacent editable subtitle
  block is shown in a document header. Hiding it preserves the subtitle text,
  so it can be re-enabled later in the Inspector.
  A Proof Note may add `proofMetadata.fields` with any subset of `author`,
  `date`, and `status` to control which of those details appear in its
  editorial metadata row. An empty list hides the row while preserving the
  values in the document; omitting the setting shows all three for backwards
  compatibility.

The first version supports title, subtitle, heading levels 1–3, paragraph,
equation, code, table, image, quote, divider, page break, callout, semantic
block, list, key–value list, and stat cards. The last three also allow legacy
Solution Note content-block arrays to migrate without throwing content away.

Tables keep columns and rows as portable content. Their optional `header`
boolean controls whether the columns render as a header row; omitting it keeps
the established header-on behaviour. This lets authors switch between a data
table and a plain grid without creating a separate block type.

## Templates

Templates use a separate `proofnote-template` envelope. A template contains a
normal document plus a name and description. Built-in templates include Blank
Document, Proof Note, Research Note, Lab Report, and Essay / Report. User
templates are saved locally and can be exported or imported as JSON.

Proofnote stores documents and templates in IndexedDB when available. It falls
back to local storage only when IndexedDB cannot be used. This keeps local
image data practical without binding the format to a small storage quota.

## Local document library

The local library treats a document as the primary product entity. Each record
has a device-only ID plus `createdAt`, `updatedAt`, and `lastOpenedAt` values
for opening, renaming, duplicating, deleting, and ordering recent documents.
Those record fields are never added to exported `proofnote-document` JSON.

On first use, the earlier single `current-document` record is migrated into one
library record without changing its document payload. `+ New document` uses the
same blank-document factory but creates a new record; it never replaces the
currently open document. The Templates view presents approved starting points
separately from recent local documents.

## Solution Note compatibility

`solution-note` version `1.0` remains a supported input format. On import it
is validated as raw Solution Note JSON, then adapted into a Proofnote Document:

- the old note title and summary become Title and Subtitle blocks;
- Problem, Result, Proof and Verification become semantic blocks;
- old content blocks map to paragraph, list, code, equation, table, callout,
  key–value, and stat blocks; and
- original note metadata is retained in compatibility metadata and surfaced as
  editable document metadata for a later Solution Note export.

New documents export as `proofnote-document` by default. The editor still
offers an explicit Solution Note export for compatibility; components which do
not exist in Solution Note are omitted and reported to the user.

## Images and offline export

An image block may use an `https` URL or a local image selected by the user.
Selected local PNG, JPEG, GIF, and WebP images are stored as safe image data
URLs, so they persist offline and are included in standalone HTML export.

See the machine-readable schema at
[`schema/proofnote-document-1.0.schema.json`](../schema/proofnote-document-1.0.schema.json).
