import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { configured, runtimeConfig } from "../server/config.mjs";

// Reuse provider access only; deployment, admission, and chain settings stay per project.
export const PERSONAL_KEYS = Object.freeze([
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
  "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_VOICE", "AVATAR_PROVIDER",
  "SPATIUS_API_KEY", "SPATIUS_APP_ID", "SPATIUS_AVATAR_ID", "SPATIUS_REGION",
  "TAVUS_API_KEY", "FACE_ID", "PAL_ID",
]);

export function personalProfilePath(env = process.env) {
  return resolve(env.ARCHAVA_PERSONAL_ENV || resolve(env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "archava-template", ".env.personal"));
}

export function reusableValues(content) {
  const parsed = parseEnv(content);
  return Object.fromEntries(PERSONAL_KEYS.filter((key) => parsed[key]?.trim()).map((key) => [key, parsed[key]]));
}

export function assertBlankClientExample(content) {
  const values = parseEnv(content);
  const credentials = ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "GEMINI_API_KEY", "SPATIUS_API_KEY", "SPATIUS_APP_ID", "SPATIUS_AVATAR_ID", "TAVUS_API_KEY", "FACE_ID", "PAL_ID"];
  for (const key of credentials) {
    if (values[key]?.trim()) throw new Error(`Client environment examples must leave ${key} empty. Keep credentials in a private profile or ignored .env.`);
  }
  if (configured(values.LIVEKIT_URL)) throw new Error("Client environment examples must use a placeholder LIVEKIT_URL.");
}

function quoteValue(value, key) {
  if (/[\0\r\n\\]/.test(value)) throw new Error(`${key} must be a single-line value without backslashes`);
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error(`${key} cannot contain both quote types`);
}

export function applyEnvValues(content, values) {
  let result = content;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("Invalid environment variable name");
    const line = `${key}=${quoteValue(String(value), key)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    result = pattern.test(result) ? result.replace(pattern, () => line) : `${result.trimEnd()}\n${line}\n`;
  }
  return result;
}

export function readPersonalProfile(path, defaults) {
  assertBlankClientExample(defaults);
  if (!existsSync(path)) throw new Error("Personal profile not found. Run npm run env:save -- --from /path/to/your/.env first, or set ARCHAVA_PERSONAL_ENV.");
  const values = reusableValues(readFileSync(path, "utf8"));
  const config = runtimeConfig({ ...parseEnv(defaults), ...values });
  if (!config.providerConfigured) throw new Error("Personal profile needs LiveKit, Gemini, and credentials for its selected avatar provider.");
  return values;
}

export function assertWritableEnv(path, overwrite = false) {
  if (!existsSync(path)) {
    // A dangling symlink must not become a credential write outside the chosen path.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Environment destination must not be a symlink"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return;
  }
  if (!lstatSync(path).isFile()) throw new Error("Environment destination must be a regular file");
  if (!overwrite) throw new Error("Environment file already exists. Use --force to replace it; its current credentials and deployment settings will be reset.");
}

export function writePrivateEnv(path, content, overwrite = false) {
  assertWritableEnv(path, overwrite);
  writeFileSync(path, content, { flag: overwrite ? "w" : "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function savePersonalProfile(source, destination, defaults, overwrite = false) {
  const values = readPersonalProfile(source, defaults);
  assertWritableEnv(destination, overwrite);
  const content = "# Local personal provider profile. Never commit, build into an image, or send to clients.\n"
    + applyEnvValues("", values);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writePrivateEnv(destination, content, overwrite);
  return destination;
}
