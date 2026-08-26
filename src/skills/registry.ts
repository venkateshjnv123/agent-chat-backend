import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  existsSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

/**
 * Skills are application-owned guidance bundles, discovered from disk.
 *
 * The base prompt carries names and descriptions only; a body reaches the model
 * exclusively through the `load_skill` tool. That keeps prompt size a function
 * of how many skills exist, not how long they are, and makes every load an
 * auditable event we can persist against the run.
 *
 * Nothing here is provider-specific. A skill is a directory with a SKILL.md, so
 * adding one is adding a folder — no registry edit, no orchestration branch.
 */

const SKILL_FILE = "SKILL.md";

/**
 * Bounds exist so a skill cannot blow up a prompt or a response. They are
 * generous for prose and small enough that a stray binary is rejected.
 */
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 128 * 1024;

/** Assets are guidance, not payloads. Anything else is refused by extension. */
const ASSET_EXTENSIONS = [".md", ".txt", ".json", ".yaml", ".yml", ".csv"];

const FrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    // The name is also the directory and part of a tool argument, so it is kept
    // to a shape that cannot be confused with a path.
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case"),
  description: z.string().min(20).max(1_000),
});

export type Skill = {
  readonly name: string;
  readonly description: string;
  /** Markdown after the frontmatter block. */
  readonly body: string;
  /** SHA-256 of the body, persisted so a resume can prove identical guidance. */
  readonly contentHash: string;
  /** Absolute, symlink-resolved directory. The root for asset reads. */
  readonly directory: string;
};

