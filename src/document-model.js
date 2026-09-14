/*
 * Proofnote Document Format 1.0
 *
 * This module deliberately has no DOM dependency. It is the boundary between
 * untrusted interchange JSON and the editor/renderer, and is also used by the
 * legacy Solution Note adapter. Keeping it separate lets the old 1.0 schema
 * remain stable while the editor grows beyond one note shape.
 */
(function (root) {
  "use strict";

  const FORMAT = "proofnote-document";
  const VERSION = "1.0";
  const TEMPLATE_FORMAT = "proofnote-template";
  const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
  const BLOCK_TYPES = new Set([
    "title", "subtitle", "heading", "paragraph", "equation", "code",
    "table", "image", "quote", "divider", "page-break", "callout",
    "semantic", "list", "key-value", "stats"
  ]);
  const SEMANTIC_KINDS = new Set(["problem", "theorem", "proof", "result", "verification"]);
  const CALLOUT_KINDS = new Set(["note", "tip", "warning", "info"]);
  let idCounter = 0;

  function string(value) { return typeof value === "string" ? value : ""; }
  function now() { return new Date().toISOString(); }
  function id(prefix) {
    idCounter += 1;
    return (prefix || "block") + "_" + Date.now().toString(36) + "_" + idCounter.toString(36);
  }

  function stripUnsafe(value) {
    if (Array.isArray(value)) return value.map(stripUnsafe);
    if (!value || typeof value !== "object") return value;
    const output = {};
    Object.keys(value).forEach((key) => {
      if (!UNSAFE_KEYS.has(key)) output[key] = stripUnsafe(value[key]);
    });
    return output;
  }

  function safeClone(value) {
    return stripUnsafe(value && typeof value === "object" ? value : {});
  }

  function defaultPreset(type, raw) {
    if (type === "heading") return "heading-" + (raw && [1, 2, 3].includes(raw.level) ? raw.level : 1);
    if (type === "title") return "document-title";
    if (type === "subtitle") return "document-subtitle";
    if (type === "semantic") return "semantic-" + (raw && SEMANTIC_KINDS.has(raw.kind) ? raw.kind : "result");
    if (type === "callout") return "callout-" + (raw && CALLOUT_KINDS.has(raw.kind) ? raw.kind : "note");
    return type;
  }

  function createBlock(type, values) {
    const raw = Object.assign({ type: type || "paragraph" }, values || {});
    const normalizedType = BLOCK_TYPES.has(raw.type) ? raw.type : "paragraph";
    const block = { id: string(raw.id) || id("block"), type: normalizedType, preset: defaultPreset(normalizedType, raw) };
    switch (normalizedType) {
      case "title": case "subtitle": case "paragraph": case "equation":
        block.content = string(raw.content);
        break;
      case "heading":
        block.level = [1, 2, 3].includes(raw.level) ? raw.level : 1;
        block.preset = "heading-" + block.level;
        block.content = string(raw.content);
        break;
      case "code":
        block.language = string(raw.language);
        block.content = string(raw.content);
        break;
      case "table":
        block.columns = Array.isArray(raw.columns) && raw.columns.length
          ? raw.columns.map(string) : ["Column 1", "Column 2"];
        block.rows = Array.isArray(raw.rows) && raw.rows.length
          ? raw.rows.map((row) => Array.isArray(row) ? row.map(string) : block.columns.map(() => ""))
          : [block.columns.map(() => "")];
        break;
      case "image":
        block.src = string(raw.src);
        block.alt = string(raw.alt);
        block.caption = string(raw.caption);
        break;
      case "quote":
        block.content = string(raw.content);
        block.citation = string(raw.citation);
        break;
      case "divider": case "page-break":
        break;
      case "callout":
        block.kind = CALLOUT_KINDS.has(raw.kind) ? raw.kind : "note";
        block.preset = "callout-" + block.kind;
        block.title = string(raw.title);
        block.content = string(raw.content);
        break;
      case "semantic":
        block.kind = SEMANTIC_KINDS.has(raw.kind) ? raw.kind : "result";
        block.preset = "semantic-" + block.kind;
        // Semantic meaning and visual treatment are deliberately separate.
        // Leave appearance unset when a template should supply its default;
        // an explicit card/editorial choice is portable with the document.
        if (raw.appearance === "card" || raw.appearance === "editorial") block.appearance = raw.appearance;
        block.title = string(raw.title);
        block.label = string(raw.label);
        block.content = string(raw.content);
        block.summary = string(raw.summary);
        break;
      case "list":
        block.ordered = Boolean(raw.ordered);
        block.items = Array.isArray(raw.items) && raw.items.length ? raw.items.map(string) : [""];
        break;
      case "key-value":
        block.items = Array.isArray(raw.items) && raw.items.length
          ? raw.items.map((item) => ({ label: string(item && item.label), value: string(item && item.value) }))
          : [{ label: "", value: "" }];
        break;
      case "stats":
        block.items = Array.isArray(raw.items) && raw.items.length
          ? raw.items.map((item) => ({ kicker: string(item && item.kicker), value: string(item && item.value), body: string(item && item.body) }))
          : [{ kicker: "", value: "", body: "" }];
        break;
    }
    return block;
  }

  function normalizeBlock(raw) {
    const safe = raw && typeof raw === "object" && !Array.isArray(raw) ? safeClone(raw) : {};
    return createBlock(safe.type, safe);
  }

  function blankDocument(options) {
    const opts = options || {};
    const timestamp = now();
    return {
      format: FORMAT,
      version: VERSION,
      metadata: {
        name: string(opts.name) || "Untitled document",
        templateName: string(opts.templateName),
        documentType: string(opts.documentType),
        noteNumber: string(opts.noteNumber),
        author: string(opts.author),
        date: string(opts.date),
        status: string(opts.status),
        source: string(opts.source),
        createdAt: string(opts.createdAt) || timestamp,
        updatedAt: string(opts.updatedAt) || timestamp
      },
      blocks: Array.isArray(opts.blocks) ? opts.blocks.map(normalizeBlock) : [
        createBlock("title", { content: "Untitled document" }),
        createBlock("paragraph", { content: "Start writing here." })
      ]
    };
  }

  function normalizeDocument(raw) {
    const safe = safeClone(raw);
    const document = blankDocument({
      name: safe.metadata && safe.metadata.name,
      templateName: safe.metadata && safe.metadata.templateName,
      documentType: safe.metadata && safe.metadata.documentType,
      noteNumber: safe.metadata && safe.metadata.noteNumber,
      author: safe.metadata && safe.metadata.author,
      date: safe.metadata && safe.metadata.date,
      status: safe.metadata && safe.metadata.status,
      source: safe.metadata && safe.metadata.source,
      createdAt: safe.metadata && safe.metadata.createdAt,
      updatedAt: safe.metadata && safe.metadata.updatedAt,
      blocks: Array.isArray(safe.blocks) ? safe.blocks : []
    });
    document.format = FORMAT;
    document.version = VERSION;
    document.metadata.updatedAt = now();
    if (safe.compatibility && typeof safe.compatibility === "object") document.compatibility = safeClone(safe.compatibility);
    return document;
  }

  function validateDocumentRaw(raw) {
    const errors = [], warnings = [];
    const error = (path, message) => errors.push({ path, message });
    const warn = (path, message) => warnings.push({ path, message });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      error("", "A Proofnote document must be a JSON object.");
      return { errors, warnings };
    }
    if (raw.format !== FORMAT) error("format", 'Expected "' + FORMAT + '".');
    if (raw.version !== VERSION) error("version", 'Expected "' + VERSION + '".');
    if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) error("metadata", "Expected a metadata object.");
    else if (typeof raw.metadata.name !== "string") error("metadata.name", "Expected a document name string.");
    if (!Array.isArray(raw.blocks)) error("blocks", "Expected a blocks array.");
    else raw.blocks.forEach((block, index) => {
      const path = "blocks[" + index + "]";
      if (!block || typeof block !== "object" || Array.isArray(block)) { warn(path, "Ignored a non-object block."); return; }
      if (!BLOCK_TYPES.has(block.type)) warn(path + ".type", "Unknown block type is treated as a paragraph.");
      if (block.type === "heading" && ![1, 2, 3].includes(block.level)) warn(path + ".level", "Heading level is treated as Heading 1.");
      if (block.type === "semantic" && !SEMANTIC_KINDS.has(block.kind)) warn(path + ".kind", "Unknown semantic kind is treated as Result.");
      if (block.type === "image" && block.src !== undefined && typeof block.src !== "string") warn(path + ".src", "Image source must be a string.");
    });
    return { errors, warnings };
  }

  function legacyTextBlocks(value) {
    if (typeof value === "string") return value.trim() ? [createBlock("paragraph", { content: value })] : [];
    if (!Array.isArray(value)) return [];
    return value.map((legacy) => {
      const raw = legacy && typeof legacy === "object" ? legacy : {};
      switch (raw.type) {
        case "code": return createBlock("code", { content: string(raw.text) });
        case "math": return createBlock("equation", { content: string(raw.text) });
        case "table": return tableFromMarkdown(string(raw.text));
        case "bullets": return createBlock("list", { items: raw.items, ordered: false });
        case "steps": return createBlock("list", { items: raw.items, ordered: true });
        case "stats": return createBlock("stats", { items: raw.items });
        case "keyvalue": return createBlock("key-value", { items: raw.items });
        case "callout": return createBlock("callout", { kind: "note", title: string(raw.kicker), content: string(raw.text) });
        default: return createBlock("paragraph", { content: string(raw.text) });
      }
    });
  }

  function tableFromMarkdown(text) {
    const lines = string(text).split(/\r?\n/).filter((line) => line.trim());
    const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    const columns = lines[0] ? cells(lines[0]) : ["Column 1", "Column 2"];
    const start = lines[1] && /^[\s|:-]+$/.test(lines[1]) ? 2 : 1;
    return createBlock("table", { columns, rows: lines.slice(start).map(cells) });
  }

  const OPTIONAL_SECTIONS = [
    ["proof", "Proof"], ["algorithm", "Algorithm"], ["computationalResults", "Computational Results"],
    ["performance", "Performance"], ["examples", "Examples"], ["verificationDetails", "Verification Details"],
    ["limitations", "Limitations"], ["openQuestions", "Open Questions"], ["notes", "Notes"],
    ["references", "References"], ["acknowledgements", "Acknowledgements"]
  ];

  function migrateSolutionNote(raw) {
    const note = safeClone(raw);
    const meta = note.meta && typeof note.meta === "object" ? note.meta : {};
    const core = note.core && typeof note.core === "object" ? note.core : {};
    const result = core.result && typeof core.result === "object" ? core.result : {};
    const blocks = [
      createBlock("title", { content: string(meta.title) }),
      createBlock("subtitle", { content: string(meta.summary) }),
      createBlock("semantic", { kind: "problem", appearance: "editorial", title: "Problem", content: string(core.problem) }),
      createBlock("semantic", { kind: "result", appearance: "editorial", title: "Result", label: string(result.type) || "Theorem", content: string(result.statement), summary: string(result.explanation) }),
      createBlock("heading", { level: 1, content: "Why It Works" })
    ];
    (Array.isArray(core.whyItWorks) ? core.whyItWorks : []).forEach((step) => {
      if (typeof step === "string") blocks.push(createBlock("semantic", { kind: "proof", appearance: "editorial", content: step }));
      else blocks.push(createBlock("semantic", { kind: "proof", appearance: "editorial", title: string(step && step.title), content: string(step && step.body) }));
    });
    blocks.push(createBlock("heading", { level: 1, content: "Evidence" }));
    blocks.push.apply(blocks, legacyTextBlocks(core.evidence));
    const reproduce = core.reproduce && typeof core.reproduce === "object" ? core.reproduce : {};
    const reproductionRows = [
      ["Source code", reproduce.sourceCode], ["Data", reproduce.data], ["Verification script", reproduce.verificationScript],
      ["Certificate", reproduce.certificate], ["Discussion", reproduce.discussion]
    ].filter((row) => string(row[1]).trim()).map((row) => ({ label: row[0], value: string(row[1]) }));
    blocks.push(createBlock("heading", { level: 1, content: "Reproduce" }));
    if (reproductionRows.length) blocks.push(createBlock("key-value", { items: reproductionRows }));
    const optional = note.optional && typeof note.optional === "object" ? note.optional : {};
    OPTIONAL_SECTIONS.forEach(([key, title]) => {
      const value = optional[key];
      const hasValue = Array.isArray(value) ? value.length : string(value).trim().length;
      if (!hasValue) return;
      blocks.push(createBlock("heading", { level: 1, content: title }));
      if (key === "references") blocks.push(createBlock("list", { ordered: true, items: Array.isArray(value) ? value : [value] }));
      else blocks.push.apply(blocks, legacyTextBlocks(value));
    });
    const document = blankDocument({
      name: string(meta.title) || "Imported Solution Note",
      templateName: "Proof Note",
      documentType: "Solution Note",
      noteNumber: string(meta.noteNumber),
      author: string(meta.author),
      date: string(meta.date),
      status: string(meta.status),
      source: string(meta.source),
      blocks: blocks.filter((block) => !(block.type === "subtitle" && !block.content))
    });
    document.compatibility = {
      sourceFormat: "solution-note",
      sourceVersion: string(note.version) || "1.0",
      sourceMeta: {
        noteNumber: string(meta.noteNumber), author: string(meta.author), date: string(meta.date),
        status: string(meta.status), source: string(meta.source)
      },
      // Section force-show/hide is old-editor display state rather than
      // document content. Retain it here so an explicit legacy export does
      // not silently discard it during a round trip.
      sourceUi: safeClone(note.ui && typeof note.ui === "object" ? note.ui : (note.sections ? { sections: note.sections } : {}))
    };
    return document;
  }

  function documentToSolutionNote(raw) {
    const doc = normalizeDocument(raw);
    const retainedMeta = doc.compatibility && doc.compatibility.sourceMeta ? doc.compatibility.sourceMeta : {};
    // A migrated note starts with copies of these values in document metadata.
    // Prefer those live fields on later legacy exports so edits made in the new
    // canvas are not silently overwritten by the import-time compatibility copy.
    const sourceMeta = {
      noteNumber: string(doc.metadata.noteNumber) || string(retainedMeta.noteNumber),
      author: string(doc.metadata.author) || string(retainedMeta.author),
      date: string(doc.metadata.date) || string(retainedMeta.date),
      status: string(doc.metadata.status) || string(retainedMeta.status),
      source: string(doc.metadata.source) || string(retainedMeta.source)
    };
    const note = {
      format: "solution-note", version: "1.0",
      meta: { noteNumber: string(sourceMeta.noteNumber), title: "", summary: "", author: string(sourceMeta.author), date: string(sourceMeta.date), status: string(sourceMeta.status) || "Solved", source: string(sourceMeta.source) },
      core: { problem: "", result: { type: "Theorem", statement: "", explanation: "" }, whyItWorks: [], evidence: [], reproduce: { sourceCode: "", data: "", verificationScript: "", certificate: "", discussion: "" } },
      optional: {}
    };
    if (doc.compatibility && doc.compatibility.sourceUi && typeof doc.compatibility.sourceUi === "object" && Object.keys(doc.compatibility.sourceUi).length) {
      note.ui = safeClone(doc.compatibility.sourceUi);
    }
    const warnings = [];
    let currentHeading = "";
    doc.blocks.forEach((block) => {
      if (block.type === "title" && !note.meta.title) note.meta.title = block.content;
      else if (block.type === "subtitle" && !note.meta.summary) note.meta.summary = block.content;
      else if (block.type === "heading") currentHeading = block.content.trim().toLowerCase();
      else if (block.type === "semantic") {
        if (block.kind === "problem") note.core.problem = block.content;
        else if (block.kind === "result") { note.core.result = { type: block.label || "Theorem", statement: block.content, explanation: block.summary }; }
        else if (block.kind === "proof") note.core.whyItWorks.push({ title: block.title, body: block.content });
      } else if (currentHeading === "evidence") {
        note.core.evidence.push(documentBlockToLegacy(block));
      }
    });
    if (!note.meta.title) note.meta.title = doc.metadata.name;
    if (doc.blocks.some((block) => !["title", "subtitle", "heading", "semantic", "paragraph", "equation", "code", "table", "list", "callout", "key-value", "stats"].includes(block.type))) {
      warnings.push("Some document-only blocks are omitted by Solution Note export.");
    }
    return { note, warnings };
  }

  function documentBlockToLegacy(block) {
    switch (block.type) {
      case "equation": return { type: "math", text: block.content };
      case "code": return { type: "code", text: block.content };
      case "table": return { type: "table", text: markdownTable(block) };
      case "list": return { type: block.ordered ? "steps" : "bullets", items: block.items.slice() };
      case "callout": return { type: "callout", kicker: block.title, text: block.content };
      case "key-value": return { type: "keyvalue", items: block.items.map((item) => ({ label: item.label, value: item.value })) };
      case "stats": return { type: "stats", items: block.items.map((item) => ({ kicker: item.kicker, value: item.value, body: item.body })) };
      default: return { type: "paragraph", text: string(block.content) };
    }
  }

  function markdownTable(block) {
    const header = "| " + block.columns.join(" | ") + " |";
    const divider = "| " + block.columns.map(() => "---").join(" | ") + " |";
    const rows = block.rows.map((row) => "| " + block.columns.map((_, index) => string(row[index])).join(" | ") + " |");
    return [header, divider].concat(rows).join("\n");
  }

  function builtInTemplates() {
    // The header is a template choice, not a global product watermark. A
    // blank document starts with no running header; named templates may opt in.
    const make = (idValue, name, description, blocks, options) => ({
      format: TEMPLATE_FORMAT, version: VERSION,
      template: { id: idValue, name, description, builtIn: true },
      document: blankDocument(Object.assign({ name: name, templateName: options && options.showHeader === false ? "" : name, blocks }, options && options.metadata ? options.metadata : {}))
    });
    return [
      make("blank-document", "Blank Document", "A calm starting point for any structured document.", [
        createBlock("title", { content: "Untitled document" }), createBlock("paragraph", { content: "Start writing here." })
      ], { showHeader: false }),
      make("proof-note", "Proof Note", "The original Proofnote structure, now made from reusable blocks.", [
        createBlock("title", { content: "Untitled proof note" }), createBlock("subtitle", { content: "A concise statement of the result." }),
        createBlock("semantic", { kind: "problem", appearance: "editorial", title: "Problem", content: "State the problem so a reader never needs the original thread." }),
        createBlock("semantic", { kind: "result", appearance: "editorial", title: "Result", label: "Theorem", content: "State the claim." }),
        createBlock("heading", { level: 1, content: "Why It Works" }), createBlock("semantic", { kind: "proof", appearance: "editorial", title: "Key step", content: "Explain the mechanism." }),
        createBlock("heading", { level: 1, content: "Evidence" }), createBlock("semantic", { kind: "verification", appearance: "editorial", title: "What was checked", content: "Record the evidence and its limits." }),
        createBlock("heading", { level: 1, content: "Reproduce" }), createBlock("key-value", { items: [{ label: "Source code", value: "" }, { label: "Data", value: "" }] })
      ], { metadata: { documentType: "Solution Note", status: "Draft" } }),
      make("research-note", "Research Note", "A compact path from abstract to result, evidence, and references.", [
        createBlock("title", { content: "Research note" }), createBlock("subtitle", { content: "A focused record of an idea or investigation." }),
        createBlock("heading", { level: 1, content: "Abstract" }), createBlock("paragraph", { content: "Summarize the question, approach, and finding." }),
        createBlock("heading", { level: 1, content: "Main result" }), createBlock("semantic", { kind: "result", title: "Result", label: "Finding", content: "" }),
        createBlock("heading", { level: 1, content: "Evidence" }), createBlock("paragraph", { content: "" }),
        createBlock("heading", { level: 1, content: "References" }), createBlock("list", { ordered: true, items: [""] })
      ]),
      make("lab-report", "Lab Report", "A repeatable record of an experiment and its observations.", [
        createBlock("title", { content: "Lab report" }), createBlock("heading", { level: 1, content: "Question" }), createBlock("paragraph", { content: "" }),
        createBlock("heading", { level: 1, content: "Method" }), createBlock("list", { ordered: true, items: [""] }),
        createBlock("heading", { level: 1, content: "Results" }), createBlock("table", { columns: ["Measure", "Result"], rows: [["", ""]] }),
        createBlock("heading", { level: 1, content: "Discussion" }), createBlock("paragraph", { content: "" })
      ]),
      make("essay-report", "Essay / Report", "A clear, restrained long-form writing template.", [
        createBlock("title", { content: "Untitled report" }), createBlock("subtitle", { content: "" }),
        createBlock("heading", { level: 1, content: "Introduction" }), createBlock("paragraph", { content: "" }),
        createBlock("heading", { level: 1, content: "Discussion" }), createBlock("paragraph", { content: "" }),
        createBlock("heading", { level: 1, content: "Conclusion" }), createBlock("paragraph", { content: "" })
      ])
    ];
  }

  function makeTemplate(rawDocument, template) {
    const info = template || {};
    const document = normalizeDocument(rawDocument);
    document.metadata.templateName = string(info.name) || document.metadata.templateName || "Custom template";
    return {
      format: TEMPLATE_FORMAT,
      version: VERSION,
      template: { id: string(info.id) || id("template"), name: string(info.name) || "Custom template", description: string(info.description), builtIn: false },
      document
    };
  }

  function normalizeTemplate(raw) {
    const safe = safeClone(raw);
    return makeTemplate(safe.document, safe.template);
  }

  const api = {
    FORMAT, VERSION, TEMPLATE_FORMAT, BLOCK_TYPES: Array.from(BLOCK_TYPES), SEMANTIC_KINDS: Array.from(SEMANTIC_KINDS),
    CALLOUT_KINDS: Array.from(CALLOUT_KINDS), stripUnsafe, createBlock, normalizeBlock, blankDocument,
    normalizeDocument, validateDocumentRaw, migrateSolutionNote, documentToSolutionNote, builtInTemplates,
    makeTemplate, normalizeTemplate, markdownTable
  };
  root.ProofnoteDocument = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
