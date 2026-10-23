// Adds a signed XPI to updates.json, the update manifest Firefox polls through
// browser_specific_settings.gecko.update_url, and puts a copy named as the
// release asset into firefox-extension/web-ext-artifacts/release/.
//
// Usage: npm run release:updates -- firefox-extension/web-ext-artifacts/<signed>.xpi
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const signedXpi = process.argv[2];
if (!signedXpi || !fs.existsSync(signedXpi)) {
  console.error("Give the path of the signed .xpi from npm run sign.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "firefox-extension", "manifest.json"), "utf8"));
const { id } = manifest.browser_specific_settings.gecko;
const { version } = manifest;
// A signed file of another version would point updates.json at the wrong build.
const signed = JSON.parse(execFileSync("unzip", ["-p", signedXpi, "manifest.json"], { encoding: "utf8" }));
if (signed.version !== version || signed.browser_specific_settings?.gecko?.id !== id) {
  console.error(`${signedXpi} is ${signed.browser_specific_settings?.gecko?.id} ${signed.version}, the repo is at ${id} ${version}.`);
  process.exit(1);
}
const assetName = `firemcp-${version}.xpi`;
const releaseDir = path.join(root, "firefox-extension", "web-ext-artifacts", "release");
fs.mkdirSync(releaseDir, { recursive: true });
fs.copyFileSync(signedXpi, path.join(releaseDir, assetName));

const hash = crypto.createHash("sha256").update(fs.readFileSync(signedXpi)).digest("hex");
const updatesFile = path.join(root, "updates.json");
const updates = JSON.parse(fs.readFileSync(updatesFile, "utf8"));
const entries = updates.addons[id].updates.filter((entry) => entry.version !== version);
entries.push({
  version,
  update_link: `https://github.com/ollrich/firemcp/releases/download/v${version}/${assetName}`,
  update_hash: `sha256:${hash}`,
});
entries.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
updates.addons[id].updates = entries;
fs.writeFileSync(updatesFile, JSON.stringify(updates, null, 2) + "\n");

console.log(`updates.json: ${version} -> sha256:${hash.slice(0, 12)}…`);
console.log(`Release asset: firefox-extension/web-ext-artifacts/release/${assetName}`);
console.log(`Upload it to the GitHub release v${version}, then commit and push updates.json.`);