export class SkillError extends Error {
  constructor(
    readonly code:
      | "skill_not_found"
      | "skill_asset_not_found"
      | "skill_asset_forbidden"
      | "skill_asset_too_large"
      | "skill_version_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

/**
 * Splits `---\n…\n---\n` off the front of a document.
 *
 * Deliberately a small strict parser rather than a YAML dependency: the only
 * frontmatter we accept is flat `key: value` pairs, and a full YAML engine
 * would accept anchors, tags, and nested structures we would then have to
 * defend against.
 */
function parseFrontmatter(source: string): {
  data: Record<string, string>;
  body: string;
} {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    throw new Error("missing frontmatter block");
  }

  const end = normalized.indexOf("\n---", 3);

  if (end === -1) throw new Error("unterminated frontmatter block");

  const data: Record<string, string> = {};

  for (const line of normalized.slice(4, end).split("\n")) {
    if (line.trim() === "") continue;

    const separator = line.indexOf(":");

    if (separator === -1)
      throw new Error(`malformed frontmatter line: ${line}`);

    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");

    if (key in data) throw new Error(`duplicate frontmatter key: ${key}`);

    data[key] = value;
  }

  return {
    data,
    body: normalized.slice(normalized.indexOf("\n", end + 1) + 1).trim(),
  };
}

function loadSkill(directory: string, folder: string): Skill {
  const file = join(directory, SKILL_FILE);

  if (!existsSync(file)) {
    throw new Error(`${folder}/${SKILL_FILE} is missing`);
  }

  const { size } = statSync(file);

  if (size > MAX_SKILL_BYTES) {
    throw new Error(
      `${folder}/${SKILL_FILE} is ${size} bytes, over the ${MAX_SKILL_BYTES} limit`,
    );
  }

  const source = readFileSync(file, "utf8");
  let parsed: ReturnType<typeof parseFrontmatter>;

  try {
    parsed = parseFrontmatter(source);
  } catch (error) {
    throw new Error(
      `${folder}/${SKILL_FILE}: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }

  const frontmatter = FrontmatterSchema.safeParse(parsed.data);

  if (!frontmatter.success) {
    const issue = frontmatter.error.issues[0];

    throw new Error(
      `${folder}/${SKILL_FILE}: frontmatter ${issue.path.join(".") || "root"} ${issue.message}`,
    );
  }

  // The folder is what a caller sees in a path; a name that disagreed with it
  // would make `load_skill` and `read_skill_asset` resolve to different places.
  if (frontmatter.data.name !== folder) {
    throw new Error(
      `${folder}/${SKILL_FILE}: name "${frontmatter.data.name}" does not match its directory`,
    );
  }

  if (parsed.body.length === 0) {
    throw new Error(`${folder}/${SKILL_FILE}: body is empty`);
  }

  return {
    name: frontmatter.data.name,
    description: frontmatter.data.description,
    body: parsed.body,
    contentHash: createHash("sha256").update(parsed.body).digest("hex"),
    // Resolving symlinks here means the asset containment check below compares
    // real paths, so a symlinked skill directory cannot widen the sandbox.
    directory: realpathSync(directory),
  };
}

/**
 * Scans a root for skill directories.
 *
 * Throws on the first invalid skill rather than skipping it. A silently dropped
 * skill is a guidance regression that only shows up as the agent behaving worse,
 * which is far harder to notice than a failed startup.
 */
export function discoverSkills(root: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();

  if (!existsSync(root)) {
    throw new Error(`skills root does not exist: ${root}`);
  }

  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  for (const folder of folders) {
    const skill = loadSkill(join(root, folder), folder);

    if (skills.has(skill.name)) {
      throw new Error(`duplicate skill name: ${skill.name}`);
    }

    skills.set(skill.name, skill);
  }

  return skills;
}

export function defaultSkillsRoot(): string {
  return resolve(process.cwd(), "agent-skills");
}

let cached: Map<string, Skill> | null = null;

/** Discovered once per process; validation failures surface at first use. */
export function skillRegistry(): Map<string, Skill> {
  cached ??= discoverSkills(defaultSkillsRoot());

  return cached;
}

/** Test seam — lets a suite point the registry at a fixture tree. */
export function setSkillRegistry(skills: Map<string, Skill> | null): void {
  cached = skills;
}

/** Exactly what the base prompt is allowed to carry. */
export function listSkillMetadata(
  registry: Map<string, Skill> = skillRegistry(),
): { name: string; description: string }[] {
  return [...registry.values()].map(({ name, description }) => ({
    name,
    description,
  }));
}

export function getSkill(
  name: string,
  registry: Map<string, Skill> = skillRegistry(),
): Skill {
  const skill = registry.get(name);

  if (!skill) {
    // The message names what does exist: an unknown skill is usually the model
    // guessing, and the list steers the retry.
    throw new SkillError(
      "skill_not_found",
      `Unknown skill "${name}". Available: ${[...registry.keys()].join(", ")}.`,
    );
  }

  return skill;
}

/**
 * Reads a file from inside one skill directory.
 *
 * Containment is checked on the real, resolved path rather than on the string
 * the caller supplied, so `../`, an absolute path, a symlink out of the tree,
 * and an encoded traversal all fail the same way.
 */
export function readSkillAsset(
  name: string,
  assetPath: string,
  registry: Map<string, Skill> = skillRegistry(),
): { path: string; content: string; bytes: number } {
  const skill = getSkill(name, registry);

  if (isAbsolute(assetPath) || assetPath.includes("\0")) {
    throw new SkillError(
      "skill_asset_forbidden",
      "Asset paths must be relative to the skill directory.",
    );
  }

  if (!ASSET_EXTENSIONS.some((extension) => assetPath.endsWith(extension))) {
    throw new SkillError(
      "skill_asset_forbidden",
      `Only text assets can be read (${ASSET_EXTENSIONS.join(", ")}).`,
    );
  }

  const target = resolve(skill.directory, assetPath);
  const within = relative(skill.directory, target);

  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    throw new SkillError(
      "skill_asset_forbidden",
      "That path is outside the skill directory.",
    );
  }

  if (!existsSync(target)) {
    throw new SkillError(
      "skill_asset_not_found",
      `"${assetPath}" does not exist in skill "${name}".`,
    );
  }

  // Re-check after resolving symlinks: existsSync followed a link that resolve()
  // could not see.
  const real = realpathSync(target);
  const realWithin = relative(skill.directory, real);

  if (realWithin.startsWith("..") || isAbsolute(realWithin)) {
    throw new SkillError(
      "skill_asset_forbidden",
      "That path resolves outside the skill directory.",
    );
  }

  const stats = statSync(real);

  if (!stats.isFile()) {
    throw new SkillError("skill_asset_forbidden", "That path is not a file.");
  }

  if (stats.size > MAX_ASSET_BYTES) {
    throw new SkillError(
      "skill_asset_too_large",
      `"${assetPath}" is ${stats.size} bytes, over the ${MAX_ASSET_BYTES} limit.`,
    );
  }

  return {
    // Normalised so the persisted/returned path cannot echo back a traversal.
    path: realWithin.split(sep).join("/"),
    content: readFileSync(real, "utf8"),
    bytes: stats.size,
  };
}
