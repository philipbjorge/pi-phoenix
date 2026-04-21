import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import type { PhoenixConfig } from "./types.js";

const DEFAULT_ENDPOINT = "http://localhost:6006";
const DEFAULT_MAX_ATTR_BYTES = 16384;

function asBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function asInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function findGitRootName(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return root ? basename(root) : undefined;
  } catch {
    return undefined;
  }
}

function resolveProjectName(env: NodeJS.ProcessEnv): string {
  const explicit = env.PI_PHOENIX_PROJECT?.trim();
  if (explicit) return explicit;

  const gitRootName = findGitRootName(process.cwd());
  if (gitRootName) return gitRootName;

  return basename(process.cwd());
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): PhoenixConfig {
  return {
    enabled: asBool(env.PI_PHOENIX_ENABLE, true),
    projectName: resolveProjectName(env),
    endpoint: env.PHOENIX_COLLECTOR_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
    apiKey: env.PHOENIX_API_KEY?.trim() || undefined,
    batch: asBool(env.PI_PHOENIX_BATCH, false),
    maxAttrBytes: asInt(env.PI_PHOENIX_MAX_ATTR_BYTES, DEFAULT_MAX_ATTR_BYTES),
  };
}
