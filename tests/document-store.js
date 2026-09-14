// Persistence must never claim success if both IndexedDB and the fallback
// storage reject a write (for example, a full quota with an embedded image).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "document-store.js"), "utf8");
const window = {
  localStorage: {
    getItem() { return null; },
    setItem() { throw new Error("Quota exceeded"); }
  }
};
vm.runInNewContext(source, { window, JSON, Promise, Date, Error });

const results = [];
function check(name, condition) { results.push({ name, pass: Boolean(condition) }); }

async function main() {
  const Store = window.ProofnoteStore;
  check("store-exposes-persistence-api", Boolean(Store));
  check("store-save-current-reports-total-failure", await Store.saveCurrent({ metadata: { name: "Quota" } }) === "failed");
  check("store-save-template-reports-total-failure", await Store.saveTemplate({ template: { id: "quota" }, document: {} }) === "failed");
  check("store-delete-template-reports-total-failure", await Store.deleteTemplate("quota") === "failed");
  const pass = results.filter((result) => result.pass).length;
  results.forEach((result) => console.log((result.pass ? "PASS" : "FAIL") + "  " + result.name));
  console.log("\n" + pass + " / " + results.length + " passed");
  process.exitCode = pass === results.length ? 0 : 1;
}

main();
