// Builds the Claude Desktop extension (DXT) from the compiled server: stage
// manifest, dist and LICENSE with a runtime only package.json, install
// production dependencies, smoke test the staged server, validate and pack.
//
// Usage: npm run pack-dxt [-- <output.dxt>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(serverDir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(serverDir, "manifest.json"), "utf8"));
const output = path.resolve(process.argv[2] ?? path.join(serverDir, `firemcp-${pkg.version}.dxt`));
const mcpb = path.join(serverDir, "node_modules", ".bin", "mcpb");

if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json version ${manifest.version} differs from package.json ${pkg.version}`);
}
if (!fs.existsSync(path.join(serverDir, "dist", "server.js"))) {
  throw new Error("dist/server.js is missing, run npm run build first");
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-dxt-"));
try {
  fs.copyFileSync(path.join(serverDir, "manifest.json"), path.join(stage, "manifest.json"));
  fs.cpSync(path.join(serverDir, "dist"), path.join(stage, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repoDir, "LICENSE"), path.join(stage, "LICENSE"));

  // common is only imported for types; the bundle must not depend on the local link.
  const { "@browser-control-mcp/common": _types, ...dependencies } = pkg.dependencies;
  const { name, version, description, license, main, engines } = pkg;
  fs.writeFileSync(
    path.join(stage, "package.json"),
    JSON.stringify({ name, version, description, license, main, engines, dependencies }, null, 2)
  );
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: stage,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  await smokeTest();

  execFileSync(mcpb, ["validate", path.join(stage, "manifest.json")], { stdio: "inherit" });
  execFileSync(mcpb, ["pack", stage, output], { stdio: "inherit" });
  console.log(`DXT written to ${output}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

// Start the staged server outside the repo, so a missing runtime dependency
// shows up here, and check that the manifest lists exactly the served tools.
async function smokeTest() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(stage, "dist", "server.js")],
    cwd: stage,
    env: { ...process.env, EXTENSION_SECRET: "pack-dxt-smoke-test", EXTENSION_PORT: String(await freePort()) },
    stderr: "pipe",
  });
  const client = new Client({ name: "pack-dxt", version: pkg.version });
  await client.connect(transport);
  try {
    const served = client.getServerVersion()?.version;
    if (served !== pkg.version) {
      throw new Error(`staged server reports version ${served}, expected ${pkg.version}`);
    }
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const listed = manifest.tools.map((tool) => tool.name).sort();
    if (tools.join() !== listed.join()) {
      throw new Error(`manifest.json tools differ from the server.\nserved: ${tools.join(", ")}\nlisted: ${listed.join(", ")}`);
    }
    console.log(`Smoke test passed: version ${served}, ${tools.length} tools`);
  } finally {
    await client.close();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
