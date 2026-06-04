import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("dist", "client");
const htmlPath = path.join(distDir, "index.html");

const html = await readFile(htmlPath, "utf8");
let nextHtml = html;

nextHtml = await inlineStylesheet(nextHtml);
nextHtml = await inlineModuleScript(nextHtml);

await writeFile(htmlPath, nextHtml, "utf8");

async function inlineStylesheet(source) {
  const linkPattern = /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/;
  const match = source.match(linkPattern);
  if (!match) return source;

  const cssPath = path.join(distDir, match[1]);
  const css = await readFile(cssPath, "utf8");
  const safeCss = css.replaceAll(/<\/style/gi, () => String.raw`<\/style`);
  return source.replace(match[0], () => `<style data-inline-entry>${safeCss}</style>`);
}

async function inlineModuleScript(source) {
  const scriptPattern = /<script type="module" crossorigin src="(\/assets\/index-[^"]+\.js)"><\/script>/;
  const match = source.match(scriptPattern);
  if (!match) return source;

  const jsPath = path.join(distDir, match[1]);
  const js = await readFile(jsPath, "utf8");
  const safeJs = js.replaceAll(/<\/script/gi, () => String.raw`<\/script`);
  return source.replace(match[0], () => `<script type="module" data-inline-entry>${safeJs}</script>`);
}
