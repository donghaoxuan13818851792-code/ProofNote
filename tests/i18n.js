// i18n regression tests: load the Generator with the UI language set to "en"
// (via localStorage, which requires an http:// origin in jsdom — file:// origins
// make localStorage throw, and the Generator tolerates that with try/catch).
// Verifies: static UI text replacement, English diagnostics, English schema
// warnings, English dynamic labels, the reverse-showing toggle button, and that
// the import dialog is never clobbered by the html-en innerHTML pass.
// Usage: NODE_PATH=<jsdom parent> node tests/i18n.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const GEN = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(GEN, "utf8");
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || "" });
}

// --- English boot ---
{
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/sn-gen/", beforeParse(w) {
    w.localStorage.setItem("sn-lang", "en");
  }});
  const doc = dom.window.document;
  const t = dom.window.__snTest;

  check("en-boot-t", !!t, "no __snTest");
  check("en-btn-new", doc.getElementById("btnNew").textContent === "New", doc.getElementById("btnNew").textContent);
  check("en-btn-export", doc.getElementById("btnExportHtml").textContent === "Export HTML", doc.getElementById("btnExportHtml").textContent);
  check("en-btn-lang-shows-zh", doc.getElementById("btnLang").textContent === "中文", doc.getElementById("btnLang").textContent);
  check("en-label-status", doc.querySelector('label[data-i18n-en="Status"]').textContent === "Status", doc.querySelector('label[data-i18n-en="Status"]').textContent);
  check("en-option-solved", Array.from(doc.querySelectorAll('select[data-bind="meta.status"] option')).find((o) => o.value === "Solved").textContent === "Solved", "option text");
  check("en-placeholder-title", doc.querySelector('textarea[data-bind="meta.title"]').getAttribute("placeholder").indexOf("conclusion") !== -1, doc.querySelector('textarea[data-bind="meta.title"]').getAttribute("placeholder"));
  check("en-dialog-intact", doc.querySelectorAll(".dialog .dialog-title").length === 1 && doc.getElementById("btnConfirmImport") !== null && doc.getElementById("importPasteText") !== null, "dialog innerHTML clobbered?");
  check("en-dialog-aria", doc.querySelector(".dialog").getAttribute("aria-label") === "Import Solution Note", doc.querySelector(".dialog").getAttribute("aria-label"));
  check("en-html-lang", doc.documentElement.lang === "en", doc.documentElement.lang);

  let d;
  try { JSON.parse('{"a": "\\sqrt{2}"}'); } catch (e) { d = t.diagnoseJsonError('{"a": "\\sqrt{2}"}', e); }
  check("en-diag-latex", d && d.code === "JSON_INVALID_ESCAPE" && d.suggestion.indexOf("LaTeX command") !== -1 && d.suggestion.indexOf("\\u005Csqrt") !== -1, d && d.suggestion);
  try { JSON.parse('{"a": 1,}'); } catch (e) { d = t.diagnoseJsonError('{"a": 1,}', e); }
  check("en-diag-comma", d && d.code === "JSON_TRAILING_COMMA" && d.suggestion.indexOf("trailing comma") !== -1, d && d.suggestion);

  const v = t.validateRaw(JSON.parse('{"format":"solution-note","version":"1.0","meta":{"title":"T","status":"Completed"},"core":{"problem":"","result":{"type":"Proof","statement":"","explanation":""},"whyItWorks":[],"evidence":"","reproduce":{"sourceCode":"","data":"","verificationScript":"","certificate":"","discussion":""}},"optional":{}}'));
  check("en-schema-warning", v.warnings.length === 2 && v.warnings[0].message.indexOf("not an allowed value") !== -1, v.warnings[0] && v.warnings[0].message);

  check("en-opt-title", doc.querySelector(".opt-title").textContent === "Proof", doc.querySelector(".opt-title") && doc.querySelector(".opt-title").textContent);
}

// --- Chinese boot (default) sanity ---
{
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/sn-gen/" });
  const doc = dom.window.document;
  check("zh-btn-new", doc.getElementById("btnNew").textContent === "新建", doc.getElementById("btnNew").textContent);
  check("zh-btn-lang-shows-en", doc.getElementById("btnLang").textContent === "English", doc.getElementById("btnLang").textContent);
  check("zh-opt-title", doc.querySelector(".opt-title").textContent === "证明", doc.querySelector(".opt-title") && doc.querySelector(".opt-title").textContent);
  check("zh-dialog-intact", doc.querySelectorAll(".dialog .dialog-title").length === 1, "dialog");
}

const pass = results.filter((r) => r.pass).length;
results.forEach((r) => {
  console.log((r.pass ? "PASS" : "FAIL") + "  " + r.name);
  if (!r.pass && r.detail) console.log("      " + String(r.detail).slice(0, 200));
});
console.log("\n" + pass + " / " + results.length + " passed");
process.exit(pass === results.length ? 0 : 1);
