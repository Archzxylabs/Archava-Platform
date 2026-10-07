import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { checkProject } from "./check-config.mjs";
import { applyEnvValues, assertBlankClientExample, assertWritableEnv, personalProfilePath, readPersonalProfile, writePrivateEnv } from "./env-profiles.mjs";

try {
const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: {
  project: { type: "string" }, brand: { type: "string" }, host: { type: "string" }, language: { type: "string" },
  profile: { type: "string" }, "env-file": { type: "string" }, force: { type: "boolean", default: false },
} });
const profile = values.profile || "client";
if (!["client", "personal"].includes(profile)) throw new Error("Choose --profile client or --profile personal");
if (values["env-file"] && profile !== "personal") throw new Error("--env-file is only supported for the personal profile");
if (values.force && !values.profile) throw new Error("Use --force with an explicit --profile to replace the environment");
const envPath = resolve(root, ".env");
const createdEnv = !existsSync(envPath);
const replaceEnv = Boolean(values.profile) || createdEnv;
let nextEnv;
if (replaceEnv) {
  assertWritableEnv(envPath, values.force);
  const defaults = readFileSync(resolve(root, ".env.client.example"), "utf8");
  assertBlankClientExample(defaults);
  nextEnv = profile === "personal"
    ? applyEnvValues(defaults, readPersonalProfile(values["env-file"] ? resolve(values["env-file"]) : personalProfilePath(), defaults))
    : defaults;
} else {
  assertWritableEnv(envPath, true);
  nextEnv = readFileSync(envPath, "utf8");
}
const configPath = resolve(root, "config/project.json");
const project = JSON.parse(readFileSync(configPath, "utf8"));
const oldBrand = project.brand.name;
const oldHost = project.brand.hostName;
if (values.project) project.projectId = values.project;
if (values.brand) project.brand.name = values.brand;
if (values.host) project.brand.hostName = values.host;
if (values.language) project.brand.defaultLanguage = values.language;
const replacements = { [oldBrand]: project.brand.name, [oldHost]: project.brand.hostName };
const names = Object.keys(replacements).sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const rename = new RegExp(names.join("|"), "g");
for (const fact of Object.values(project.knowledge)) fact.text = fact.text.replace(rename, (name) => replacements[name]);
checkProject(project);
if (replaceEnv || values.project) {
  const updates = { PROJECT_ID: `${project.projectId}-dev`, ARCHAVA_AGENT_NAME: "" };
  nextEnv = applyEnvValues(nextEnv, updates);
}
writePrivateEnv(envPath, nextEnv, !createdEnv);
writeFileSync(configPath, JSON.stringify(project, null, 2) + "\n");
console.log(`Prepared ${project.brand.name} / ${project.brand.hostName}.`);
console.log(replaceEnv ? `Environment: ${profile}; provider credentials ${profile === "personal" ? "loaded from local personal profile" : "empty for client setup"}.` : "Existing environment preserved.");
console.log("Next: review config/project.json and project .env settings, then follow README.md.");
} catch (error) {
  console.error("Setup failed:", error.message);
  process.exitCode = 1;
}
