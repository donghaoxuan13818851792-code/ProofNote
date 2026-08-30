# AI Authoring Profile — Solution Note Format 1.0

The **Solution Note Format 1.0** is the canonical interchange format (see
[`../schema/solution-note-1.0.schema.json`](../schema/solution-note-1.0.schema.json)).
This document describes the **AI authoring profile**: the simplified input form
an LLM should emit. Proofnote accepts it, normalizes it to the canonical form,
and renders it.

> compact AI JSON → normalize → canonical Solution Note 1.0 → renderer

## 1. The JSON contract

- Return ONLY one valid JSON object. No Markdown code fences, no commentary.
- The output must pass `JSON.parse` without modification.
- Top level:
  - `"format": "solution-note"`
  - `"version": "1.0"`

## 2. Shape

Long text fields (`summary`, `problem`, `result.statement`,
`result.explanation`, `whyItWorks[].body`, optional sections, …) are plain
**Markdown strings**. The block-array form is only needed when editing inside
Proofnote — an AI should always prefer the compact string form.

```json
{
  "format": "solution-note",
  "version": "1.0",
  "meta": {
    "title": "",
    "summary": "",
    "author": "",
    "date": "",
    "status": "",
    "source": ""
  },
  "core": {
    "problem": "",
    "result": { "type": "", "statement": "", "explanation": "" },
    "whyItWorks": [ { "title": "", "body": "" } ],
    "evidence": "",
    "reproduce": {
      "sourceCode": "",
      "data": "",
      "verificationScript": "",
      "certificate": "",
      "discussion": ""
    }
  },
  "optional": {
    "proof": "",
    "algorithm": "",
    "computationalResults": "",
    "performance": "",
    "examples": "",
    "verificationDetails": "",
    "limitations": "",
    "openQuestions": "",
    "notes": "",
    "references": [ "" ],
    "acknowledgements": ""
  }
}
```

### Enums

- `meta.status` — exactly one of:
  `Solved`, `Partial`, `Computational`, `Conjecture`, `Counterexample`, `Improved Algorithm`
- `core.result.type` — exactly one of:
  `Theorem`, `Main Result`, `Construction`, `Counterexample`, `Computed Value`,
  `Bound`, `Formula`, `Conjecture`, `Algorithmic Result`

### Author

Use `author` **only if** the author's name is known from the supplied context.
Otherwise omit it or leave it empty. Never invent an author.

### Field guidance

- `summary` — one short paragraph.
- `problem` — sufficient for a mathematically literate reader.
- `result.statement` — the principal result, stated precisely.
- `result.explanation` — what it means, without repeating a full proof.
- `whyItWorks` — 2–5 short high-level mechanisms.
- Substantial proofs → `optional.proof`; search procedures → `optional.algorithm`;
  numerical outputs → `optional.computationalResults`; independent checks →
  `optional.verificationDetails`; caveats → `optional.limitations`;
  genuine open directions → `optional.openQuestions`; bibliography → `optional.references`.
- Omit optional fields that are unsupported. Omit `reproduce` entirely for a
  purely theoretical result with no computational artifacts.
- Never use placeholders like `"N/A"`, `"None"`, `"-"`, or `[""]` to fill the schema.

## 3. LaTeX and JSON escaping (critical)

Every mathematical expression must be LaTeX. **Never write a literal LaTeX
backslash in the JSON source.** Encode EVERY LaTeX backslash as the JSON
Unicode escape `\u005C`.

- Math delimiters: `\u005C(` … `\u005C)` (inline), `\u005C[` … `\u005C]` (display).
- TeX commands: `\u005Csqrt{2}`, `\u005Csum_i`, `\u005Cfrac{a}{b}`,
  `\u005Cmathbb{Z}`, `\u005Cle`, `\u005Cge`, `\u005Cin`, `\u005Cequiv`,
  `\u005Ctau`, `\u005Cnu`, `\u005Cmid`, `\u005Cnmid`, `\u005Ccdot`,
  `\u005Clfloor`, `\u005Crfloor`.

Correct JSON source:

```json
"body": "For \u005C(n \u005Cge 1\u005C), we have \u005C(F_n>0\u005C)."
```

After `JSON.parse` this becomes `For \(n \ge 1\), we have \(F_n>0\).`

### Code fields are different

In `reproduce.sourceCode` / `reproduce.verificationScript` / `reproduce.data`,
backslashes are **source-code content**, not LaTeX. Use ordinary JSON escaping:
one backslash becomes `\\`.

Correct: `"sourceCode": "import re\npattern = r\"\\d+\""` — never `\u005Cd+` there.

### LaTeX simplicity

Use simple, robust LaTeX. Avoid spacing commands (`\,`, `\;`, `\!`) and rarely
needed constructs — they are easy to mistype in JSON and add no meaning.

## 4. Partial update mode

Only when the user explicitly asks to modify an existing note:

- omitted field = leave the existing value unchanged
- `""` = clear a text field
- `[]` = clear a list

Do not interpret ordinary missing information as a partial-update request.

## 5. Validation tiers (what Proofnote will tell the user)

- **JSON syntax** (fatal): invalid escapes, unterminated strings, unescaped
  newlines, single quotes, trailing commas, bad Unicode escapes, bad numbers,
  extra content, unexpected EOF.
- **Schema** (fatal vs warning): wrong `format`/`version` block; unknown or
  wrong-typed fields **warn and are kept as-is**; invalid enum values warn and
  are kept as-is (never auto-modified).
- **Content** (warning): display-math openers missing their backslash, control
  characters from `\b`/`\f`-style mis-escapes.
- **Render** (non-blocking): KaTeX errors render as inline error spans.
