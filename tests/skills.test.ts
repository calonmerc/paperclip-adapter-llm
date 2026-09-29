/**
 * Unit tests for src/server/skills.ts's company-managed skill sync — the
 * real listSkills/syncSkills implementation added to fix a real bug:
 * enabling a skill in Paperclip's UI appeared to do nothing, because the
 * old syncSkills was just an alias for listSkills (which itself hardcoded
 * desiredSkills: [] and only ever scanned a directory, never reading
 * config.paperclipRuntimeSkills at all).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listSkills, syncSkills, reconcilePaperclipSkills } from "../src/server/skills.js";
import { loadSkills } from "../src/server/skills.js";

let skillsDir: string;
let sourceDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-skills-"));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-skill-source-"));
  fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Onboarding\n\nDo the onboarding thing.");
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    skillsDir,
    paperclipRuntimeSkills: [
      { key: "acme/onboarding", runtimeName: "onboarding", source: sourceDir },
    ],
    ...overrides,
  };
}

function makeCtx(config: Record<string, unknown>) {
  return { agentId: "agent-1", companyId: "company-1", adapterType: "llm", config };
}

describe("listSkills", () => {
  it("reports an available company-managed skill as not-yet-desired when paperclipSkillSync is unset", async () => {
    const snapshot = await listSkills(makeCtx(makeConfig()));
    expect(snapshot.adapterType).toBe("llm");
    expect(snapshot.supported).toBe(true);
    const entry = snapshot.entries.find((e) => e.key === "acme/onboarding");
    expect(entry).toBeDefined();
    expect(entry!.desired).toBe(false);
    // managed only flips true once the skill is actually symlinked in —
    // see syncSkills' "symlinks a newly-desired skill" test below.
    expect(entry!.managed).toBe(false);
  });

  it("reports a skill as desired once paperclipSkillSync.desiredSkills includes it", async () => {
    const config = makeConfig({ paperclipSkillSync: { desiredSkills: ["acme/onboarding"] } });
    const snapshot = await listSkills(makeCtx(config));
    expect(snapshot.desiredSkills).toContain("acme/onboarding");
    const entry = snapshot.entries.find((e) => e.key === "acme/onboarding");
    expect(entry!.desired).toBe(true);
  });
});

describe("syncSkills", () => {
  it("symlinks a newly-desired skill into the skills directory", async () => {
    // Mirrors the real caller (Paperclip's /agents/:id/skills/sync route):
    // by the time syncSkills is invoked, adapterConfig.paperclipSkillSync
    // has already been persisted with the new preference, so ctx.config
    // reflects it too, not just the desiredSkills argument.
    const config = makeConfig({ paperclipSkillSync: { desiredSkills: ["acme/onboarding"] } });
    const snapshot = await syncSkills(makeCtx(config), ["acme/onboarding"]);

    const target = path.join(skillsDir, "onboarding");
    const stat = fs.lstatSync(target);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(sourceDir));

    const entry = snapshot.entries.find((e) => e.key === "acme/onboarding");
    expect(entry!.desired).toBe(true);
  });

  it("removes a Paperclip-managed symlink once it's no longer desired", async () => {
    await syncSkills(makeCtx(makeConfig()), ["acme/onboarding"]);
    expect(fs.existsSync(path.join(skillsDir, "onboarding"))).toBe(true);

    await syncSkills(makeCtx(makeConfig()), []);
    expect(fs.existsSync(path.join(skillsDir, "onboarding"))).toBe(false);
  });

  it("does not touch a skill directory the operator manages manually (not a Paperclip-managed symlink)", async () => {
    const manualDir = path.join(skillsDir, "hand-rolled");
    fs.mkdirSync(manualDir);
    fs.writeFileSync(path.join(manualDir, "SKILL.md"), "# Hand-rolled skill");

    await syncSkills(makeCtx(makeConfig()), []);

    expect(fs.existsSync(manualDir)).toBe(true);
  });

  it("loadSkills() actually finds the synced skill's content through the symlink", async () => {
    await syncSkills(makeCtx(makeConfig()), ["acme/onboarding"]);

    const loaded = await loadSkills({
      agentConfig: { skillsDir },
      onLog: async () => {},
    });

    expect(loaded.some((s) => s.name === "onboarding" && s.content.includes("Do the onboarding thing"))).toBe(true);
  });
});

describe("reconcilePaperclipSkills", () => {
  it("always includes a required skill even when not explicitly requested", async () => {
    const config = makeConfig({
      paperclipRuntimeSkills: [
        { key: "acme/onboarding", runtimeName: "onboarding", source: sourceDir },
        { key: "acme/required-thing", runtimeName: "required-thing", source: sourceDir, required: true },
      ],
    });

    const desired = await reconcilePaperclipSkills(config, []);

    expect(desired).toContain("acme/required-thing");
    expect(fs.existsSync(path.join(skillsDir, "required-thing"))).toBe(true);
  });

  it("without an explicit request, falls back to config.paperclipSkillSync's persisted preference", async () => {
    const config = makeConfig({ paperclipSkillSync: { desiredSkills: ["acme/onboarding"] } });

    const desired = await reconcilePaperclipSkills(config);

    expect(desired).toContain("acme/onboarding");
    expect(fs.existsSync(path.join(skillsDir, "onboarding"))).toBe(true);
  });
});
