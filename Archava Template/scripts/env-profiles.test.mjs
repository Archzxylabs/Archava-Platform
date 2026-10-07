import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";

const template = fileURLToPath(new URL("../", import.meta.url));
const provider = {
  LIVEKIT_URL: "wss://profile-test.livekit.cloud",
  LIVEKIT_API_KEY: "fake-profile-key",
  LIVEKIT_API_SECRET: "private-canary-livekit-secret",
  GEMINI_API_KEY: "private-canary-gemini-key",
  GEMINI_MODEL: "gemini-2.5-flash-native-audio-preview-12-2025",
  GEMINI_VOICE: "Kore",
  AVATAR_PROVIDER: "spatius",
  SPATIUS_API_KEY: "private-canary-spatius-key",
  SPATIUS_APP_ID: "fake-app-id",
  SPATIUS_AVATAR_ID: "fake-avatar-id",
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "archava-env-profile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "Project Copy");
  cpSync(template, root, { recursive: true, filter(path) {
    const name = basename(path);
    return !["node_modules", "dist", "exports", ".venv", "__pycache__", ".git"].includes(name)
      && !(name.startsWith(".env") && ![".env.example", ".env.client.example"].includes(name))
      && !/\.(pyc|log|tsbuildinfo)$/.test(name);
  } });
  const profile = join(dir, "private-config", ".env.personal");
  const source = join(dir, "original.env");
  writeFileSync(source, Object.entries({ ...provider,
    PROJECT_ID: "old-production", ARCHAVA_AGENT_NAME: "old-agent", WEB_ORIGIN: "https://old.example.com",
    VITE_API_BASE_URL: "https://old-backend.example.com", ENABLE_SESSIONS: "true", TRUST_PROXY: "true", PORT: "9999",
    ONCHAIN_SIGNER_KEY: "private-canary-wallet-secret", VITE_LEAKED_KEY: "private-canary-vite-secret",
  }).map(([key, value]) => `${key}=${value}\n`).join(""));
  function run(script, args = [], status = 0) {
    const result = spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, ARCHAVA_PERSONAL_ENV: profile },
    });
    assert.equal(result.status, status, `${script}: ${result.stdout}\n${result.stderr}`);
    for (const key of ["LIVEKIT_API_SECRET", "GEMINI_API_KEY", "SPATIUS_API_KEY"]) {
      assert.ok(!(result.stdout + result.stderr).includes(provider[key]), "CLI must not echo credentials");
    }
    return result;
  }
  return { dir, root, profile, source, run, env: () => parseEnv(readFileSync(join(root, ".env"), "utf8")) };
}

test("saving a personal profile copies provider access and excludes project, frontend, and onchain settings", (t) => {
  const f = fixture(t);
  f.run("save-personal-env", ["--from", f.source]);
  assert.deepEqual({ ...parseEnv(readFileSync(f.profile, "utf8")) }, provider);
  assert.equal(statSync(f.profile).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.dir, "private-config")).mode & 0o777, 0o700);
});

test("a new personal project loads the shared profile with its own dispatch namespace and disabled sessions", (t) => {
  const f = fixture(t);
  f.run("save-personal-env", ["--from", f.source]);
  f.run("setup", ["--profile", "personal", "--project", "personal-demo", "--brand", "Personal Demo", "--host", "Maya"]);
  const env = f.env();
  for (const [key, value] of Object.entries(provider)) assert.equal(env[key], value);
  assert.equal(env.PROJECT_ID, "personal-demo-dev");
  assert.equal(env.ARCHAVA_AGENT_NAME, "");
  assert.equal(env.ENABLE_SESSIONS, "false");
  assert.equal(env.WEB_ORIGIN, "http://localhost:5174");
  assert.equal(env.VITE_API_BASE_URL, "");
  assert.equal(env.TRUST_PROXY, "false");
  assert.equal(env.ONCHAIN_SIGNER_KEY, undefined);
  assert.equal(env.VITE_LEAKED_KEY, undefined);
  assert.equal(statSync(join(f.root, ".env")).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(join(f.root, "config/project.json"), "utf8"));
  assert.equal(config.brand.name, "Personal Demo");
  for (const value of Object.values(provider)) assert.ok(!JSON.stringify(config).includes(value));
});

test("client setup ignores the shared profile even when that profile is corrupt", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, "private-config"));
  writeFileSync(f.profile, "LIVEKIT_API_SECRET=private-canary-livekit-secret\n");
  f.run("setup", ["--profile", "client", "--project", "client-demo"]);
  const env = f.env();
  for (const key of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "GEMINI_API_KEY", "SPATIUS_API_KEY", "TAVUS_API_KEY", "FACE_ID"]) assert.equal(env[key], "");
  assert.equal(env.PROJECT_ID, "client-demo-dev");
  assert.equal(env.ENABLE_SESSIONS, "false");
});

test("switching profiles refuses to overwrite existing work, then forced client setup clears all personal keys", (t) => {
  const f = fixture(t);
  f.run("setup", ["--profile", "personal", "--env-file", f.source, "--project", "personal-demo"]);
  const beforeEnv = readFileSync(join(f.root, ".env"), "utf8");
  const beforeConfig = readFileSync(join(f.root, "config/project.json"), "utf8");
  f.run("setup", ["--profile", "client", "--project", "client-demo"], 1);
  assert.equal(readFileSync(join(f.root, ".env"), "utf8"), beforeEnv);
  assert.equal(readFileSync(join(f.root, "config/project.json"), "utf8"), beforeConfig);
  f.run("setup", ["--profile", "client", "--force", "--project", "client-demo"]);
  for (const key of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "GEMINI_API_KEY", "SPATIUS_API_KEY"]) assert.equal(f.env()[key], "");
  for (const key of ["LIVEKIT_API_SECRET", "GEMINI_API_KEY", "SPATIUS_API_KEY"]) assert.ok(!readFileSync(join(f.root, ".env"), "utf8").includes(provider[key]));
  assert.equal(f.env().PROJECT_ID, "client-demo-dev");
});

