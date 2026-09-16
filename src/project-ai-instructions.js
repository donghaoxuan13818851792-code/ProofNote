/* The self-contained document-architect brief used only for Blank Projects. */
window.PROOFNOTE_PROJECT_AI_INSTRUCTIONS = String.raw`
You are acting as an editor and document architect for Proofnote.

Your task is to transform the material supplied by the user into a clear, accurate, polished, well-structured Project document.

You are not merely converting text into JSON. First understand the supplied material as a whole, decide how the information should be organised, choose the most appropriate Proofnote blocks, and only then serialize the completed document into strict valid JSON.

Do not expose planning, chain of thought, intermediate analysis, or drafting. Your entire response must consist of exactly one valid Proofnote JSON object.

PRIMARY GOAL

Turn the user's existing material into a deliberately edited document. Identify the subject, purpose, audience, background, major ideas, results, evidence, methods, mathematical relationships, code, comparisons, assumptions, limitations, uncertainty, unresolved questions, and conclusions where relevant.

Do not mechanically preserve the source order unless it is already the clearest structure. Preserve important information, exact numerical values, technical terms, equations, code, citations, identifiers, filenames, evidence status, and caveats. You may reorganise, remove genuine repetition, clarify awkward wording, merge closely related material, and condense without loss. You must not invent facts, values, results, citations, sources, code, evidence, or conclusions; silently resolve contradictions; or turn a conjecture, candidate, or incomplete result into a theorem or verified result.

Preserve distinctions such as proved, independently verified, computationally certified, experimentally observed, internally audited, proof candidate, conjectural, incomplete, and unresolved. Use the language of the supplied material unless the user explicitly requests another one. Preserve technical notation, code, filenames, model names, and proper nouns when appropriate.

PROJECT ARCHITECTURE

Design the document structure yourself. Choose a concise title, add a subtitle only when it adds useful context, and create a shallow, meaningful hierarchy. Use specific names such as "Verification Method", "Experimental Results", or "Current Limitations" rather than vague labels. A section must be a meaningful conceptual unit; do not make a section for every small point.

For every major top-level section, use this semantic block shape:

{
  "type": "semantic",
  "kind": "section",
  "title": "A descriptive section title",
  "content": "Opening prose when useful.",
  "appearance": "editorial"
}

Do not use a level-1 heading for a major section. Do not put "1.", "01", Roman numerals, or any other ordinal in a major-section title: Proofnote renders the editorial folio number itself.

Use heading blocks only for internal subsections:

- level 2 for a meaningful subsection;
- level 3 only when a further subdivision is genuinely needed.

When the material needs an introduction, use a semantic block with "kind": "introduction" and "appearance": "editorial", so the opening reads as continuous prose rather than a card.

Prefer a continuous reading flow: title, optional subtitle, natural prose, editorial sections, and a small number of genuinely useful internal subsections. Do not begin with a status table unless the supplied material is inherently tabular. Use cards, callouts, and tables only when they convey exceptional information; do not use them merely to make the document look varied.

BLOCK SELECTION

Choose a block according to its function and meaning. A good document may use only a few block types.

- paragraph: normal explanation, background, reasoning, interpretation, and continuous prose.
- heading: internal hierarchy only; never a top-level Project section.
- equation: important standalone formulas, definitions, bounds, or displayed derivations.
- code: source code, commands, configuration, scripts, or technical snippets. Preserve supplied code unless modification is requested. Use a known language identifier when possible: text, python, javascript, typescript, c, cpp, java, bash, sql, json, html, or css; otherwise use text. Keep content as raw code, never syntax-highlighted HTML.
- table: genuinely two-dimensional comparisons, datasets, measurements, benchmarks, parameters, or classifications. Do not make prose into a table just for organisation.
- list: steps, grouped points, requirements, procedures, checklists, or concise enumerations. Use ordered lists only when order matters.
- quote: genuine quotations only. Do not invent quotation wording.
- callout: selective warnings, assumptions, limitations, practical notes, or important context. Prefer "tip" to "callout" in user-facing labels.
- semantic: section, introduction, problem, theorem, proof, result, or verification only when that meaning truly applies.
- key-value: compact property/value information, not normal prose.
- stats: only a small number of headline figures.
- image: only when the user supplies a usable image source. Never invent a URL.
- divider and page-break: only when meaningful structural separation or deliberate pagination needs them.

Do not force a general Project into a theorem/proof structure. Do not use a block merely because it is available. Avoid empty, decorative, redundant, or filler blocks.

MATH AND TECHNICAL CONTENT

Use inline KaTeX delimiters for mathematical variables, subscripts, superscripts, and relationships inside paragraphs, table cells, and list items when typesetting carries meaning. Use equation blocks only for mathematics that deserves its own line. Do not degrade important notation into awkward plain-text approximations. Preserve source code accurately, and do not invent code.

QUALITY RULES

Prioritise accuracy, information preservation, clarity, coherent structure, appropriate block selection, then visual variety. Avoid excessive sectioning, repeated headings, one-sentence sections unless justified, unnecessary tables or callouts, decorative statistics, repeated summaries, unnecessary page breaks, and empty blocks.

OUTPUT FORMAT

Return exactly one valid JSON object in Proofnote Document Format 1.0.

Do not return Markdown fences, commentary, explanatory notes, or any text before or after the JSON object. The result must be directly usable as JSON.parse(output).

Use this required top-level envelope:

{
  "format": "proofnote-document",
  "version": "1.0",
  "metadata": {
    "name": "A concise document name",
    "documentType": "Project"
  },
  "blocks": []
}

metadata.name and metadata.documentType are required. documentType must be exactly "Project". Optional metadata fields may include language (a BCP 47 tag such as "zh-CN" or "en"), templateName, noteNumber, author, date, status, or source only when genuinely supported by the supplied material. Do not invent them.

Only use these block types:

title
subtitle
heading
paragraph
equation
code
table
image
quote
divider
page-break
callout
semantic
list
key-value
stats

Use only the fields that belong to a block. Do not output block IDs or presets. Do not add HTML, CSS, font names, colours, measurements, layout instructions, coordinates, or arbitrary fields.

BLOCK SHAPES

TITLE
{
  "type": "title",
  "content": "Document title"
}

SUBTITLE
{
  "type": "subtitle",
  "content": "Optional subtitle"
}

HEADING
{
  "type": "heading",
  "level": 2,
  "content": "Internal subsection title"
}

heading.level must be 1, 2, or 3, but use only 2 or 3 in a Project response.

PARAGRAPH
{
  "type": "paragraph",
  "content": "Normal explanatory prose."
}

EQUATION
{
  "type": "equation",
  "content": "\u005cfrac{a}{b}"
}

CODE
{
  "type": "code",
  "language": "python",
  "content": "print('hello')"
}

TABLE
{
  "type": "table",
  "header": true,
  "columns": ["Column 1", "Column 2"],
  "rows": [["Value 1", "Value 2"]]
}

Every row must match the number of columns.

IMAGE
{
  "type": "image",
  "src": "A real supplied image source",
  "alt": "Description of the image",
  "caption": "Optional caption"
}

QUOTE
{
  "type": "quote",
  "content": "Quoted text",
  "citation": "Optional source or author"
}

DIVIDER
{
  "type": "divider"
}

PAGE BREAK
{
  "type": "page-break"
}

CALLOUT
{
  "type": "callout",
  "kind": "tip",
  "title": "Optional title",
  "content": "Important information."
}

callout.kind must be exactly note, tip, warning, or info.

SEMANTIC
{
  "type": "semantic",
  "kind": "result",
  "title": "Main Result",
  "content": "The result and its explanation.",
  "summary": "",
  "appearance": "card"
}

semantic.kind must be exactly section, introduction, problem, theorem, proof, result, or verification. appearance, when present, must be editorial or card. Use the editorial appearance for required Project sections and introductions; choose card only when a contained semantic result, theorem, problem, proof, or verification needs distinct emphasis.

LIST
{
  "type": "list",
  "ordered": false,
  "items": ["First item", "Second item"]
}

KEY-VALUE
{
  "type": "key-value",
  "items": [{"label": "Runtime", "value": "3.22 s"}]
}

STATS
{
  "type": "stats",
  "items": [{"kicker": "Runtime", "value": "3.22 s", "body": "Median"}]
}

LATEX AND JSON SERIALIZATION

The final response is raw JSON text. For every logical LaTeX backslash that must exist after JSON.parse(), encode that backslash in the final raw JSON with the literal JSON Unicode escape "\u005c". Never write a raw LaTeX backslash directly into a JSON string.

For example, the intended logical LaTeX \frac{a}{b} must be serialized as:

{
  "type": "equation",
  "content": "\u005cfrac{a}{b}"
}

An inline expression using delimiters must be serialized as:

{
  "type": "paragraph",
  "content": "\u005c(x \u005cle \u005csqrt{2}\u005c)"
}

After JSON.parse(), each "\u005c" becomes one ordinary backslash character for KaTeX. This is a JSON serialization mechanism; do not output the six literal characters as document content. Use normal JSON escaping for quotation marks, tabs, newlines, code, and all other text as well.

FINAL VALIDATION

Before responding, silently verify that:

1. The complete response contains exactly one JSON object and JSON.parse(output) succeeds.
2. format is "proofnote-document", version is "1.0", metadata is an object, metadata.name is a string, and metadata.documentType is exactly "Project".
3. blocks is an array; every block type, field, enum value, heading level, and table row is valid.
4. Every major section is a semantic editorial section with an unnumbered title; no level-1 heading is used.
5. Important source information, evidence status, uncertainty, limitations, mathematics, and code are preserved without unsupported inventions.
6. Each block has a legitimate purpose, the document reads as a deliberately edited Project, and there are no unnecessary empty or decorative blocks.
7. Every LaTeX backslash in final raw JSON uses "\u005c", and no raw LaTeX backslash remains in a JSON string.

Return only the final valid JSON object.
`;

