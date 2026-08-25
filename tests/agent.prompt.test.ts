import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@/agent/prompt";
import { discoverSkills, defaultSkillsRoot } from "@/skills/registry";

/**
 * The base prompt against the skills actually shipped.
 *
 * This is the invariant progressive loading rests on: prompt size is a function
 * of how many skills exist, not how long they are. A skill body leaking in here
 * would defeat the whole design silently — the agent would still work, just
 * more expensively on every single turn — so it is asserted rather than left to
 * a manual read.
 */
describe("base prompt", () => {
  const skills = discoverSkills(defaultSkillsRoot());
  const prompt = buildSystemPrompt(skills);

  it("names every shipped skill with its description", () => {
    for (const skill of skills.values()) {
      expect(prompt).toContain(skill.name);
      expect(prompt).toContain(skill.description);
    }
  });

  it("carries no skill body", () => {
    for (const skill of skills.values()) {
      // The first heading of each body is enough of a fingerprint: if it is
      // absent, the body was not inlined.
      const firstLine = skill.body.split("\n")[0];

      expect(prompt).not.toContain(firstLine);
    }

    // Distinctive strings from the three shipped bodies and the pricing asset.
    for (const marker of [
      "width_percent",
      "Fade",
      "210,720",
      "uploadedImages",
    ]) {
      expect(prompt).not.toContain(marker);
    }
  });

  it("stays small enough to send on every turn", () => {
    const perSkill =
      [...skills.values()].reduce(
        (sum, skill) => sum + skill.name.length + skill.description.length,
        0,
      ) / skills.size;

    expect(prompt.length).toBeLessThan(2_048);
    // Adding a hundred skills would add a hundred short lines, not a hundred
    // documents. This is the number that claim depends on.
    expect(perSkill).toBeLessThan(200);
  });

  it("tells the model the skills are loaded, not read from the prompt", () => {
    expect(prompt).toContain("load_skill");
  });
});
