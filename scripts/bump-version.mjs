// Sets one version for the whole project: extension, MCP server, DXT manifest,
// shared types and lockfiles. AMO only accepts plain numeric versions.
//
// Usage: npm run bump -- 2.0.1
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Give a plain version like 2.0.1 (AMO rejects suffixes such as -beta).");
  process.exit(1);
}

const manifests = [
  "package.json",
  "common/package.json",
  "mcp-server/package.json",
  "mcp-server/manifest.json",
  "firefox-extension/package.json",
  "firefox-extension/manifest.json",
];
const lockfiles = ["package-lock.json", "mcp-server/package-lock.json", "firefox-extension/package-lock.json"];

function update(file, change) {
  const target = path.join(root, file);
  const source = fs.readFileSync(target, "utf8");
  const indent = source.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  const data = JSON.parse(source);
  change(data);
  fs.writeFileSync(target, JSON.stringify(data, null, indent) + (source.endsWith("\n") ? "\n" : ""));
  console.log(`${file}: ${version}`);
}

for (const file of manifests) {
  update(file, (data) => {
    data.version = version;
  });
}
for (const file of lockfiles) {
  update(file, (data) => {
    data.version = version;
    if (data.packages?.[""]) data.packages[""].version = version;
  });
}
