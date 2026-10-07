import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { project, runtimeConfig } from "../server/config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function checkProject(value = project) {
  // Leave room for environment suffixes such as -dev / -prod in runtime IDs.
  assert.match(value.projectId, /^[a-z0-9][a-z0-9-]{2,42}$/);
  for (const key of ["name", "hostName", "defaultLanguage", "tagline", "heroBody", "businessDescription"]) {
    assert.equal(typeof value.brand[key], "string", `brand.${key} must be text`);
    assert.ok(value.brand[key].trim(), `brand.${key} cannot be empty`);
  }
  assert.ok(value.brand.hostName.length <= 32, "Use a hostName of at most 32 characters");
  if (value.brand.contactUrl) {
    const contact = new URL(value.brand.contactUrl);
    assert.ok(["https:", "mailto:"].includes(contact.protocol), "contactUrl must be HTTPS or mailto");
  }
  // These IDs are the DOM contract used by the four landing components.
  assert.deepEqual(value.sections.map((item) => item.id), ["top", "catalog-section", "protocol-section", "business-section"]);
  for (const section of value.sections) {
    assert.ok(section.label?.trim() && section.description?.trim(), "Each section needs a label and approved description");
  }
  assert.ok(Object.keys(value.knowledge).length > 0, "Add at least one approved knowledge topic");
  for (const [topic, fact] of Object.entries(value.knowledge)) {
    assert.match(topic, /^[a-z][a-z0-9_]{0,31}$/);
    assert.ok(["verified", "planned", "unavailable"].includes(fact.status), `Invalid status for ${topic}`);
    assert.ok(typeof fact.text === "string" && fact.text.trim(), `Missing facts for ${topic}`);
  }
  for (const [name, path] of Object.entries(value.assets)) {
    assert.match(path, /^\/assets\/[a-zA-Z0-9_.-]+$/, `Invalid local asset path: ${name}`);
    assert.ok(existsSync(resolve(root, "public", "." + path)), `Asset does not exist: ${path}`);
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkProject();
    if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
    const base = process.env.VITE_API_BASE_URL || "";
    if (base) {
      const url = new URL(base);
      assert.ok(["http:", "https:"].includes(url.protocol) && url.origin === base, "VITE_API_BASE_URL must be an HTTP(S) origin without trailing slash or /api");
      if (process.env.VERCEL) assert.equal(url.protocol, "https:", "Vercel requires an HTTPS backend");
    }
    if (process.env.VERCEL) assert.ok(base, "Set VITE_API_BASE_URL to your backend HTTPS origin in Vercel before building");
    if (process.argv.includes("--env")) {
      const config = runtimeConfig();
      assert.ok(config.providerConfigured, "Fill LiveKit, Gemini, and the selected provider credentials in .env first");
      console.log(`Runtime configuration valid: ${config.projectId}, agent ${config.agentName}, ${config.avatarProvider}`);
      console.log("Credentials are present. Worker registration and a real call still require a live check.");
    } else console.log("Project configuration valid.");
  } catch (error) {
    console.error("Configuration check failed:", error.message);
    process.exitCode = 1;
  }
}
