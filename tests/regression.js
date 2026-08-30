// Regression tests for the Proofnote importer/renderer core (index.html).
// Usage: npm test  (or: node tests/regression.js)
// Loads the app's own HTML, executes its scripts in jsdom, and exercises
// the exposed __snTest surface against the historical failure corpus.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const GEN = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(GEN, "utf8");

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "file:///solution-note-generator/"
});
const w = dom.window;
const t = w.__snTest;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || "" });
}

if (!t) {
  console.error("FAIL: __snTest not available — did the Generator IIFE fail?");
  process.exit(1);
}

// ---------- helpers ----------
const diag = (src) => {
  try { JSON.parse(src); return { parsed: true }; }
  catch (e) { return t.diagnoseJsonError(src, e); }
};

// ---------- 1. JSON syntax ----------
let d = diag('{"a": "\\u005C(x\\u005C) and \\u005Csqrt{2}\\u005C"}');
check("valid-math", d.parsed === true, JSON.stringify(d));

d = diag('{"sourceCode": "pattern = r\\"\\\\d+\\""}');
check("valid-code-backslash", d.parsed === true, JSON.stringify(d));

d = diag('{"a": "\\sqrt{2}"}');
check("raw-sqrt", d.code === "JSON_INVALID_ESCAPE" && d.likelyCause === "LATEX_BACKSLASH_NOT_ENCODED", JSON.stringify(d));
check("raw-sqrt-full-command", d.suggestion && d.suggestion.indexOf("\\sqrt") !== -1, d.suggestion);

d = diag('{"a": "\\(x\\)"}');
check("raw-lparen", d.code === "JSON_INVALID_ESCAPE" && d.likelyCause === "LATEX_BACKSLASH_NOT_ENCODED", JSON.stringify(d));

d = diag('{"a":"\\u12XZ"}');
check("invalid-unicode", d.code === "JSON_INVALID_UNICODE_ESCAPE", JSON.stringify(d));

d = diag('{"a": 1 "b": 2}');
check("missing-comma", d.code === "JSON_EXPECTED_COMMA", JSON.stringify(d));

d = diag('{"a": 1,}');
check("trailing-comma", d.code === "JSON_TRAILING_COMMA", JSON.stringify(d));

d = diag("{'a': 1}");
check("single-quote", d.code === "JSON_SINGLE_QUOTE", JSON.stringify(d));

d = diag('{"a": "line1\nline2"}');
check("unescaped-newline", d.code === "JSON_UNESCAPED_NEWLINE", JSON.stringify(d));

d = diag('{"a": "abc}');
check("unterminated-string", d.code === "JSON_UNTERMINATED_STRING", JSON.stringify(d));

d = diag('{"title" "Hello"}');
check("expected-colon", d.code === "JSON_EXPECTED_COLON", JSON.stringify(d));

d = diag('{"a":1} {"b":2}');
check("extra-content", d.code === "JSON_EXTRA_CONTENT", JSON.stringify(d));

// ---------- 2. Schema ----------
const enumNote = '{"format":"solution-note","version":"1.0","meta":{"title":"T","status":"Completed"},"core":{"problem":"","result":{"type":"Proof","statement":"","explanation":""},"whyItWorks":[],"evidence":"","reproduce":{"sourceCode":"","data":"","verificationScript":"","certificate":"","discussion":""}},"optional":{}}';
const ev = t.validateRaw(JSON.parse(enumNote));
check("enum-warnings", ev.errors.length === 0 && ev.warnings.length === 2, JSON.stringify(ev.warnings.map(x => x.path)));
const en = t.normalizeNote(JSON.parse(enumNote));
check("enum-kept", en.meta.status === "Completed" && en.core.result.type === "Proof", en.meta.status + "/" + en.core.result.type);

// ---------- 3. Content / security ----------
const esc = t.inlineMd('<img src=x onerror=alert(1)> \\(x\\)');
check("xss-escaped", esc.indexOf("&lt;img") !== -1 && esc.indexOf("<img") === -1, esc.slice(0, 120));

// Quote escaping in text and attribute context (escapeHtml now escapes " and ').
check("xss-quote-double", t.inlineMd('say "hi"').indexOf("&quot;") !== -1, t.inlineMd('say "hi"'));
check("xss-quote-single", t.inlineMd("it's").indexOf("&#39;") !== -1, t.inlineMd("it's"));

// Markdown links must never emit executable schemes: javascript: collapses to #.
const jsLink = t.inlineMd('[x](javascript:alert(1))');
check("xss-js-href", jsLink.indexOf('href="javascript:') === -1 && jsLink.indexOf('href="#') !== -1, jsLink);
const jsLink2 = t.inlineMd("[x](javascript:document.body.textContent='PWNED')");
check("xss-js-href-quote", jsLink2.indexOf("javascript:") === -1 && jsLink2.indexOf('href="#') !== -1, jsLink2);
const jsLink3 = t.inlineMd('[x](JaVaScRiPt:alert(1))');
check("xss-js-href-case", jsLink3.indexOf("javascript:") === -1, jsLink3);
// Legitimate links still work.
const goodLink = t.inlineMd('[site](https://example.com/?a=1&b=2)');
check("xss-good-href", goodLink.indexOf('href="https://example.com/?a=1&amp;b=2"') !== -1 && goodLink.indexOf("<a") !== -1, goodLink);

const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"meta":{"title":"T","status":"Solved"},"core":{"problem":"","result":{"type":"Theorem","statement":"","explanation":""},"whyItWorks":[],"evidence":"","reproduce":{"sourceCode":"","data":"","verificationScript":"","certificate":"","discussion":""}},"optional":{}}');
t.normalizeNote(evil);
check("no-pollution", ({}).polluted !== true && ({}).polluted2 !== true, "prototype intact");

