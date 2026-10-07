import { mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { project } from "../server/config.mjs";
import { checkProject } from "./check-config.mjs";
import { assertBlankClientExample } from "./env-profiles.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
checkProject();
for (const name of [".env.example", ".env.client.example"]) assertBlankClientExample(readFileSync(resolve(root, name), "utf8"));
const output = resolve(root, "exports");
mkdirSync(output, { recursive: true });
const archive = resolve(output, `${project.projectId}.tar.gz`);
// Allowlist source roots: never traverse .env, dependencies, deployments, or data.
const files = ["README.md", "AGENTS.md", ".env.example", ".env.client.example", ".gitignore", ".dockerignore", ".vercelignore", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html", "Dockerfile", "compose.yaml", "entrypoint.sh", "vercel.json", "config", "prompts", "src", "server", "backend", "scripts", "docs", "public"];
for (const file of files) if (!existsSync(resolve(root, file))) throw new Error(`Missing template file: ${file}`);
const safeFiles = [];
function collect(path) {
  const name = path.split("/").at(-1);
  if ((name.startsWith(".env") && ![".env.example", ".env.client.example"].includes(path)) || ["node_modules", "__pycache__", ".git", ".venv"].includes(name) || /\.(pyc|tsbuildinfo|log|pem|key|p12)$/.test(name)) return;
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const entry = readdirSync(resolve(root, parent), { withFileTypes: true }).find((item) => item.name === name);
  if (entry.isSymbolicLink()) throw new Error(`Do not export symlinks: ${path}`);
  if (entry.isDirectory()) {
    for (const child of readdirSync(resolve(root, path))) collect(`${path}/${child}`);
  } else safeFiles.push(path);
}
for (const file of files) collect(file);
execFileSync("tar", ["-czf", archive, "-C", root, "--", ...safeFiles], { stdio: "inherit" });
console.log(`Exported ${archive}`);
