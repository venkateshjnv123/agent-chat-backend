import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SkillError,
  defaultSkillsRoot,
  discoverSkills,
  getSkill,
  listSkillMetadata,
  readSkillAsset,
  type Skill,
} from "@/skills/registry";

const runSkill = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

vi.mock("@/db/client", () => ({ prisma: { runSkill } }));

const {
  loadSkill,
  readSkillAssetTool,
  restoredSkillsPrompt,
  runLocalTool,
  skillsPromptSection,
} = await import("@/skills/tools");

function frontmatter(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing carefully.\n`;
}

const DESCRIPTION = "Guidance for doing one representative kind of work well.";

/** Builds a throwaway skills root so each case gets its own tree. */
function root(build: (dir: string) => void): {
  dir: string;
  skills: Map<string, Skill>;
} {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));

  build(dir);

  return { dir, skills: discoverSkills(dir) };
}

function skill(
  dir: string,
  name: string,
  source = frontmatter(name, DESCRIPTION),
) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), source);
}

beforeEach(() => {
  runSkill.findUnique.mockReset().mockResolvedValue(null);
  runSkill.findMany.mockReset().mockResolvedValue([]);
  runSkill.create.mockReset().mockResolvedValue({});
  runSkill.update.mockReset().mockResolvedValue({});
});

describe("selective loading", () => {
  it("puts only names and descriptions in the prompt, never bodies", () => {
    const { skills } = root((dir) => {
      skill(dir, "alpha-skill");
      skill(dir, "beta-skill");
    });

    const section = skillsPromptSection(skills);

    expect(section).toContain("alpha-skill");
    expect(section).toContain(DESCRIPTION);
    expect(section).not.toContain("Do the thing carefully");
    expect(listSkillMetadata(skills)).toHaveLength(2);
  });

  it("returns a body only when load_skill is called for it", async () => {
    const { skills } = root((dir) => {
      skill(dir, "alpha-skill");
      skill(dir, "beta-skill");
    });

    const outcome = await runLocalTool(
      loadSkill,
      { name: "alpha-skill" },
      { runId: "run_1", registry: skills },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome).toMatchObject({
      output: {
        name: "alpha-skill",
        instructions: "Do the thing carefully.",
        alreadyLoaded: false,
      },
    });
    // Loading one skill must not pull in the other.
    expect(runSkill.create).toHaveBeenCalledTimes(1);
    expect(runSkill.create.mock.calls[0][0].data.name).toBe("alpha-skill");
  });
});

describe("malformed frontmatter", () => {
  it("rejects a missing block, a bad field, and a name/directory mismatch", () => {
    expect(() =>
      root((dir) => skill(dir, "no-front", "Just a body, no frontmatter.\n")),
    ).toThrow(/missing frontmatter/);

    expect(() =>
      root((dir) =>
        skill(dir, "short-desc", frontmatter("short-desc", "too short")),
      ),
    ).toThrow(/description/);

    expect(() =>
      root((dir) =>
        skill(dir, "Bad_Name", frontmatter("Bad_Name", DESCRIPTION)),
      ),
    ).toThrow(/kebab-case/);

    expect(() =>
      root((dir) =>
        skill(dir, "mismatch", frontmatter("other-name", DESCRIPTION)),
      ),
    ).toThrow(/does not match its directory/);
  });

  it("fails discovery loudly rather than skipping the bad skill", () => {
    expect(() =>
      root((dir) => {
        skill(dir, "good-skill");
        skill(dir, "bad-skill", "---\nname bad-skill\n---\nbody\n");
      }),
    ).toThrow(/malformed frontmatter line/);
  });
});

describe("duplicate skills", () => {
  it("refuses two directories claiming the same name", () => {
    // The name/directory rule makes an in-tree duplicate impossible, so the
    // duplicate arrives the only way it can: two roots merged into one map.
    const { skills } = root((dir) => skill(dir, "alpha-skill"));

    expect(() => {
      const merged = new Map(skills);
      const second = discoverSkills(
        root((dir) => skill(dir, "alpha-skill")).dir,
      );

      for (const [name, entry] of second) {
        if (merged.has(name)) throw new Error(`duplicate skill name: ${name}`);
        merged.set(name, entry);
      }
    }).toThrow(/duplicate skill name/);
  });
});

describe("unknown skills", () => {
  it("names the skills that do exist so the model can correct itself", async () => {
    const { skills } = root((dir) => skill(dir, "alpha-skill"));

    const outcome = await runLocalTool(
      loadSkill,
      { name: "nope" },
      { runId: "run_1", registry: skills },
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: "skill_not_found",
    });
    expect(outcome.ok === false && outcome.userMessage).toContain(
      "alpha-skill",
    );
    expect(runSkill.create).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments before touching the registry", async () => {
    const { skills } = root((dir) => skill(dir, "alpha-skill"));

    const outcome = await runLocalTool(
      loadSkill,
      { name: 42 },
      { runId: "run_1", registry: skills },
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: "invalid_tool_input",
    });
  });
});

describe("path traversal", () => {
  it("refuses to read outside the skill directory by any route", async () => {
    const { dir, skills } = root((tree) => {
      skill(tree, "alpha-skill");
      mkdirSync(join(tree, "alpha-skill", "assets"));
      writeFileSync(
        join(tree, "alpha-skill", "assets", "table.md"),
        "# table\n",
      );
    });

    writeFileSync(join(dir, "secret.md"), "top secret\n");
    symlinkSync(
      join(dir, "secret.md"),
      join(dir, "alpha-skill", "assets", "escape.md"),
    );

    const forbidden = [
      "../secret.md",
      "assets/../../secret.md",
      "/etc/passwd",
      "assets/escape.md",
      "assets/table.png",
    ];

    for (const path of forbidden) {
      const outcome = await runLocalTool(
        readSkillAssetTool,
        { name: "alpha-skill", path },
        { runId: "run_1", registry: skills },
      );

      expect(outcome, path).toMatchObject({
        ok: false,
        errorCode: "skill_asset_forbidden",
      });
    }

    // The legitimate read still works, so the guard is not simply refusing all.
    const allowed = await runLocalTool(
      readSkillAssetTool,
      { name: "alpha-skill", path: "assets/table.md" },
      { runId: "run_1", registry: skills },
    );

    expect(allowed).toMatchObject({
      ok: true,
      output: { path: "assets/table.md", content: "# table\n" },
    });
  });

  it("reports a missing asset as missing, not as forbidden", () => {
    const { skills } = root((dir) => skill(dir, "alpha-skill"));

    expect(() =>
      readSkillAsset("alpha-skill", "assets/gone.md", skills),
    ).toThrow(SkillError);

    try {
      readSkillAsset("alpha-skill", "assets/gone.md", skills);
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_asset_not_found");
    }
  });
});

describe("deduplication", () => {
  it("records one row when the model loads the same skill twice", async () => {
    const { skills } = root((dir) => skill(dir, "alpha-skill"));
    const context = { runId: "run_1", registry: skills };

    const first = await runLocalTool(
      loadSkill,
      { name: "alpha-skill" },
      context,
    );

    expect(first).toMatchObject({ output: { alreadyLoaded: false } });

    runSkill.findUnique.mockResolvedValue({
      contentHash: getSkill("alpha-skill", skills).contentHash,
      content: "Do the thing carefully.",
    });

    const second = await runLocalTool(
      loadSkill,
      { name: "alpha-skill" },
      context,
    );

    expect(second).toMatchObject({ output: { alreadyLoaded: true } });
    // The body still comes back — dedupe suppresses the row, not the guidance.
    expect(second).toMatchObject({
      output: { instructions: "Do the thing carefully." },
    });
    expect(runSkill.create).toHaveBeenCalledTimes(1);
  });
});

describe("durable resume", () => {
  it("hashes the body so a resume can prove the guidance is identical", async () => {
    const { skills } = root((dir) => skill(dir, "alpha-skill"));

    await runLocalTool(
      loadSkill,
      { name: "alpha-skill" },
      { runId: "run_1", registry: skills },
    );

    const persisted = runSkill.create.mock.calls[0][0].data.contentHash;

    // A second process discovering the same tree derives the same hash, which
    // is what lets a resumed run assert it is working from the same guidance.
    const { skills: reread } = root((dir) => skill(dir, "alpha-skill"));

    expect(persisted).toMatch(/^[0-9a-f]{64}$/);
    expect(getSkill("alpha-skill", reread).contentHash).toBe(persisted);
    expect(runSkill.create.mock.calls[0][0].data.content).toBe(
      "Do the thing carefully.",
    );
  });

  it("returns and restores the immutable saved body after a deploy", async () => {
    const { skills } = root((dir) =>
      skill(
        dir,
        "alpha-skill",
        `---\nname: alpha-skill\ndescription: ${DESCRIPTION}\n---\n\nNew instructions.\n`,
      ),
    );
    const oldHash = "a".repeat(64);

    runSkill.findUnique.mockResolvedValue({
      contentHash: oldHash,
      content: "Original saved instructions.",
    });
    runSkill.findMany.mockResolvedValue([
      {
        name: "alpha-skill",
        contentHash: oldHash,
        content: "Original saved instructions.",
      },
    ]);

    const outcome = await runLocalTool(
      loadSkill,
      { name: "alpha-skill" },
      { runId: "run_1", registry: skills },
    );

    expect(outcome).toMatchObject({
      ok: true,
      output: {
        contentHash: oldHash,
        instructions: "Original saved instructions.",
        alreadyLoaded: true,
      },
    });

    const prompt = await restoredSkillsPrompt("run_1");

    expect(prompt).toContain("Original saved instructions.");
    expect(prompt).not.toContain("New instructions.");
  });

  it("changes the hash when the guidance changes", () => {
    const { skills: before } = root((dir) => skill(dir, "alpha-skill"));
    const { skills: after } = root((dir) =>
      skill(
        dir,
        "alpha-skill",
        `---\nname: alpha-skill\ndescription: ${DESCRIPTION}\n---\n\nDo the thing differently.\n`,
      ),
    );

    expect(getSkill("alpha-skill", after).contentHash).not.toBe(
      getSkill("alpha-skill", before).contentHash,
    );
  });
});

describe("the shipped skills", () => {
  it("discovers all three from the real agent-skills directory", () => {
    const skills = discoverSkills(defaultSkillsRoot());

    expect([...skills.keys()]).toEqual([
      "image-cropping",
      "image-generation",
      "video-merging",
    ]);

    for (const entry of skills.values()) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.body.length).toBeGreaterThan(200);
    }
  });

  it("reads the pricing asset the generation skill points at", () => {
    const skills = discoverSkills(defaultSkillsRoot());
    const asset = readSkillAsset(
      "image-generation",
      "assets/size-pricing.md",
      skills,
    );

    expect(asset.content).toContain("210,720");
  });
});
