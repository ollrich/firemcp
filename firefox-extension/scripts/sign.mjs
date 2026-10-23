// Signs the staged add-on as unlisted (self distributed) on addons.mozilla.org.
// Credentials (AMO Developer Hub, "Manage API Keys") come from WEB_EXT_API_KEY
// and WEB_EXT_API_SECRET, or else from the macOS Keychain items
// firemcp-amo-api-key and firemcp-amo-api-secret. They reach web-ext through its
// environment only, never a file or the command line.
// The background script is bundled, so the readable source goes along.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.join(extensionDir, "..");
const artifactsDir = path.join(extensionDir, "web-ext-artifacts");
const { version } = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

function fromKeychain(service) {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const apiKey = process.env.WEB_EXT_API_KEY || fromKeychain("firemcp-amo-api-key");
const apiSecret = process.env.WEB_EXT_API_SECRET || fromKeychain("firemcp-amo-api-secret");
if (!apiKey || !apiSecret) {
  console.error(
    "No AMO API credentials (AMO Developer Hub, Manage API Keys). Either set WEB_EXT_API_KEY and\n" +
      "WEB_EXT_API_SECRET, or store them once in the macOS Keychain:\n" +
      '  security add-generic-password -U -a "$USER" -s firemcp-amo-api-key -w\n' +
      '  security add-generic-password -U -a "$USER" -s firemcp-amo-api-secret -w'
  );
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
  { stdio: "inherit", env: { ...process.env, WEB_EXT_API_KEY: apiKey, WEB_EXT_API_SECRET: apiSecret } }
);
console.log(`\nSigned ${version}. Next, in the repo root: npm run release:updates -- <path of the signed .xpi>`);
