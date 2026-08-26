import { z } from "zod";

import { prisma } from "@/db/client";
import {
  SkillError,
  getSkill,
  listSkillMetadata,
  readSkillAsset,
  skillRegistry,
  type Skill,
} from "@/skills/registry";

/**
 * The two loader tools, as typed contracts.
 *
 * They are local tools: they read guidance and record that it was read, and
 * they never call a provider or spend credit. That is why they are not in the
 * Magica registry — the agent loop branches once on execution kind, not once
 * per tool, and a local tool needs no claim, no child task, and no settlement.
 *
 * Input and output are both Zod-validated. Output validation matters as much as
 * input here: skill content is the one thing that reaches the model's context
 * without having come from the user or the provider, so its shape is checked
 * before it is handed over.
 */

export type LocalToolContext = {
  runId: string;
  registry?: Map<string, Skill>;
};

export type LocalToolDefinition<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> = {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  readonly output: Output;
  execute(
    input: z.infer<Input>,
    context: LocalToolContext,
  ): Promise<z.infer<Output>>;
};

const LoadSkillInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("Exact skill name from the list of available skills."),
});

const LoadSkillOutput = z.object({
  name: z.string(),
  contentHash: z.string(),
  instructions: z.string(),
  /** True when this run had already loaded the skill; the body is unchanged. */
  alreadyLoaded: z.boolean(),
});

const ReadSkillAssetInput = z.object({
  name: z.string().min(1).max(64).describe("Skill that owns the asset."),
  path: z
    .string()
    .min(1)
    .max(256)
    .describe(
      "Path relative to the skill directory, e.g. assets/size-pricing.md. " +
        "Absolute paths and paths leaving the directory are rejected.",
    ),
});

const ReadSkillAssetOutput = z.object({
  name: z.string(),
  path: z.string(),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
});

/**
 * Records that a run loaded a skill.
 *
 * The unique `(runId, name)` index does the deduplication, so a model that
 * loads the same skill twice produces one row and one recorded hash. A resume
 * reads these rows back and gets identical guidance even if the file on disk
 * has since changed — the hash is what proves it.
 */
async function recordLoad(
  runId: string,
  skill: Skill,
): Promise<{
  alreadyLoaded: boolean;
  contentHash: string;
  instructions: string;
}> {
  const existing = await prisma.runSkill.findUnique({
    where: { runId_name: { runId, name: skill.name } },
    select: { contentHash: true, content: true },
  });

  if (existing?.content) {
    return {
      alreadyLoaded: true,
      contentHash: existing.contentHash,
      instructions: existing.content,
    };
  }

  if (existing) {
    // Legacy rows can be repaired only while their saved hash still matches.
    // Guessing after a deploy would silently change a resumed run's guidance.
    if (existing.contentHash !== skill.contentHash) {
      throw new SkillError(
        "skill_version_unavailable",
        `The saved version of skill "${skill.name}" is no longer available. Start a new turn to use the current version.`,
      );
    }

    await prisma.runSkill.update({
      where: { runId_name: { runId, name: skill.name } },
      data: { content: skill.body },
    });

    return {
      alreadyLoaded: true,
      contentHash: skill.contentHash,
      instructions: skill.body,
    };
  }

  await prisma.runSkill.create({
    data: {
      runId,
      name: skill.name,
      contentHash: skill.contentHash,
      content: skill.body,
    },
  });

  return {
    alreadyLoaded: false,
    contentHash: skill.contentHash,
    instructions: skill.body,
  };
}

export const loadSkill: LocalToolDefinition<
  typeof LoadSkillInput,
  typeof LoadSkillOutput
> = {
  name: "load_skill",
  description:
    "Load the full instructions for one of the available skills. Call this " +
    "before doing the kind of work the skill describes — the base prompt only " +
    "lists names and descriptions, not the guidance itself.",
  input: LoadSkillInput,
  output: LoadSkillOutput,

  async execute(input, context) {
    const skill = getSkill(input.name, context.registry ?? skillRegistry());
    const loaded = await recordLoad(context.runId, skill);

    return LoadSkillOutput.parse({
      name: skill.name,
      contentHash: loaded.contentHash,
      instructions: loaded.instructions,
      alreadyLoaded: loaded.alreadyLoaded,
    });
  },
};