test("plain setup preserves an existing environment while renaming a project", (t) => {
  const f = fixture(t);
  f.run("setup", ["--profile", "personal", "--env-file", f.source]);
  writeFileSync(join(f.root, ".env"), readFileSync(join(f.root, ".env"), "utf8") + "CUSTOM_SETTING=keep-me\n");
  f.run("setup", ["--project", "renamed-demo"]);
  assert.equal(f.env().LIVEKIT_API_SECRET, provider.LIVEKIT_API_SECRET);
  assert.equal(f.env().CUSTOM_SETTING, "keep-me");
  assert.equal(f.env().PROJECT_ID, "renamed-demo-dev");
});

test("a missing personal profile fails before writing environment or project identity", (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.root, "config/project.json"), "utf8");
  const result = f.run("setup", ["--profile", "personal", "--project", "must-not-change"], 1);
  assert.match(result.stderr, /env:save/);
  assert.ok(!existsSync(join(f.root, ".env")));
  assert.equal(readFileSync(join(f.root, "config/project.json"), "utf8"), before);
});

test("client setup cannot import an explicit personal source or accept an unknown profile", (t) => {
  const f = fixture(t);
  f.run("setup", ["--profile", "client", "--env-file", f.source], 1);
  f.run("setup", ["--profile", "unknown"], 1);
  f.run("setup", ["--force"], 1);
  assert.ok(!existsSync(join(f.root, ".env")));
});

test("client setup and export refuse an example that accidentally contains a real provider key", (t) => {
  const f = fixture(t);
  const path = join(f.root, ".env.client.example");
  writeFileSync(path, readFileSync(path, "utf8").replace("GEMINI_API_KEY=", `GEMINI_API_KEY=${provider.GEMINI_API_KEY}`));
  f.run("setup", ["--profile", "client"], 1);
  f.run("export", [], 1);
  assert.ok(!existsSync(join(f.root, ".env")));
  assert.ok(!existsSync(join(f.root, "exports/archava-template.tar.gz")));
});

test("export also rejects credentials accidentally added to the compatibility example", (t) => {
  const f = fixture(t);
  const path = join(f.root, ".env.example");
  writeFileSync(path, readFileSync(path, "utf8").replace("LIVEKIT_API_SECRET=", `LIVEKIT_API_SECRET=${provider.LIVEKIT_API_SECRET}`));
  f.run("export", [], 1);
  assert.ok(!existsSync(join(f.root, "exports/archava-template.tar.gz")));
});

test("saved profile replacement requires force and preserves private permissions", (t) => {
  const f = fixture(t);
  f.run("save-personal-env", ["--from", f.source]);
  const before = readFileSync(f.profile, "utf8");
  writeFileSync(f.source, readFileSync(f.source, "utf8").replace(provider.GEMINI_VOICE, "Puck"));
  f.run("save-personal-env", ["--from", f.source], 1);
  assert.equal(readFileSync(f.profile, "utf8"), before);
  f.run("save-personal-env", ["--from", f.source, "--force"]);
  assert.equal(parseEnv(readFileSync(f.profile, "utf8")).GEMINI_VOICE, "Puck");
  assert.equal(statSync(f.profile).mode & 0o777, 0o600);
});

test("environment writes refuse symlinks and leave the target unchanged", (t) => {
  const f = fixture(t);
  const target = join(f.dir, "untouched.env");
  writeFileSync(target, "UNCHANGED=yes\n");
  symlinkSync(target, join(f.root, ".env"));
  f.run("setup", ["--profile", "client", "--force"], 1);
  assert.equal(readFileSync(target, "utf8"), "UNCHANGED=yes\n");
});

test("export from a personal project excludes active, nested, and shared credentials while retaining blank client setup", (t) => {
  const f = fixture(t);
  const source = { ...parseEnv(readFileSync(f.source, "utf8")) };
  const canaries = ["LIVEKIT_API_SECRET", "GEMINI_API_KEY", "SPATIUS_API_KEY"].map((key) => source[key] = randomUUID());
  writeFileSync(f.source, Object.entries(source).map(([key, value]) => `${key}=${value}\n`).join(""));
  f.run("save-personal-env", ["--from", f.source]);
  f.run("setup", ["--profile", "personal", "--project", "private-export"]);
  writeFileSync(join(f.root, "server/.env.personal"), readFileSync(f.profile, "utf8"));
  writeFileSync(join(f.root, "server/.env.client.example"), readFileSync(f.profile, "utf8"));
  writeFileSync(join(f.root, "backend/.env.example"), readFileSync(f.profile, "utf8"));
  f.run("export");
  const archive = join(f.root, "exports/private-export.tar.gz");
  const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(list.status, 0);
  const names = list.stdout.trim().split("\n");
  assert.ok(names.includes(".env.client.example"));
  assert.ok(names.includes("scripts/env-profiles.mjs"));
  assert.ok(!names.some((name) => basename(name).startsWith(".env") && ![".env.example", ".env.client.example"].includes(name)));
  const contents = spawnSync("tar", ["-xOzf", archive], { maxBuffer: 15_000_000 });
  assert.equal(contents.status, 0);
  for (const value of canaries) assert.ok(!contents.stdout.includes(Buffer.from(value)), "No saved credential may appear anywhere in the client archive");
  const blank = spawnSync("tar", ["-xOzf", archive, ".env.client.example"], { encoding: "utf8" });
  assert.equal(parseEnv(blank.stdout).LIVEKIT_API_SECRET, "");
});
