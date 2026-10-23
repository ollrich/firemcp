// Collects exactly the files the add-on ships into build/, the source for the
// XPI, `web-ext lint` and `web-ext sign`. Run after `npm run build:js`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(extensionDir, "build");
const shipped = ["manifest.json", "_locales", "options.html", "assets", "icons", "dist/background.js", "dist/options.js"];

fs.rmSync(buildDir, { recursive: true, force: true });
for (const entry of shipped) {
  const source = path.join(extensionDir, entry);
  if (!fs.existsSync(source)) {
    throw new Error(`${entry} is missing, run npm run build:js first`);
  }
  fs.cpSync(source, path.join(buildDir, entry), { recursive: true });
}
// MIT: the license travels with every copy of the add-on.
fs.copyFileSync(path.join(extensionDir, "..", "LICENSE"), path.join(buildDir, "LICENSE"));
console.log(`Staged ${shipped.length + 1} entries in ${buildDir}`);