export const readSkillAssetTool: LocalToolDefinition<
  typeof ReadSkillAssetInput,
  typeof ReadSkillAssetOutput
> = {
  name: "read_skill_asset",
  description:
    "Read a supporting text file from inside a skill directory, such as a " +
    "reference table a skill points at. Load the skill first; its instructions " +
    "name the assets worth reading.",
  input: ReadSkillAssetInput,
  output: ReadSkillAssetOutput,

  async execute(input, context) {
    const asset = readSkillAsset(
      input.name,
      input.path,
      context.registry ?? skillRegistry(),
    );

    return ReadSkillAssetOutput.parse({ name: input.name, ...asset });
  },
};

const LOCAL_TOOLS: readonly LocalToolDefinition[] = [
  loadSkill,
  readSkillAssetTool,
];

const BY_NAME = new Map(LOCAL_TOOLS.map((tool) => [tool.name, tool]));

export function listLocalTools(): readonly LocalToolDefinition[] {
  return LOCAL_TOOLS;
}

export function getLocalTool(name: string): LocalToolDefinition | undefined {
  return BY_NAME.get(name);
}

export type LocalToolOutcome =
  | { ok: true; output: unknown }
  | { ok: false; errorCode: string; userMessage: string };

/**
 * Runs a local tool and turns any failure into something the model can act on.
 *
 * A bad skill name or a rejected path is a failed step, not a failed turn: the
 * model gets told what went wrong and can correct itself on the next pass.
 */
export async function runLocalTool(
  tool: LocalToolDefinition,
  rawInput: unknown,
  context: LocalToolContext,
): Promise<LocalToolOutcome> {
  const parsed = tool.input.safeParse(rawInput);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return {
      ok: false,
      errorCode: "invalid_tool_input",
      userMessage: `${tool.name} was called with invalid arguments: ${
        issue.path.join(".") || "input"
      } ${issue.message}.`,
    };
  }

  try {
    return { ok: true, output: await tool.execute(parsed.data, context) };
  } catch (error) {
    if (error instanceof SkillError) {
      return { ok: false, errorCode: error.code, userMessage: error.message };
    }

    throw error;
  }
}

/**
 * The skills section of the base prompt.
 *
 * Names and descriptions only — the whole point of progressive loading is that
 * prompt size does not grow with skill length. A hundred skills would add a
 * hundred lines here, not a hundred documents.
 */
export function skillsPromptSection(
  registry: Map<string, Skill> = skillRegistry(),
): string {
  const skills = listSkillMetadata(registry);

  if (skills.length === 0) return "";

  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);

  return [
    "## Available skills",
    "",
    "These are guidance bundles, not tools that do work. Call `load_skill`",
    "with a name below to read its instructions before doing that kind of",
    "work. Do not guess at a skill's contents from its description.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Rehydrates exactly the skill bodies loaded by a prior attempt.
 *
 * Tool messages are not stored in chat history, so without this section an
 * explicit retry remembers the row but loses the actual guidance. Nullable
 * legacy rows are skipped because their hash is proof, not reconstructable text.
 */
export async function restoredSkillsPrompt(runId: string): Promise<string> {
  const rows = await prisma.runSkill.findMany({
    where: { runId, content: { not: null } },
    orderBy: [{ loadedAt: "asc" }, { name: "asc" }],
    select: { name: true, contentHash: true, content: true },
  });
  const loaded = rows.filter((row): row is typeof row & { content: string } =>
    Boolean(row.content),
  );

  if (loaded.length === 0) return "";

  return [
    "## Skills already loaded for this run",
    "",
    "Use these immutable saved instructions; do not reload them from disk.",
    ...loaded.flatMap((row) => [
      "",
      `### ${row.name} (${row.contentHash})`,
      "",
      row.content,
    ]),
  ].join("\n");
}
