import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { personalProfilePath, savePersonalProfile } from "./env-profiles.mjs";

try {
  const { values } = parseArgs({ options: { from: { type: "string" }, force: { type: "boolean", default: false } } });
  if (!values.from) throw new Error("Provide a source: npm run env:save -- --from /path/to/your/.env");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const defaults = readFileSync(resolve(root, ".env.client.example"), "utf8");
  const destination = savePersonalProfile(resolve(values.from), personalProfilePath(), defaults, values.force);
  console.log(`Personal provider profile saved locally: ${destination}`);
  console.log("Use npm run setup:personal in each new project. Client setup and exports never load this profile.");
} catch (error) {
  console.error("Could not save personal environment:", error.message);
  process.exitCode = 1;
}
