import fs from "fs";
import path from "path";
import { AVAILABLE_TOOLS } from "../extension-config";

// Every text the add-on shows must exist in English and German.
const root = path.join(__dirname, "..");
const messages = (lang: string): Record<string, { message: string }> =>
  JSON.parse(fs.readFileSync(path.join(root, "_locales", lang, "messages.json"), "utf8"));

describe("locales", () => {
  const en = messages("en");
  const de = messages("de");

  it("has the same keys in English and German, none empty", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of [...Object.entries(en), ...Object.entries(de)]) {
      expect(`${key}: ${value.message.trim().length > 0}`).toBe(`${key}: true`);
    }
  });

  it("covers the manifest, the settings page and every tool", () => {
    const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
    const html = fs.readFileSync(path.join(root, "options.html"), "utf8");
    const options = fs.readFileSync(path.join(root, "options.ts"), "utf8");
    const used = [
      ...[...manifest.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]),
      ...[...html.matchAll(/data-i18n="(\w+)"/g)].map((m) => m[1]),
      ...[...options.matchAll(/\bt\("(\w+)"/g)].map((m) => m[1]),
      ...AVAILABLE_TOOLS.flatMap((tool) => {
        const key = `tool_${tool.id.replace(/-/g, "_")}`;
        return [`${key}_name`, `${key}_description`];
      }),
      ...["history", "bookmarks", "find"].map((permission) => `consentFeature_${permission}`),
    ];
    expect(used.filter((key) => !(key in en))).toEqual([]);
  });
});
