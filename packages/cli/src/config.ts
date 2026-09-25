/** Key file and hub URL. AGENTBUS_HOME overrides ~/.agentbus (tests and multi-agent hosts). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeKeys, encodeKeys, generate, type Keys } from "@agentbus/sdk";

export const DEFAULT_HUB = "https://agentbus.citecheck.workers.dev";

export function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTBUS_HOME ?? join(homedir(), ".agentbus");
}

export function hubUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTBUS_HUB) return env.AGENTBUS_HUB;
  const p = join(home(env), "config.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { hub?: string };
      if (j.hub) return j.hub;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_HUB;
}

export function saveHub(url: string, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(home(env), { recursive: true, mode: 0o700 });
  writeFileSync(join(home(env), "config.json"), JSON.stringify({ hub: url }, null, 2));
}

/** Load keys, or create and persist a fresh identity. Returns whether it was created. */
export function loadOrCreateKeys(env: NodeJS.ProcessEnv = process.env): { keys: Keys; created: boolean; path: string } {
  const dir = home(env);
  const path = join(dir, "key.json");
  if (existsSync(path)) return { keys: decodeKeys(readFileSync(path, "utf8")), created: false, path };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = generate();
  writeFileSync(path, encodeKeys(keys), { mode: 0o600 });
  return { keys, created: true, path };
}

export function loadKeys(env: NodeJS.ProcessEnv = process.env): Keys | null {
  const path = join(home(env), "key.json");
  return existsSync(path) ? decodeKeys(readFileSync(path, "utf8")) : null;
}

export function cursorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(home(env), "cursor");
}

export function readCursor(env: NodeJS.ProcessEnv = process.env): number {
  const p = cursorPath(env);
  return existsSync(p) ? Number(readFileSync(p, "utf8")) || 0 : 0;
}

export function writeCursor(seq: number, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(home(env), { recursive: true });
  writeFileSync(cursorPath(env), String(seq));
}