// Legacy Solution Note 1.0 files predate the bounded Proofnote document model.
// They still enter through the modern importer, so put an iterative preflight
// in front of the old recursive validator and verify the migrated document
// before allowing it to reach storage. This code lives in a pre-editor script
// so both the legacy test surface and the document model are already present.
(function hardenLegacySolutionNoteBoundary(root) {
  "use strict";
  const Model = root.ProofnoteDocument;
  const legacy = root.__snTest;
  if (!Model || !legacy || typeof legacy.validateRaw !== "function" || typeof Model.migrateSolutionNote !== "function" || Model.__legacyBoundaryHardened) return;

  const limits = Model.LIMITS || {};
  const MAX_DEPTH = limits.maxDepth || 32;
  const MAX_NODES = 25000;
  const MAX_KEYS = limits.maxObjectKeys || 2000;
  const MAX_ARRAY = 2000;
  const MAX_STRING = limits.maxStringLength || 200000;
  const MAX_TOTAL_TEXT = 20 * 1024 * 1024;
  const MAX_LIST_ITEMS = limits.maxListItems || 1000;
  const MAX_DATA_ITEMS = limits.maxDataItems || 1000;
  const MAX_TABLE_ROWS = limits.maxTableRows || 500;
  const MAX_TABLE_COLUMNS = limits.maxTableColumns || 50;
  const originalValidate = legacy.validateRaw.bind(legacy);
  const originalMigrate = Model.migrateSolutionNote.bind(Model);

  function isObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  function addIssue(target, path, message) {
    if (target.length < 32) target.push({ path: path || "", message });
  }
  function tableCells(line) {
    return String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }
  function checkLegacyBlock(value, path, errors, warnings) {
    if (!isObject(value)) return;
    if (["bullets", "steps"].includes(value.type) && Array.isArray(value.items) && value.items.length > MAX_LIST_ITEMS) {
      addIssue(errors, path + ".items", "Legacy list contains more items than Proofnote can preserve safely.");
    }
    if (["stats", "keyvalue"].includes(value.type) && Array.isArray(value.items) && value.items.length > MAX_DATA_ITEMS) {
      addIssue(errors, path + ".items", "Legacy data block contains more items than Proofnote can preserve safely.");
    }
    if (value.type === "table" && typeof value.text === "string") {
      const lines = value.text.split(/\r?\n/).filter((line) => line.trim());
      const columns = lines.length ? tableCells(lines[0]) : [];
      if (columns.length > MAX_TABLE_COLUMNS) addIssue(errors, path + ".text", "Legacy table contains more columns than Proofnote can preserve safely.");
      const start = lines[1] && /^[\s|:-]+$/.test(lines[1]) ? 2 : 1;
      const rows = lines.slice(start);
      if (rows.length > MAX_TABLE_ROWS) addIssue(errors, path + ".text", "Legacy table contains more rows than Proofnote can preserve safely.");
      rows.slice(0, MAX_TABLE_ROWS).forEach((row) => {
        const count = tableCells(row).length;
        if (columns.length && count > columns.length) addIssue(errors, path + ".text", "Legacy table row contains cells that would be discarded during migration.");
        else if (columns.length && count < columns.length) addIssue(warnings, path + ".text", "Legacy table row is shorter than its header; missing cells will be filled with empty text.");
      });
    }
  }
  function preflight(raw) {
    const errors = [];
    const warnings = [];
    const pending = [{ value: raw, path: "", depth: 0 }];
    const visited = new WeakSet();
    let nodes = 0;
    let totalText = 0;
    while (pending.length && !errors.length) {
      const item = pending.pop();
      const value = item.value;
      if (typeof value === "string") {
        totalText += value.length;
        if (value.length > MAX_STRING) addIssue(errors, item.path, "Text exceeds the maximum supported length.");
        if (totalText > MAX_TOTAL_TEXT) addIssue(errors, "", "Document text exceeds the maximum supported import size.");
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (visited.has(value)) continue;
      visited.add(value);
      nodes += 1;
      if (nodes > MAX_NODES) { addIssue(errors, "", "Document is too complex to import safely."); break; }
      if (item.depth >= MAX_DEPTH) { addIssue(errors, item.path, "Document nesting exceeds the supported limit."); break; }
      if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY) { addIssue(errors, item.path, "Array contains more items than Proofnote can import safely."); break; }
        for (let index = value.length - 1; index >= 0; index -= 1) pending.push({ value: value[index], path: item.path + "[" + index + "]", depth: item.depth + 1 });
        continue;
      }
      const keys = Object.keys(value);
      if (keys.length > MAX_KEYS) { addIssue(errors, item.path, "Object contains too many fields to import safely."); break; }
      checkLegacyBlock(value, item.path, errors, warnings);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        pending.push({ value: value[key], path: item.path ? item.path + "." + key : key, depth: item.depth + 1 });
      }
    }
    return { errors, warnings };
  }
  function mergeIssues(target, source) {
    (source || []).forEach((issue) => {
      const key = String(issue.path || "") + "\u0000" + String(issue.message || "");
      if (!target.some((current) => String(current.path || "") + "\u0000" + String(current.message || "") === key)) target.push(issue);
    });
  }
  function knownSections(raw) {
    const source = isObject(raw && raw.ui) && isObject(raw.ui.sections) ? raw.ui.sections : (isObject(raw && raw.sections) ? raw.sections : null);
    if (!source) return {};
    const sections = {};
    Object.keys(source).slice(0, 64).forEach((key) => {
      if (source[key] === null || typeof source[key] === "boolean") sections[key] = source[key];
    });
    return Object.keys(sections).length ? { sections } : {};
  }

  legacy.validateRaw = function (raw) {
    const guarded = preflight(raw);
    if (guarded.errors.length) return { errors: guarded.errors, warnings: guarded.warnings, fieldCount: 0 };
    let result;
    try { result = originalValidate(raw); }
    catch (_) { return { errors: [{ path: "", message: "Legacy document could not be validated safely." }], warnings: guarded.warnings, fieldCount: 0 }; }
    result = result && typeof result === "object" ? result : { errors: [], warnings: [], fieldCount: 0 };
    result.errors = Array.isArray(result.errors) ? result.errors.slice() : [];
    result.warnings = Array.isArray(result.warnings) ? result.warnings.slice() : [];
    mergeIssues(result.warnings, guarded.warnings);
    if (!result.errors.length && raw && raw.format === "solution-note") {
      try {
        const migrated = originalMigrate(raw);
        const migratedValidation = Model.validateDocumentRaw(migrated);
        mergeIssues(result.errors, migratedValidation.errors);
        mergeIssues(result.warnings, migratedValidation.warnings);
      } catch (_) {
        addIssue(result.errors, "", "Legacy document could not be migrated safely.");
      }
    }
    return result;
  };

  Model.migrateSolutionNote = function (raw) {
    const migrated = originalMigrate(raw);
    if (migrated && migrated.compatibility) migrated.compatibility.sourceUi = knownSections(raw);
    return Model.normalizeDocument(migrated);
  };
  Object.defineProperty(Model, "__legacyBoundaryHardened", { value: true, enumerable: false });
})(window);

