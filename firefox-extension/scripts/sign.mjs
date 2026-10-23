// Signs the staged add-on as unlisted (self distributed) on addons.mozilla.org.
// Credentials come from WEB_EXT_API_KEY and WEB_EXT_API_SECRET (AMO Developer
// Hub, "Manage API Keys"); web-ext reads them itself, they never touch a file.
// The background script is bundled, so the readable source goes along.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.join(extensionDir, "..");
const artifactsDir = path.join(extensionDir, "web-ext-artifacts");
const { version } = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error("Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (AMO Developer Hub, Manage API Keys) first.");
  process.exit(1);
}
// The source archive is taken from the last commit, so it must match the build.
if (execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }).trim()) {
  console.error("Uncommitted changes: commit first, so the uploaded source matches the signed build.");
  process.exit(1);
}

fs.mkdirSync(artifactsDir, { recursive: true });
const sourceArchive = path.join(artifactsDir, `firemcp-${version}-source.zip`);
execFileSync("git", ["archive", "--format=zip", "-o", sourceArchive, "HEAD"], { cwd: repoDir, stdio: "inherit" });

execFileSync(
  path.join(extensionDir, "node_modules", ".bin", "web-ext"),
  [
    "sign",
    "--channel=unlisted",
    "--source-dir", path.join(extensionDir, "build"),
    "--artifacts-dir", artifactsDir,
    "--upload-source-code", sourceArchive,
  ],
  { stdio: "inherit" }
);
console.log(`\nSigned ${version}. Next, in the repo root: npm run release:updates -- <path of the signed .xpi>`);
