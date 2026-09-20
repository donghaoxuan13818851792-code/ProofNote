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
    "templateId": "research-note",
    "author": "Ada Lovelace",
    "date": "2026-09-14"
  },
  "blocks": [
    { "id": "title_1", "type": "title", "content": "A compact research note" },
    { "id": "heading_1", "type": "heading", "level": 1, "content": "Main result" },
    { "id": "result_1", "type": "semantic", "kind": "result", "appearance": "editorial", "label": "Theorem", "title": "Result", "content": "…" }
  ]
}
```

## Model principles

- `type` describes structure: a heading, image, table, paragraph, code block,
  or another reusable content component.
- `preset` is a derived Proofnote-owned compatibility field. Proofnote computes
  it from each block's type, kind, and level; authors should omit it rather
  than treating it as a formatting control.
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

## Resource limits

The portable contract is also the rendering-safety contract: equation source
is limited to 12,000 characters, and tables may have at most 500 rows, 50
columns, and 5,000 cells in total. A document may contain at most 2,000 blocks
and 20MB of aggregate text. Proofnote refuses to export a backup that fails
these runtime checks or exceeds the 25MB import-size ceiling, so a downloaded
`.proofnote.json` remains importable by the same version of Proofnote.

## Proofnote Editable HTML 2

Proofnote has two intentionally different HTML exports:

- **HTML (presentation)** is a standalone reading and printing artifact. It
  contains rendered typography, KaTeX output, code highlighting, and local
  images, but no Editable HTML protocol. It cannot be re-imported as a
  Proofnote document.
- **Editable HTML 2** is a strict, single-file *semantic* round-trip
  protocol. It contains a baseline canonical Proofnote document and a visible,
  protocol-marked semantic representation of its current content. Use it when
  the file needs to be edited outside Proofnote and then return for further
  editing.

Editable HTML is not a generic HTML importer and is not a visual round-trip
format. Proofnote never executes an imported file and never infers document
structure from arbitrary tags, classes, page layout, or KaTeX output. It reads
only the dedicated version-2 protocol and then applies the normal JSON, schema,
resource, image, and remote-image-approval boundaries before content reaches
the editor.

### Scope: semantic content, not arbitrary visual HTML

The canonical source of truth remains a `proofnote-document`. Editable HTML
preserves and reconciles the semantic fields that Proofnote owns:

- block identity and order;
- supported block type and its schema fields, including heading level,
  callout kind, semantic kind/appearance, table columns/rows/header, list
  ordering, code language, image source metadata, and document metadata; and
- text and explicit raw mathematics source.

It deliberately does **not** preserve arbitrary visual edits. CSS rules,
classes, font choices, layout wrappers, margins, and other presentation-only
markup do not enter the canonical document. They may change or disappear
between imports. The next export regenerates Proofnote's own CSS, classes, and
derived rendering.

Likewise, a KaTeX preview is derived output, not source. Equations and inline
math retain an explicit protocol field containing their raw TeX; import ignores
the rendered KaTeX subtree and regenerates it from that source. Code previews
and other generated reader markup follow the same principle.

### Three protocol layers

An Editable HTML 2 file has three related layers:

1. **Protocol identity.** Required versioned metadata identifies the file as
   `editable-html` version `2`, carries a non-secret Proofnote magic marker,
   and identifies the portable document and baseline revision. The marker is a
   file signature for recognition, not an authentication credential.
2. **Embedded baseline.** One inert, versioned
   `proofnote-editable-source` JSON carrier contains the canonical Proofnote
   document from which the export was made. Its source integrity data protects
   the baseline from accidental corruption.
3. **Semantic HTML.** A unique protocol document root contains current visible
   content. Stable `data-pn-block-id`, `data-pn-type`, and `data-pn-field`
   attributes identify the canonical blocks and fields that may be reconciled.

The source carrier is a baseline, not a hidden winner over external edits. On
import Proofnote compares it with the current semantic HTML to construct the
next canonical document. Each later Editable HTML export embeds that latest
canonical revision as its next baseline, enabling repeated Proofnote → external
editor → Proofnote cycles.

### Semantic DOM rules

Classes are never protocol data. A compatible external editor may add, remove,
or rearrange non-semantic wrappers and may change CSS or classes, provided that
the protocol's block/field relationships stay unique and unambiguous.

For an existing block, its stable `data-pn-block-id` identifies the same
canonical block regardless of its DOM position. Moving it changes ordering;
omitting it requests deletion; editing an explicit field changes that field.
External blocks use the protocol's external-ID namespace and receive a normal
Proofnote block ID after a successful import. The importer rejects rather than
guesses when it encounters any of the following:

- duplicate, unknown, or invalid block IDs;
- duplicate fields, missing required fields, unsupported field names, or a
  field belonging to more than one block;
- a field whose closest protocol block does not own it;
- an unsupported block type or invalid schema value; or
- an absent, duplicated, or malformed source carrier, protocol root, or
  identity metadata.

This deliberate strictness protects semantic meaning while still allowing
ordinary HTML cleanup around the protocol fields.

### Import outcomes and revision safety

The importer reports one of four outcomes:

| Outcome | Meaning | Available action |
| --- | --- | --- |
| **EXACT** | The generated file is unchanged and its baseline is current. | Import the canonical baseline, or replace the current document when its revision still matches. |
| **RECOVERED** | The file changed, but the protocol still maps every semantic field clearly. | Review the recovered edits, insertions, deletions, moves, and warnings; then import or replace when current. |
| **STALE** | The file is structurally valid but came from an older baseline than the local document. | Import as a new document or branch. It cannot silently replace newer local work. |
| **INVALID** | The protocol, baseline, or semantic mapping cannot be trusted or reconstructed uniquely. | Repair or re-export the file; Proofnote will not guess. |

A whole-file fingerprint is useful for the `EXACT` fast path and for deciding
whether reconciliation is needed. It is **not** a digital signature or proof
of origin. A fingerprint mismatch caused only by CSS, classes, wrappers, or
derived preview markup is a `RECOVERED` result, not an error. Proofnote reports
that no content changed and ignores those visual-only changes.

When replacing the current document, Proofnote first creates a recovery copy
and then uses revision-aware storage. A concurrent local change converts the
operation to a stale/conflict outcome rather than overwriting it. **Import as
new document** always keeps the currently open document untouched and assigns
the imported copy a fresh Editable HTML lineage. This prevents a later export
from that copy from being used to replace the source document. Library
duplicates, template instances, and recovery copies receive the same lineage
isolation; only an explicit replace continues an existing lineage. When an
older library contains historical duplicate lineages, Proofnote retains one
deterministic owner and forks the other records through revision-checked
writes. If another tab prevents that repair from completing, replacement stays
disabled until the collision is resolved.

### Privacy, limits, and compatibility

Because an Editable HTML file includes the baseline source—potentially raw
code and TeX, hidden semantic body/notes, metadata, and embedded images—treat
it like a project backup and share it only with people who should have that
source. It is limited to 64MB; its embedded and reconstructed document must
also meet the normal portable 25MB and runtime limits.

Older Proofnote standalone HTML files are presentation-only. They can contain
Proofnote-looking classes and rendered KaTeX, yet still lack the complete
baseline and semantic mapping needed for reliable recovery. They are reported
as unsupported presentation exports rather than reconstructed with lossy DOM
inference. Where an older Editable HTML 1.0 source carrier is supported, it is
an intact-source compatibility transport only; it does not provide the version-2
semantic reconciliation workflow. Use the original `.proofnote.json` backup or
export the document again as Editable HTML 2 to begin a durable round trip.

## Templates

Templates use a separate `proofnote-template` envelope. A template contains a
normal document plus a name and description. Built-in templates include Blank
Document, Proof Note, Research Note, Lab Report, and Essay / Report. User
templates are saved locally and can be exported or imported as JSON.

Proofnote stores documents, templates, and local Project containers in
IndexedDB when available. It falls back to local storage only when IndexedDB
cannot be used. This keeps local image data practical without binding the
format to a small storage quota.

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

### Local Project containers

A **local Project container** is a navigator and workspace concept, not a new
portable document type. It has its own local ID, name, timestamps, and local
revision. A document record may refer to one Project. That membership and the
local ordering metadata live on the device-only library record; they are never
added to the portable `proofnote-document` object.

Consequently, moving a document between Projects or changing its local order
does not alter the document body, canonical metadata, Editable HTML lineage,
JSON backup, template payload, or HTML export. The current UI orders Project
documents by their most recent edit. Deleting a Project removes only the local
container and returns its documents to the unfiled library. A Project’s landing
page is a local overview of its independent documents. It deliberately does
not expose a filesystem, arbitrary folders, source files, assets, or an
implicit project-wide AI context.

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
