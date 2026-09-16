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
  const SEMANTIC_KINDS = new Set(["section", "introduction", "problem", "theorem", "proof", "result", "verification"]);
  const CALLOUT_KINDS = new Set(["note", "tip", "warning", "info"]);
  const PROOF_METADATA_FIELDS = ["author", "date", "status"];
  // These are deliberately generous authoring limits, not layout limits. They
  // protect the untrusted JSON boundary from accidental or hostile inputs that
  // would otherwise lock up an offline browser tab.
  const LIMITS = Object.freeze({
    maxBlocks: 2000,
    maxStringLength: 200000,
    maxImageDataUrlLength: 14 * 1024 * 1024,
    maxTableColumns: 50,
    maxTableRows: 500,
    maxListItems: 1000,
    maxDataItems: 1000,
    maxDepth: 32,
    maxObjectKeys: 2000
  });
  let idCounter = 0;

  function string(value) { return typeof value === "string" ? value : ""; }
  function now() { return new Date().toISOString(); }
  function id(prefix) {
    idCounter += 1;
    return (prefix || "block") + "_" + Date.now().toString(36) + "_" + idCounter.toString(36);
  }

  function stripUnsafe(value, depth, seen) {
    const level = depth || 0;
    const visited = seen || new WeakSet();
    if (!value || typeof value !== "object") return value;
    // Imported JSON is acyclic, but callers of the public model API are not
    // necessarily JSON. Do not recurse indefinitely for either case.
    if (level >= LIMITS.maxDepth || visited.has(value)) return null;
    visited.add(value);
    if (Array.isArray(value)) return value.slice(0, LIMITS.maxBlocks).map((item) => stripUnsafe(item, level + 1, visited));
    const output = {};
    Object.keys(value).slice(0, LIMITS.maxObjectKeys).forEach((key) => {
      if (!UNSAFE_KEYS.has(key)) output[key] = stripUnsafe(value[key], level + 1, visited);
    });
    return output;
  }

  function safeClone(value) {
    return stripUnsafe(value && typeof value === "object" ? value : {});
  }

  // Proof Note's editorial metadata is a template-level display choice. Keep
  // it separate from the values themselves so an author or date can remain in
  // a portable document even when that row is intentionally not shown.
  function normalizeProofMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.fields)) {
      return { fields: PROOF_METADATA_FIELDS.slice() };
    }
    const requested = new Set(value.fields.filter((field) => PROOF_METADATA_FIELDS.includes(field)));
    return { fields: PROOF_METADATA_FIELDS.filter((field) => requested.has(field)) };
  }

  // Running headers are document metadata rather than content blocks: they
  // repeat on every printed page and are independently editable from the
  // document title. Keeping the two short strings portable lets Project
  // documents retain their reader-facing page furniture on another device.
  function normalizeRunningHeader(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { left: string(source.left), right: string(source.right) };
  }

  // The subtitle is still an editable block. This setting only controls
  // whether the subtitle immediately below a document title is displayed.
  function normalizeHeaderSubtitle(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { visible: source.visible !== false };
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
        // Tables keep their shape even when the author chooses not to render
        // a header row. `header` is intentionally optional in the portable
        // format so older documents continue to mean "header on".
        block.header = raw.header !== false;
        block.columns = Array.isArray(raw.columns) && raw.columns.length
          ? raw.columns.slice(0, LIMITS.maxTableColumns).map(string) : ["Column 1", "Column 2"];
        block.rows = Array.isArray(raw.rows) && raw.rows.length
          ? raw.rows.slice(0, LIMITS.maxTableRows).map((row) => Array.isArray(row) ? block.columns.map((_, index) => string(row[index])) : block.columns.map(() => ""))
          : [block.columns.map(() => "")];
        break;
      case "image":
        block.src = string(raw.src);
        block.alt = string(raw.alt);
        block.caption = string(raw.caption);
        // A remote image is never implicitly trusted by a document payload.
        // The editor grants this flag only after a person clicks Load remote
        // image; imported JSON always resets it before rendering.
        if (raw.remoteApproved === true) block.remoteApproved = true;
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
        // Editorial chapters can hide their inline body without discarding
        // the text that an author may later restore.
        if (raw.bodyVisible === false) block.bodyVisible = false;
        block.title = string(raw.title);
        block.label = string(raw.label);
        block.content = string(raw.content);
        block.summary = string(raw.summary);
        break;
      case "list":
        block.ordered = Boolean(raw.ordered);
        block.items = Array.isArray(raw.items) && raw.items.length ? raw.items.slice(0, LIMITS.maxListItems).map(string) : [""];
        break;
      case "key-value":
        block.items = Array.isArray(raw.items) && raw.items.length
          ? raw.items.slice(0, LIMITS.maxDataItems).map((item) => ({ label: string(item && item.label), value: string(item && item.value) }))
          : [{ label: "", value: "" }];
        break;
      case "stats":
        block.items = Array.isArray(raw.items) && raw.items.length
          ? raw.items.slice(0, LIMITS.maxDataItems).map((item) => ({ kicker: string(item && item.kicker), value: string(item && item.value), body: string(item && item.body) }))
          : [{ kicker: "", value: "", body: "" }];
        break;
    }
    return block;
  }

  function normalizeBlock(raw, options) {
    const safe = raw && typeof raw === "object" && !Array.isArray(raw) ? safeClone(raw) : {};
    if (safe.type === "image" && (!options || options.allowRemoteImages !== true)) safe.remoteApproved = false;
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
        language: string(opts.language),
        noteNumber: string(opts.noteNumber),
        author: string(opts.author),
        date: string(opts.date),
        status: string(opts.status),
        source: string(opts.source),
        proofMetadata: normalizeProofMetadata(opts.proofMetadata),
        runningHeader: normalizeRunningHeader(opts.runningHeader),
        headerSubtitle: normalizeHeaderSubtitle(opts.headerSubtitle),
        createdAt: string(opts.createdAt) || timestamp,
        updatedAt: string(opts.updatedAt) || timestamp
      },
      blocks: Array.isArray(opts.blocks) ? opts.blocks.map((block) => normalizeBlock(block, opts)) : [
        createBlock("title", { content: "Untitled document" }),
        createBlock("paragraph", { content: "Start writing here." })
      ]
    };
  }

  function normalizeDocument(raw, options) {
    const safe = safeClone(raw);
    const document = blankDocument({
      name: safe.metadata && safe.metadata.name,
      templateName: safe.metadata && safe.metadata.templateName,
      documentType: safe.metadata && safe.metadata.documentType,
      language: safe.metadata && safe.metadata.language,
      noteNumber: safe.metadata && safe.metadata.noteNumber,
      author: safe.metadata && safe.metadata.author,
      date: safe.metadata && safe.metadata.date,
      status: safe.metadata && safe.metadata.status,
      source: safe.metadata && safe.metadata.source,
      proofMetadata: safe.metadata && safe.metadata.proofMetadata,
      runningHeader: safe.metadata && safe.metadata.runningHeader,
      headerSubtitle: safe.metadata && safe.metadata.headerSubtitle,
      createdAt: safe.metadata && safe.metadata.createdAt,
      updatedAt: safe.metadata && safe.metadata.updatedAt,
      blocks: Array.isArray(safe.blocks) ? safe.blocks : [],
      allowRemoteImages: options && options.allowRemoteImages === true
    });
    // IDs are used by selection, outline navigation and DOM anchors. Never
    // retain duplicates from imported JSON: generate a fresh stable ID for
    // every collision before the document reaches the UI.
    const seenIds = new Set();
    document.blocks.forEach((block) => {
      while (!block.id || seenIds.has(block.id)) block.id = id("block");
      seenIds.add(block.id);
    });
    document.format = FORMAT;
    document.version = VERSION;
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
    else {
      if (typeof raw.metadata.name !== "string") error("metadata.name", "Expected a document name string.");
      ["templateName", "documentType", "language", "noteNumber", "author", "date", "status", "source", "createdAt", "updatedAt"].forEach((key) => {
        if (raw.metadata[key] !== undefined && typeof raw.metadata[key] !== "string") warn("metadata." + key, "Expected a string; it will be treated as empty text.");
      });
      if (raw.metadata.proofMetadata !== undefined) {
        const proofMetadata = raw.metadata.proofMetadata;
        if (!proofMetadata || typeof proofMetadata !== "object" || Array.isArray(proofMetadata)) warn("metadata.proofMetadata", "Expected metadata display settings; default fields will be shown.");
        else if (!Array.isArray(proofMetadata.fields)) warn("metadata.proofMetadata.fields", "Expected an array of visible metadata fields.");
        else {
          if (proofMetadata.fields.length > PROOF_METADATA_FIELDS.length) warn("metadata.proofMetadata.fields", "Extra metadata fields are ignored.");
          const seenFields = new Set();
          proofMetadata.fields.forEach((field, index) => {
            if (!PROOF_METADATA_FIELDS.includes(field)) warn("metadata.proofMetadata.fields[" + index + "]", "Unknown metadata field is ignored.");
            else if (seenFields.has(field)) warn("metadata.proofMetadata.fields[" + index + "]", "Duplicate metadata field is ignored.");
            else seenFields.add(field);
          });
        }
      }
      if (raw.metadata.runningHeader !== undefined) {
        const runningHeader = raw.metadata.runningHeader;
        if (!runningHeader || typeof runningHeader !== "object" || Array.isArray(runningHeader)) warn("metadata.runningHeader", "Expected running-header settings; empty labels will be used.");
        else ["left", "right"].forEach((key) => {
          if (runningHeader[key] !== undefined && typeof runningHeader[key] !== "string") warn("metadata.runningHeader." + key, "Expected a string; it will be treated as empty text.");
        });
      }
      if (raw.metadata.headerSubtitle !== undefined) {
        const headerSubtitle = raw.metadata.headerSubtitle;
        if (!headerSubtitle || typeof headerSubtitle !== "object" || Array.isArray(headerSubtitle)) warn("metadata.headerSubtitle", "Expected header subtitle display settings; the subtitle will be shown.");
        else if (headerSubtitle.visible !== undefined && typeof headerSubtitle.visible !== "boolean") warn("metadata.headerSubtitle.visible", "Expected a boolean; the subtitle will be shown.");
      }
    }

    // Keep this scan iterative: a deeply nested compatibility payload should
    // produce a useful import error rather than a recursive stack overflow in
    // the later unsafe-key stripping pass.
    const pending = [{ value: raw, depth: 0 }];
    const visited = new WeakSet();
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop();
      const value = item.value;
      if (!value || typeof value !== "object") continue;
      if (visited.has(value)) continue;
      visited.add(value);
      nodes += 1;
      if (nodes > 25000) { error("", "Document is too complex to import safely."); break; }
      if (item.depth > LIMITS.maxDepth) { error("", "Document nesting exceeds the supported limit."); break; }
      const values = Array.isArray(value) ? value : Object.keys(value).map((key) => value[key]);
      values.forEach((child) => { if (child && typeof child === "object") pending.push({ value: child, depth: item.depth + 1 }); });
    }

    let textLength = 0;
    const expectString = (path, value) => {
      if (value === undefined) return;
      if (typeof value !== "string") { warn(path, "Expected a string; it will be treated as empty text."); return; }
      textLength += value.length;
      if (value.length > LIMITS.maxStringLength) error(path, "Text exceeds the maximum supported length.");
    };
    const expectStringArray = (path, value, limit) => {
      if (!Array.isArray(value)) { warn(path, "Expected an array."); return; }
      if (value.length > limit) error(path, "Contains more items than Proofnote can import safely.");
      value.slice(0, limit).forEach((entry, entryIndex) => expectString(path + "[" + entryIndex + "]", entry));
    };
    const expectDataItems = (path, value, fields) => {
      if (!Array.isArray(value)) { warn(path, "Expected an array."); return; }
      if (value.length > LIMITS.maxDataItems) error(path, "Contains more items than Proofnote can import safely.");
      value.slice(0, LIMITS.maxDataItems).forEach((entry, entryIndex) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) { warn(path + "[" + entryIndex + "]", "Expected an object; it will be treated as an empty item."); return; }
        fields.forEach((field) => expectString(path + "[" + entryIndex + "]." + field, entry[field]));
      });
    };

    if (!Array.isArray(raw.blocks)) error("blocks", "Expected a blocks array.");
    else {
      if (raw.blocks.length > LIMITS.maxBlocks) error("blocks", "Contains more blocks than Proofnote can import safely.");
      const ids = new Set();
      raw.blocks.slice(0, LIMITS.maxBlocks).forEach((block, index) => {
      const path = "blocks[" + index + "]";
      if (!block || typeof block !== "object" || Array.isArray(block)) { warn(path, "Ignored a non-object block."); return; }
      if (!BLOCK_TYPES.has(block.type)) warn(path + ".type", "Unknown block type is treated as a paragraph.");
      if (block.id !== undefined) {
        if (typeof block.id !== "string" || !block.id.trim()) warn(path + ".id", "A missing or invalid block ID will be regenerated.");
        else if (ids.has(block.id)) warn(path + ".id", "Duplicate block ID will be regenerated.");
        else ids.add(block.id);
      }
      if (!BLOCK_TYPES.has(block.type)) return;
      if (["title", "subtitle", "paragraph", "equation", "quote"].includes(block.type)) expectString(path + ".content", block.content);
      if (block.type === "heading" && ![1, 2, 3].includes(block.level)) warn(path + ".level", "Heading level is treated as Heading 1.");
      if (block.type === "heading") expectString(path + ".content", block.content);
      if (block.type === "code") { expectString(path + ".language", block.language); expectString(path + ".content", block.content); }
      if (block.type === "table") {
        if (block.header !== undefined && typeof block.header !== "boolean") warn(path + ".header", "Expected a boolean; table headers are shown by default.");
        if (block.columns !== undefined) expectStringArray(path + ".columns", block.columns, LIMITS.maxTableColumns);
        if (block.rows !== undefined) {
          if (!Array.isArray(block.rows)) warn(path + ".rows", "Expected an array.");
          else {
            if (block.rows.length > LIMITS.maxTableRows) error(path + ".rows", "Contains more rows than Proofnote can import safely.");
            const columnCount = Array.isArray(block.columns) ? block.columns.length : null;
            block.rows.slice(0, LIMITS.maxTableRows).forEach((row, rowIndex) => {
              const rowPath = path + ".rows[" + rowIndex + "]";
              if (!Array.isArray(row)) { warn(rowPath, "Expected an array; it will be treated as an empty row."); return; }
              if (row.length > LIMITS.maxTableColumns) {
                error(rowPath, "Contains more cells than Proofnote can import safely.");
              } else if (columnCount !== null && row.length < columnCount) {
                warn(rowPath, "Expected " + columnCount + " cells, found " + row.length + "; missing cells will be filled with empty text.");
              } else if (columnCount !== null && row.length > columnCount) {
                error(rowPath, "Expected " + columnCount + " cells, found " + row.length + "; importing would discard " + (row.length - columnCount) + " cell(s).");
              }
              row.slice(0, LIMITS.maxTableColumns).forEach((cell, cellIndex) => expectString(path + ".rows[" + rowIndex + "][" + cellIndex + "]", cell));
            });
          }
        }
      }
      if (block.type === "image") {
        ["src", "alt", "caption"].forEach((key) => expectString(path + "." + key, block[key]));
        if (typeof block.src === "string" && /^data:image\//i.test(block.src) && block.src.length > LIMITS.maxImageDataUrlLength) error(path + ".src", "Embedded image exceeds the maximum supported size.");
        if (block.remoteApproved !== undefined && typeof block.remoteApproved !== "boolean") warn(path + ".remoteApproved", "Remote-image approval is ignored unless it is a boolean.");
      }
      if (block.type === "quote") expectString(path + ".citation", block.citation);
      if (block.type === "callout") {
        if (!CALLOUT_KINDS.has(block.kind)) warn(path + ".kind", "Unknown callout kind is treated as Note.");
        ["title", "content"].forEach((key) => expectString(path + "." + key, block[key]));
      }
      if (block.type === "semantic") {
        if (!SEMANTIC_KINDS.has(block.kind)) warn(path + ".kind", "Unknown semantic kind is treated as Result.");
        ["title", "label", "content", "summary"].forEach((key) => expectString(path + "." + key, block[key]));
        if (block.appearance !== undefined && !["editorial", "card"].includes(block.appearance)) warn(path + ".appearance", "Unknown appearance is ignored.");
        if (block.bodyVisible !== undefined && typeof block.bodyVisible !== "boolean") warn(path + ".bodyVisible", "Expected a boolean; the body is shown by default.");
      }
      if (block.type === "list") { if (block.ordered !== undefined && typeof block.ordered !== "boolean") warn(path + ".ordered", "Expected a boolean; it will be treated as false."); if (block.items !== undefined) expectStringArray(path + ".items", block.items, LIMITS.maxListItems); }
      if (block.type === "key-value") { if (block.items !== undefined) expectDataItems(path + ".items", block.items, ["label", "value"]); }
      if (block.type === "stats") { if (block.items !== undefined) expectDataItems(path + ".items", block.items, ["kicker", "value", "body"]); }
      });
    }
    if (textLength > 20 * 1024 * 1024) error("", "Document text exceeds the maximum supported import size.");
    return { errors, warnings };
  }

  function validateTemplateRaw(raw) {
    const errors = [], warnings = [];
    const error = (path, message) => errors.push({ path, message });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [{ path: "", message: "A Proofnote template must be a JSON object." }], warnings };
    if (raw.format !== TEMPLATE_FORMAT) error("format", 'Expected "' + TEMPLATE_FORMAT + '".');
    if (raw.version !== VERSION) error("version", 'Expected "' + VERSION + '".');
    if (!raw.template || typeof raw.template !== "object" || Array.isArray(raw.template)) error("template", "Expected template metadata.");
    else {
      if (raw.template.id !== undefined && typeof raw.template.id !== "string") warnings.push({ path: "template.id", message: "Template ID will be regenerated." });
      if (typeof raw.template.name !== "string") error("template.name", "Expected a template name string.");
      if (raw.template.description !== undefined && typeof raw.template.description !== "string") warnings.push({ path: "template.description", message: "Expected a string; it will be treated as empty text." });
    }
    const documentValidation = validateDocumentRaw(raw.document);
    const nestedDocumentIssue = (issue) => Object.assign({}, issue, {
      path: issue && issue.path ? "document." + issue.path : "document"
    });
    return {
      errors: errors.concat(documentValidation.errors.map(nestedDocumentIssue)),
      warnings: warnings.concat(documentValidation.warnings.map(nestedDocumentIssue))
    };
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
  const OPTIONAL_SECTION_BY_HEADING = new Map(OPTIONAL_SECTIONS.map(([key, title]) => [title.toLowerCase(), key]));
  const LEGACY_STATUS_OPTIONS = new Set(["Solved", "Partial", "Computational", "Conjecture", "Counterexample", "Improved Algorithm"]);
  const REPRODUCE_FIELD_BY_LABEL = new Map([
    ["source code", "sourceCode"], ["data", "data"], ["verification script", "verificationScript"],
    ["certificate", "certificate"], ["discussion", "discussion"]
  ]);

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
    const warnings = [];
    const warned = new Set();
    const warnOnce = (message) => { if (!warned.has(message)) { warned.add(message); warnings.push(message); } };
    const requestedStatus = string(sourceMeta.status).trim();
    let legacyStatus = requestedStatus || "Solved";
    if (!LEGACY_STATUS_OPTIONS.has(legacyStatus)) {
      // "Draft" is the natural state for a new Proof Note, but it was never a
      // valid Solution Note 1.0 enum. Map rather than write an invalid file.
      const replacement = "Partial";
      warnOnce('Status "' + legacyStatus + '" was exported as "' + replacement + '" for Solution Note 1.0 compatibility.');
      legacyStatus = replacement;
    }
    const note = {
      format: "solution-note", version: "1.0",
      meta: { noteNumber: string(sourceMeta.noteNumber), title: "", summary: "", author: string(sourceMeta.author), date: string(sourceMeta.date), status: legacyStatus, source: string(sourceMeta.source) },
      core: { problem: "", result: { type: "Theorem", statement: "", explanation: "" }, whyItWorks: [], evidence: [], reproduce: { sourceCode: "", data: "", verificationScript: "", certificate: "", discussion: "" } },
      optional: {}
    };
    if (doc.compatibility && doc.compatibility.sourceUi && typeof doc.compatibility.sourceUi === "object" && Object.keys(doc.compatibility.sourceUi).length) {
      note.ui = safeClone(doc.compatibility.sourceUi);
    }
    let currentHeading = "";
    const appendOptional = (key, block) => {
      if (key === "references" && block.type === "list") {
        note.optional.references = (note.optional.references || []).concat(block.items.map(string).filter((item) => item.trim()));
        return;
      }
      const legacy = documentBlockToLegacy(block);
      if (!legacy) { warnOnce("Some document-only blocks are omitted by Solution Note export."); return; }
      if (!note.optional[key]) note.optional[key] = [];
      note.optional[key].push(legacy);
    };
    const isEmpty = (block) => {
      if (["divider", "page-break"].includes(block.type)) return true;
      if (block.type === "table") return !block.columns.some((value) => string(value).trim()) && !block.rows.some((row) => row.some((value) => string(value).trim()));
      if (["list", "key-value", "stats"].includes(block.type)) return !(block.items || []).some((item) => typeof item === "string" ? item.trim() : Object.values(item || {}).some((value) => string(value).trim()));
      return ![block.content, block.title, block.label, block.summary, block.src, block.caption, block.citation].some((value) => string(value).trim());
    };
    doc.blocks.forEach((block) => {
      if (block.type === "title" && !note.meta.title) note.meta.title = block.content;
      else if (block.type === "subtitle" && !note.meta.summary) note.meta.summary = block.content;
      else if (block.type === "heading") {
        const heading = block.content.trim().toLowerCase();
        if (heading === "why it works") currentHeading = "why-it-works";
        else if (heading === "evidence") currentHeading = "evidence";
        else if (heading === "reproduce") currentHeading = "reproduce";
        else if (OPTIONAL_SECTION_BY_HEADING.has(heading)) currentHeading = "optional:" + OPTIONAL_SECTION_BY_HEADING.get(heading);
        else {
          currentHeading = "";
          if (heading) warnOnce('Heading "' + block.content.trim() + '" is not represented in Solution Note 1.0 and was omitted.');
        }
      }
      else if (block.type === "semantic") {
        if (block.kind === "problem") note.core.problem = block.content;
        else if (["result", "theorem"].includes(block.kind)) { note.core.result = { type: block.label || "Theorem", statement: block.content, explanation: block.summary }; }
        else if (block.kind === "proof" && currentHeading === "why-it-works") note.core.whyItWorks.push({ title: block.title, body: block.content });
        else if (currentHeading === "evidence") note.core.evidence.push({ type: "callout", kicker: block.title || block.label, text: block.content + (block.summary ? "\n\n" + block.summary : "") });
        else if (!isEmpty(block)) warnOnce("Some semantic blocks are not represented by Solution Note export in their current position.");
      } else if (currentHeading === "evidence") {
        const legacy = documentBlockToLegacy(block);
        if (legacy) note.core.evidence.push(legacy);
        else if (!isEmpty(block)) warnOnce("Some document-only blocks are omitted by Solution Note export.");
      } else if (currentHeading === "reproduce") {
        if (block.type === "key-value") {
          block.items.forEach((item) => {
            const field = REPRODUCE_FIELD_BY_LABEL.get(string(item.label).trim().toLowerCase());
            if (field) note.core.reproduce[field] = string(item.value);
            else if (string(item.label).trim() || string(item.value).trim()) warnOnce("Some Reproduce fields are not represented by Solution Note 1.0 and were omitted.");
          });
        } else if (!isEmpty(block)) warnOnce("Some Reproduce content is not represented by Solution Note 1.0 and was omitted.");
      } else if (currentHeading.indexOf("optional:") === 0) {
        appendOptional(currentHeading.slice("optional:".length), block);
      } else if (!isEmpty(block)) {
        warnOnce("Some document content is outside a Solution Note section and was omitted by compatibility export.");
      }
    });
    if (!note.meta.title) note.meta.title = doc.metadata.name;
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
      case "image": case "quote": case "divider": case "page-break": return null;
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
    FORMAT, VERSION, TEMPLATE_FORMAT, LIMITS, BLOCK_TYPES: Array.from(BLOCK_TYPES), SEMANTIC_KINDS: Array.from(SEMANTIC_KINDS),
    CALLOUT_KINDS: Array.from(CALLOUT_KINDS), stripUnsafe, createBlock, normalizeBlock, blankDocument,
    normalizeDocument, validateDocumentRaw, validateTemplateRaw, migrateSolutionNote, documentToSolutionNote, builtInTemplates,
    makeTemplate, normalizeTemplate, markdownTable
  };
  root.ProofnoteDocument = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
