const fs = require("fs");
const path = require("path");

const root = __dirname;
const cssPath = path.join(root, "katex.min.css");

let css = fs.readFileSync(cssPath, "utf8");
css = css.replace(
  /src:url\((fonts\/[^)]+\.woff2)\) format\("woff2"\),url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
  (_, relativePath) => {
    const font = fs.readFileSync(path.join(root, relativePath));
    return `src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2")`;
  }
);

if (/url\(fonts\//.test(css)) {
  throw new Error("KaTeX CSS still contains external font URLs");
}

const payload = {
  css: Buffer.from(css, "utf8").toString("base64")
};

fs.writeFileSync(
  path.join(root, "embed.js"),
  `window.SOLUTION_NOTE_KATEX_EMBED=${JSON.stringify(payload)};\n`
);
