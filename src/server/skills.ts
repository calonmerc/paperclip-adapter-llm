/**
 * Skill loading for the LLM adapter.
 *
 * Reads SKILL.md files from a skills directory and returns their contents
 * for injection into the system prompt.
 *
 * Discovery order for the skills root:
 *   1. agentConfig.skillsDir (per-agent override)
 *   2. PAPERCLIP_SKILLS_DIR env var (server-wide override)
 *   3. ~/.paperclip-llm-adapter/skills (default managed root)
 *
 * Scans the root, loads every subdirectory that contains a SKILL.md, injects
 * all of them. This includes company-managed skills symlinked into the root
 * by reconcilePaperclipSkills() (see below) as well as skills the operator
 * drops in manually — both look the same to loadSkills().
 *
 * Failure mode: best-effort. Missing directory or unreadable files log a
 * warning and return what we have. Skill loading never fails the run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import type { OnLog } from "./transcript.js";
import { writeRawStderr } from "./transcript.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface LoadedSkill {
  name: string;
  path: string;
  content: string;
}

export interface LoadSkillsParams {
  agentConfig: Record<string, unknown>;
  onLog: OnLog;
}

/** Default skills root used when neither config.skillsDir nor PAPERCLIP_SKILLS_DIR is set. */
export function defaultSkillsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".paperclip-llm-adapter", "skills");
}

/** @deprecated Prefer defaultSkillsDir() — value is process-dependent. */
export const DEFAULT_SKILLS_DIR = defaultSkillsDir();

export function resolveSkillsRoot(agentConfig: Record<string, unknown> | undefined | null): string {
  const cfg = agentConfig ?? {};
  const fromConfig = typeof cfg.skillsDir === "string" ? cfg.skillsDir.trim() : "";
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.PAPERCLIP_SKILLS_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return defaultSkillsDir();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadSkills(params: LoadSkillsParams): Promise<LoadedSkill[]> {
  const { agentConfig, onLog } = params ?? ({} as LoadSkillsParams);
  const root = resolveSkillsRoot(agentConfig);

  if (!(await pathExists(root))) {
    // Not an error — most agents won't have skills configured.
    return [];
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[llm-adapter] could not read skills root ${root}: ${reason}`);
    return [];
  }

  const loaded: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillName = entry.name;
    const skillMdPath = path.join(root, skillName, "SKILL.md");
    if (!(await pathExists(skillMdPath))) continue;
    try {
      const content = await fs.readFile(skillMdPath, "utf8");
      loaded.push({ name: skillName, path: skillMdPath, content });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[llm-adapter] failed to read skill "${skillName}": ${reason}`);
    }
  }

  return loaded;
}

/**
 * Render loaded skills as a single block of text suitable for prepending to
 * the system prompt. Each skill is wrapped in a fenced section so the model
 * can tell where one ends and the next begins.
 */
export function renderSkillsForPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((s) => `## Skill: ${s.name}\n\n${s.content.trim()}`);
  return [
    "# Available Skills",
    "",
    "The following skills are available to you. Read them carefully and apply them when relevant.",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Company-managed skills: list/sync/reconcile
//
// Paperclip's "Skills" panel lets the board toggle which company-managed
// skills (config.paperclipRuntimeSkills) an agent should have. Those
// choices are persisted by Paperclip itself into adapterConfig regardless
// of what this adapter does — but the panel's immediate feedback and every
// future listing come from calling listSkills/syncSkills below, and the
// actual runtime behavior (whether a chosen skill's content is ever loaded)
// depends on this adapter materializing it into the directory loadSkills()
// reads from. Previously listSkills/syncSkills ignored all of this
// (hardcoded desiredSkills: [], syncSkills was just an alias for
// listSkills), so toggling a skill in the UI appeared to do nothing.
//
// Mirrors the built-in cursor-local adapter's skills.ts (same shape: a
// directory-scanning runtime, no native skills API of its own).
// ─────────────────────────────────────────────────────────────────

async function buildLlmSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveSkillsRoot(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "llm",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: skillsHome,
    missingDetail: "Configured but not currently linked into the skills directory.",
    externalConflictDetail: "Skill name is occupied by a different, non-Paperclip-managed file or directory.",
    externalDetail: "Present in the skills directory but not managed by Paperclip.",
  });
}

export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildLlmSkillSnapshot(ctx.config);
}

/**
 * Symlink every desired company-managed skill into the skills directory
 * loadSkills() reads from, and remove any Paperclip-managed symlink that's
 * no longer desired. Never touches a skill the operator dropped in manually
 * (only unlinks entries whose installed target still matches the available
 * entry's own source path).
 *
 * Called both from syncSkills() (when the board toggles a skill in the UI)
 * and from execute() at the start of every run (so a company skill's
 * desired-state change takes effect even if no one has re-opened the Skills
 * panel since — see the callsite in execute.ts).
 */
export async function reconcilePaperclipSkills(
  config: Record<string, unknown>,
  requestedDesiredSkills?: string[],
): Promise<string[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  // Union with the always-mounted defaults (resolved against an empty config)
  // so the operational `paperclip` skill — the only way this adapter's model
  // learns the Paperclip workflow — can never be dropped by an explicit
  // request that omits it. The legacy resolver is the one adapter-utils
  // prescribes for adapters that aren't the native paperclip_runner.
  const desiredSkills = requestedDesiredSkills
    ? Array.from(new Set([...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries), ...requestedDesiredSkills]))
    : resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveSkillsRoot(config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key)) continue;
    const target = path.join(skillsHome, entry.runtimeName);
    await ensurePaperclipSkillSymlink(entry.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return desiredSkills;
}

export async function syncSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await reconcilePaperclipSkills(ctx.config, desiredSkills);
  return buildLlmSkillSnapshot(ctx.config);
}
