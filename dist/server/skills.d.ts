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
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import type { OnLog } from "./transcript.js";
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
export declare function defaultSkillsDir(): string;
/** @deprecated Prefer defaultSkillsDir() — value is process-dependent. */
export declare const DEFAULT_SKILLS_DIR: string;
export declare function resolveSkillsRoot(agentConfig: Record<string, unknown> | undefined | null): string;
export declare function loadSkills(params: LoadSkillsParams): Promise<LoadedSkill[]>;
/**
 * Render loaded skills as a single block of text suitable for prepending to
 * the system prompt. Each skill is wrapped in a fenced section so the model
 * can tell where one ends and the next begins.
 */
export declare function renderSkillsForPrompt(skills: LoadedSkill[]): string;
export declare function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot>;
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
export declare function reconcilePaperclipSkills(config: Record<string, unknown>, requestedDesiredSkills?: string[]): Promise<string[]>;
export declare function syncSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot>;
//# sourceMappingURL=skills.d.ts.map