// ---------- 4. Full note ----------
const full = '{"format":"solution-note","version":"1.0","meta":{"title":"Full","summary":"For \\u005C(x\\u005C)","author":"Jason Dong","date":"2026-08-30","status":"Solved","source":""},"core":{"problem":"Compute \\u005C(F_n\\u005C).","result":{"type":"Theorem","statement":"\\u005C[\\nF_{2k}=F_k(2F_{k+1}-F_k).\\n\\u005C]","explanation":""},"whyItWorks":[],"evidence":"","reproduce":{"sourceCode":"","data":"","verificationScript":"","certificate":"","discussion":""}},"optional":{}}';
const fv = t.validateRaw(JSON.parse(full));
check("valid-full", fv.errors.length === 0 && fv.warnings.length === 0, JSON.stringify(fv.errors));

// ---------- 5. v3.0-rc user stress corpus (tests/fixtures/stress5.js) ----------
const stress = require("./fixtures/stress5.js");

// Case 1: fully valid pure math -> clean import, zero warnings.
d = diag(stress[0].text);
check("stress1-valid-math-json", d.parsed === true, JSON.stringify(d));
const s1 = t.validateRaw(JSON.parse(stress[0].text));
check("stress1-valid-math-schema", s1.errors.length === 0 && s1.warnings.length === 0, JSON.stringify(s1.warnings.map(x => x.path)));

// Case 2: raw \sqrt{2} in summary -> BLOCKED as LaTeX escape, full command named.
d = diag(stress[1].text);
check("stress2-raw-sqrt-blocked", d.code === "JSON_INVALID_ESCAPE" && d.likelyCause === "LATEX_BACKSLASH_NOT_ENCODED", JSON.stringify(d));
check("stress2-raw-sqrt-full-command", d.suggestion && d.suggestion.indexOf("\\sqrt") !== -1, d.suggestion);

// Case 3: code backslash r"\d+" -> clean import; ordinary JSON escaping, no \u005C.
d = diag(stress[2].text);
check("stress3-code-backslash-json", d.parsed === true, JSON.stringify(d));
const p3 = JSON.parse(stress[2].text);
const s3 = t.validateRaw(p3);
check("stress3-code-backslash-schema", s3.errors.length === 0 && s3.warnings.length === 0, JSON.stringify(s3.warnings.map(x => x.path)));
check("stress3-code-backslash-intact", stress[2].text.indexOf("\\u005C") === -1 && p3.core.reproduce.sourceCode.indexOf('re.findall(r"\\d+", text)') !== -1, "no \\u005C in code fields; \\d survived round-trip");

// Case 4: valid JSON, invalid enums -> 2 warnings on the right paths, values kept.
d = diag(stress[3].text);
check("stress4-enum-json", d.parsed === true, JSON.stringify(d));
const s4 = t.validateRaw(JSON.parse(stress[3].text));
check("stress4-enum-two-warnings", s4.errors.length === 0 && s4.warnings.length === 2, JSON.stringify(s4.warnings.map(x => x.path)));
check("stress4-enum-warn-paths", s4.warnings[0].path === "meta.status" && s4.warnings[1].path === "core.result.type", JSON.stringify(s4.warnings.map(x => x.path)));
const n4 = t.normalizeNote(JSON.parse(stress[3].text));
check("stress4-enum-not-modified", n4.meta.status === "Completed" && n4.core.result.type === "Proof", n4.meta.status + "/" + n4.core.result.type);

// Case 5: trailing comma -> BLOCKED as JSON_TRAILING_COMMA, NOT a LaTeX issue.
d = diag(stress[4].text);
check("stress5-trailing-comma", d.code === "JSON_TRAILING_COMMA", JSON.stringify(d));
check("stress5-not-latex", d.likelyCause !== "LATEX_BACKSLASH_NOT_ENCODED", JSON.stringify(d));

// Section visibility: interchange format carries it under ui.sections; legacy
// top-level `sections` is still accepted. Values must be true / false / null.
const secBase = '{"format":"solution-note","version":"1.0","meta":{"title":"T","status":"Solved"},"core":{"problem":"","result":{"type":"Theorem","statement":"","explanation":""},"whyItWorks":[],"evidence":"","reproduce":{"sourceCode":"","data":"","verificationScript":"","certificate":"","discussion":""}},"optional":{}}';
const nsUi = t.normalizeNote(JSON.parse(secBase.slice(0, -1) + ',"ui":{"sections":{"proof":true,"algorithm":false}}}'));
check("sections-ui-mapped", nsUi.sections.proof === true && nsUi.sections.algorithm === false && nsUi.sections.examples === null, JSON.stringify(nsUi.sections));
const nsLegacy = t.normalizeNote(JSON.parse(secBase.slice(0, -1) + ',"sections":{"proof":true}}'));
check("sections-legacy-kept", nsLegacy.sections.proof === true, JSON.stringify(nsLegacy.sections));
const vBad = t.validateRaw(JSON.parse(secBase.slice(0, -1) + ',"ui":{"sections":{"proof":"yes","unknownX":1}}}'));
check("sections-bad-value-warns", vBad.errors.length === 0 && vBad.warnings.length === 2 && vBad.warnings[0].path === "ui.sections.proof" && vBad.warnings[1].path === "ui.sections.unknownX", JSON.stringify(vBad.warnings.map((x) => x.path)));

// ---------- output ----------
const pass = results.filter(r => r.pass).length;
results.forEach(r => {
  console.log((r.pass ? "PASS" : "FAIL") + "  " + r.name);
  if (!r.pass && r.detail) console.log("      " + r.detail.slice(0, 200));
});
console.log("\n" + pass + " / " + results.length + " passed");
process.exit(pass === results.length ? 0 : 1);
