#!/usr/bin/env node
/**
 * One-time bootstrap for a fresh or repaired native ~/.pi checkout.
 *
 * It enforces only the operational package-manager setting and the required Pi
 * package registrations declared in agent/config-manifest.json, then
 * materializes missing required packages through the public `pi install`
 * command. Unrelated machine-local settings and package entries are preserved;
 * credentials, trust decisions, sessions, and caches are never read or copied.
 *
 * This is not a routine settings synchronizer. A checkout that already has the
 * required registrations and artifacts causes no settings write and no `pi`
 * invocation, so rerunning it is safe.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIAGNOSTIC_LIMIT = 4000;

export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    return Object.keys(a).length === Object.keys(b).length
      && Object.keys(a).every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** The source string of a settings package entry, in string or object form. */
export function packageSource(entry) {
  if (typeof entry === "string") return entry;
  return isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
}

function packageName(source) {
  const name = source?.replace(/^npm:/, "");
  if (!name) return undefined;
  return name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("@")[0];
}

/**
 * A registered entry satisfies a required source when it is the same source or
 * a version-pinned equivalent (`npm:pkg` is satisfied by `npm:pkg@1.2.3`).
 * Unrelated sources never match, so equivalent registrations are not duplicated.
 */
function sourceMatches(actual, required) {
  if (actual === required) return true;
  if (!actual || !required) return false;
  return actual.startsWith(`${required}@`);
}

function artifactPresent(agentDir, source) {
  if (typeof source !== "string" || !source.startsWith("npm:")) return true;
  const name = packageName(source);
  if (!name) return false;
  return existsSync(path.join(agentDir, "npm", "node_modules", ...name.split("/"), "package.json"));
}

async function writeSettings(settingsPath, value) {
  const info = existsSync(settingsPath) ? await stat(settingsPath) : { mode: 0o600 };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const temporary = path.join(path.dirname(settingsPath), `.${path.basename(settingsPath)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: info.mode });
    await chmod(temporary, info.mode);
    await rename(temporary, settingsPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Run a Pi CLI command with the selected agent directory as its scope. */
export function runPi(pi, args, agentDir) {
  const result = spawnSync(pi, args, {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
  });
  if (result.error) throw new Error(`${pi} ${args.join(" ")}: ${result.error.message}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    const detail = output.trim().slice(-DIAGNOSTIC_LIMIT);
    throw new Error(`${pi} ${args.join(" ")} exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return { output };
}

export async function bootstrap({
  agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
  pi = process.env.PI_BIN || "pi",
  run = runPi,
} = {}) {
  const manifestPath = path.join(agentDir, "config-manifest.json");
  const settingsPath = path.join(agentDir, "settings.json");

  if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}; run this from the native ~/.pi checkout`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`could not parse ${manifestPath}: ${error.message}`);
  }
  if (!isRecord(manifest)) throw new Error(`${manifestPath} must contain a JSON object`);
  if (manifest.settings !== undefined && !isRecord(manifest.settings)) throw new Error(`${manifestPath}: settings must be a JSON object`);
  if (manifest.packages !== undefined && !Array.isArray(manifest.packages)) throw new Error(`${manifestPath}: packages must be an array`);
  for (const source of manifest.packages ?? []) {
    if (typeof source !== "string" || !source.trim()) throw new Error(`${manifestPath}: package entries must be non-empty strings`);
  }

  let settings;
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch (error) {
      throw new Error(`could not parse ${settingsPath}: ${error.message}`);
    }
  } else {
    settings = {};
  }
  if (!isRecord(settings)) throw new Error(`${settingsPath} must contain a JSON object`);
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error(`${settingsPath}: packages must be an array`);
  for (const entry of settings.packages ?? []) {
    if (packageSource(entry) === undefined) throw new Error(`${settingsPath}: each packages entry must be a string or an object with a string source`);
  }

  // Apply only the manifest's operational settings leaves. Object values merge
  // into existing objects; every unrelated leaf is left untouched.
  const next = structuredClone(settings);
  const settingsChanged = [];
  const apply = (target, source, prefix = []) => {
    for (const [key, value] of Object.entries(source)) {
      const settingPath = [...prefix, key].join(".");
      if (isRecord(value)) {
        if (target[key] !== undefined && !isRecord(target[key])) throw new Error(`${settingsPath}: cannot set ${settingPath}; existing value is not an object`);
        if (!isRecord(target[key])) target[key] = {};
        apply(target[key], value, [...prefix, key]);
      } else if (!jsonEqual(target[key], value)) {
        settingsChanged.push(settingPath);
        target[key] = value;
      }
    }
  };
  apply(next, manifest.settings ?? {});

  if (settingsChanged.length > 0) await writeSettings(settingsPath, next);

  const registrations = (next.packages ?? []).map((entry) => ({ entry, source: packageSource(entry) }));
  const required = (manifest.packages ?? []).map((source) => ({ source, name: packageName(source) }));
  const missing = required.filter(({ source }) => {
    const registered = registrations.some(({ source: actual }) => sourceMatches(actual, source));
    return !registered || !artifactPresent(agentDir, source);
  });

  const installed = [];
  for (const { source } of missing) {
    await run(pi, ["install", source], agentDir);
    installed.push(source);
  }

  return {
    agentDir,
    settingsPath,
    settingsChanged,
    required: required.map(({ source }) => source),
    installed,
    missing: missing.map(({ source }) => source),
  };
}

async function main() {
  const result = await bootstrap();
  if (result.settingsChanged.length > 0) console.log(`Updated ${result.settingsPath}: ${result.settingsChanged.join(", ")}`);
  if (result.installed.length > 0) console.log(`Installed required Pi packages: ${result.installed.join(", ")}`);
  if (result.settingsChanged.length === 0 && result.installed.length === 0) {
    console.log("Pi bootstrap already current.");
    return;
  }
  console.log("Pi bootstrap complete. Restart Pi fully.");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`bootstrap-pi: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
