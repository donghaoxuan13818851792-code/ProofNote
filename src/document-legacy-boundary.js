/* Strict boundary for retired Solution Note 1.0 imports.
 *
 * The legacy editor remains an optional compatibility source, but its parser
 * cannot define the modern editor's safety contract. This required module
 * preflights untrusted legacy payloads, delegates only the historical shape
 * check, then validates the migrated Proofnote document before storage.
 */
(function (root) {
  "use strict";
  const Model = root.ProofnoteDocument;
  const legacy = root.__snTest;
  if (!Model || !legacy || typeof legacy.validateRaw !== "function" || typeof Model.migrateSolutionNote !== "function") return;

  const limits = Model.LIMITS || {};
  const MAX_DEPTH = limits.maxDepth || 32;
  const MAX_NODES = 25000;
  const MAX_KEYS = limits.maxObjectKeys || 2000;
  const MAX_ARRAY = limits.maxBlocks || 2000;
  const MAX_STRING = limits.maxStringLength || 200000;
  const MAX_TOTAL_TEXT = 20 * 1024 * 1024;
  const MAX_LIST_ITEMS = limits.maxListItems || 1000;
  const MAX_DATA_ITEMS = limits.maxDataItems || 1000;
  const MAX_TABLE_ROWS = limits.maxTableRows || 500;
  const MAX_TABLE_COLUMNS = limits.maxTableColumns || 50;
  const originalValidate = legacy.validateRaw.bind(legacy);

  function isObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  function addIssue(target, path, message) { if (target.length < (limits.maxDiagnosticIssues || 32)) target.push({ path: path || "", message }); }
  function mergeIssues(target, source) {
    (source || []).forEach((issue) => {
      const key = String(issue.path || "") + "\u0000" + String(issue.message || "");
      if (!target.some((current) => String(current.path || "") + "\u0000" + String(current.message || "") === key)) target.push(issue);
    });
  }
  function tableCells(line) {
    const source = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let cell = "", escaped = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        cell += character === "n" ? "\n" : (character === "|" || character === "\\" ? character : "\\" + character);
        escaped = false;
      } else if (character === "\\") escaped = true;
      else if (character === "|") { cells.push(cell.trim()); cell = ""; }
      else cell += character;
    }
    if (escaped) cell += "\\";
    cells.push(cell.trim());
    return cells;
  }
  function checkLegacyBlock(value, path, errors, warnings) {
    if (!isObject(value)) return;
    if (["bullets", "steps"].includes(value.type) && Array.isArray(value.items) && value.items.length > MAX_LIST_ITEMS) addIssue(errors, path + ".items", "Legacy list contains more items than Proofnote can preserve safely.");
    if (["stats", "keyvalue"].includes(value.type) && Array.isArray(value.items) && value.items.length > MAX_DATA_ITEMS) addIssue(errors, path + ".items", "Legacy data block contains more items than Proofnote can preserve safely.");
    if (value.type !== "table" || typeof value.text !== "string") return;
    const lines = value.text.split(/\r?\n/).filter((line) => line.trim());
    const columns = lines.length ? tableCells(lines[0]) : [];
    if (columns.length > MAX_TABLE_COLUMNS) addIssue(errors, path + ".text", "Legacy table contains more columns than Proofnote can preserve safely.");
    const rows = lines.slice(lines[1] && /^[\s|:-]+$/.test(lines[1]) ? 2 : 1);
    if (rows.length > MAX_TABLE_ROWS) addIssue(errors, path + ".text", "Legacy table contains more rows than Proofnote can preserve safely.");
    rows.slice(0, MAX_TABLE_ROWS).forEach((row) => {
      const count = tableCells(row).length;
      if (columns.length && count > columns.length) addIssue(errors, path + ".text", "Legacy table row contains cells that would be discarded during migration.");
      else if (columns.length && count < columns.length) addIssue(warnings, path + ".text", "Legacy table row is shorter than its header; missing cells will be filled with empty text.");
    });
  }
  function preflight(raw) {
    const errors = [], warnings = [], pending = [{ value: raw, path: "", depth: 0 }], visited = new WeakSet();
    let nodes = 0, totalText = 0;
    while (pending.length && !errors.length) {
      const item = pending.pop(), value = item.value;
      if (typeof value === "string") {
        totalText += value.length;
        if (value.length > MAX_STRING) addIssue(errors, item.path, "Text exceeds the maximum supported length.");
        if (totalText > MAX_TOTAL_TEXT) addIssue(errors, "", "Document text exceeds the maximum supported import size.");
        continue;
      }
      if (!value || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      if (++nodes > MAX_NODES) { addIssue(errors, "", "Document is too complex to import safely."); break; }
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
  function validateSolutionNote(raw) {
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
        const migratedValidation = Model.validateDocumentRaw(Model.migrateSolutionNote(raw));
        mergeIssues(result.errors, migratedValidation.errors);
        mergeIssues(result.warnings, migratedValidation.warnings);
      } catch (_) { addIssue(result.errors, "", "Legacy document could not be migrated safely."); }
    }
    return result;
  }
  root.ProofnoteLegacyBoundary = Object.freeze({ validateSolutionNote });
})(window);