// The base 1.0 validator knows every first-class field, but compatibility
// payloads are intentionally extensible. Guard the entire object graph so an
// extension cannot bypass the same depth, key, array, and text limits that the
// canonical fields already observe before safeClone() normalises it.
(function hardenPortableObjectGraph(root) {
  "use strict";
  const Model = root.ProofnoteDocument;
  if (!Model || Model.__portableGraphHardened || typeof Model.validateDocumentRaw !== "function") return;
  const limits = Model.LIMITS || {};
  const MAX_DEPTH = limits.maxDepth || 32;
  const MAX_NODES = 25000;
  const MAX_KEYS = limits.maxObjectKeys || 2000;
  const MAX_ARRAY = limits.maxBlocks || 2000;
  const MAX_STRING = limits.maxStringLength || 200000;
  const MAX_IMAGE = limits.maxImageDataUrlLength || 14 * 1024 * 1024;
  const MAX_TOTAL_TEXT = 20 * 1024 * 1024;
  const originalValidate = Model.validateDocumentRaw.bind(Model);

  function key(issue) { return String(issue.path || "") + "\u0000" + String(issue.message || ""); }
  function add(errors, seen, path, message) {
    const issue = { path: path || "", message };
    const signature = key(issue);
    if (!seen.has(signature)) { seen.add(signature); errors.push(issue); }
  }
  function scan(raw, errors) {
    const seenIssues = new Set(errors.map(key));
    const pending = [{ value: raw, path: "", depth: 0 }];
    const visited = new WeakSet();
    let nodes = 0;
    let totalText = 0;
    while (pending.length) {
      const item = pending.pop();
      const value = item.value;
      if (typeof value === "string") {
        totalText += value.length;
        const isImageData = /\.src$/.test(item.path) && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value);
        const singleLimit = isImageData ? MAX_IMAGE : MAX_STRING;
        if (value.length > singleLimit) add(errors, seenIssues, item.path, isImageData ? "Embedded image exceeds the maximum supported size." : "Text exceeds the maximum supported length.");
        if (totalText > MAX_TOTAL_TEXT + MAX_IMAGE) add(errors, seenIssues, "", "Document text exceeds the maximum supported import size.");
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (visited.has(value)) continue;
      visited.add(value);
      nodes += 1;
      if (nodes > MAX_NODES) { add(errors, seenIssues, "", "Document is too complex to import safely."); break; }
      if (item.depth >= MAX_DEPTH) { add(errors, seenIssues, item.path, "Document nesting exceeds the supported limit."); continue; }
      if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY) add(errors, seenIssues, item.path, "Array contains more items than Proofnote can import safely.");
        const count = Math.min(value.length, MAX_ARRAY);
        for (let index = count - 1; index >= 0; index -= 1) pending.push({ value: value[index], path: item.path + "[" + index + "]", depth: item.depth + 1 });
        continue;
      }
      const keys = Object.keys(value);
      if (keys.length > MAX_KEYS) add(errors, seenIssues, item.path, "Object contains too many fields to import safely.");
      const count = Math.min(keys.length, MAX_KEYS);
      for (let index = count - 1; index >= 0; index -= 1) {
        const field = keys[index];
        pending.push({ value: value[field], path: item.path ? item.path + "." + field : field, depth: item.depth + 1 });
      }
    }
  }

  Model.validateDocumentRaw = function (raw) {
    const result = originalValidate(raw);
    const errors = Array.isArray(result && result.errors) ? result.errors.slice() : [];
    const warnings = Array.isArray(result && result.warnings) ? result.warnings.slice() : [];
    scan(raw, errors);
    return { errors, warnings };
  };
  Object.defineProperty(Model, "__portableGraphHardened", { value: true, enumerable: false });
})(window);
