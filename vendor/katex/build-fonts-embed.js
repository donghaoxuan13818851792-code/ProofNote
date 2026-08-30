// Builds fonts-embed.js: the vendored Cormorant Garamond + Lora woff2 files
// (in ../fonts, restored from Google Fonts latin + latin-ext subsets) as
// data URIs inside the @font-face rules, so the standalone HTML export renders
// identically offline (no Google Fonts dependency).
//
// Reproducible from a fresh clone: `node vendor/katex/build-fonts-embed.js`
const fs = require("fs");
const path = require("path");

const fontDir = path.join(__dirname, "..", "fonts");
const outDir = __dirname;

let css = fs.readFileSync(path.join(fontDir, "fonts.css"), "utf8");
css = css.replace(/url\('\.\/([^']+\.woff2)'\)/g, (_, name) => {
  const font = fs.readFileSync(path.join(fontDir, name));
  return `url(data:font/woff2;base64,${font.toString("base64")})`;
});

if (/url\('\.\//.test(css)) {
  throw new Error("fonts.css still contains external font URLs");
}

const payload = { css: Buffer.from(css, "utf8").toString("base64") };
fs.writeFileSync(
  path.join(outDir, "fonts-embed.js"),
  `window.SOLUTION_NOTE_FONTS_EMBED=${JSON.stringify(payload)};\n`
);
console.log("fonts-embed.js written:", Math.round(payload.css.length / 1024), "KB");
