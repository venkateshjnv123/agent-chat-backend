#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { format } from "prettier";

/**
 * Emits Zod input schemas for the registry from Magica's live model schema API.
 *
 * The assignment is explicit that input fields must be resolved from the model
 * catalogue rather than a duplicated provider schema, and field names are the
 * one thing the API is unforgiving about — so every property key comes from
 * `GET /v1/models/{modelId}/schema` at generation time. Hand-written tool files
 * import these schemas and add only what the catalogue cannot express (the
 * two-video minimum on `merge_videos` lives in prose, not in the schema).
 *
 * The output is committed, so a build never depends on the provider being up;
 * `--check` is what catches provider drift.
 *
 *   pnpm tools:generate         write src/tools/generated/schemas.ts
 *   pnpm tools:generate --check fail if the file is stale (CI drift check)
 */

const TARGET_DIR = resolve(import.meta.dirname, "../src/tools/generated");
const TARGET = join(TARGET_DIR, "schemas.ts");

/**
 * Model ids to generate. Sub-models are addressable ids in their own right, so
 * the two GPT Image 2 modes are listed directly. Adding a tool is adding a line.
 */
const MODEL_IDS = [
  "crop_image",
  "merge_videos",
  "gpt-image-2-text",
  "gpt-image-2-edit",
];

const check = process.argv.includes("--check");

/** Reads .env.local so the script works without an exported environment. */
function readEnvFile() {
  try {
    return Object.fromEntries(
      readFileSync(resolve(import.meta.dirname, "../.env.local"), "utf8")
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, ""),
        ]),
    );
  } catch {
    return {};
  }
}

const env = { ...readEnvFile(), ...process.env };
const apiKey = env.MAGICA_API_KEY;
const baseUrl = (env.MAGICA_BASE_URL ?? "https://inference.magica.com").replace(
  /\/+$/,
  "",
);

if (!apiKey) {
  console.error(
    "Missing MAGICA_API_KEY. Set it in .env.local or the environment.",
  );
  process.exit(1);
}

/** One live schema. Sub-model ids resolve the same way whole models do. */
async function fetchSchema(modelId) {
  const response = await fetch(
    `${baseUrl}/v1/models/${encodeURIComponent(modelId)}/schema`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );

  if (!response.ok) {
    throw new Error(`schema ${modelId}: HTTP ${response.status}`);
  }

  return response.json();
}

const quote = (value) => JSON.stringify(value);

/** Renders one `inputFieldOptions` entry as Zod source. */
function fieldToZod(field) {
  const { name, dataType, options, type } = field;
  let expr;

  if (Array.isArray(options) && options.length > 0) {
    // Live schemas give bare values; the catalogue gave {value,label} objects.
    const values = options.map((option) =>
      option !== null && typeof option === "object" ? option.value : option,
    );

    expr =
      dataType === "number"
        ? `z.union([${values.map((v) => `z.literal(${quote(v)})`).join(", ")}])`
        : `z.enum([${values.map(quote).join(", ")}])`;
  } else if (dataType === "number") {
    expr = "z.number()";
    if (typeof field.min === "number") expr += `.min(${field.min})`;
    if (typeof field.max === "number") expr += `.max(${field.max})`;
  } else if (dataType === "string[]") {
    // Media arrays always carry URLs on the wire; uploads are resolved to URLs
    // before dispatch.
    const item =
      type === "image" || type === "video" ? "z.url()" : "z.string()";
    const cap = field.maxImages ?? field.maxItems;

    expr = `z.array(${item})`;
    if (typeof cap === "number") expr += `.max(${cap})`;
  } else {
    expr = type === "image" || type === "video" ? "z.url()" : "z.string()";
    if (typeof field.max === "number" && dataType === "string")
      expr += `.max(${field.max})`;
  }

  // The description reaches the model verbatim in the tool JSON, so prefer the
  // long form the catalogue wrote for the API over the terse UI help text.
  const description = field.description ?? field.helpText ?? field.label;
  if (description) expr += `.describe(${quote(description)})`;

  if (field.required !== true) {
    const hasDefault =
      field.default !== null &&
      field.default !== undefined &&
      field.default !== "";

    expr = hasDefault
      ? `${expr}.default(${quote(field.default)})`
      : `${expr}.optional()`;
  }

  return `  ${JSON.stringify(name)}: ${expr},`;
}

function objectSource(fields) {
  // A composite-select carries its custom branch in `customFields`, whose
  // entries are ordinary wire fields (`width`, `height`). They are emitted as
  // optional siblings; the tool file adds the "required when Custom" rule the
  // catalogue expresses only in prose.
  const flat = fields.flatMap((field) => [
    field,
    // Defaults are stripped: a defaulted width would always be present, and
    // the tool file's "required when Custom" rule could never fire.
    ...(field.customFields ?? []).map((custom) => ({
      ...custom,
      required: false,
      default: null,
    })),
  ]);

  return ["z.object({", ...flat.map(fieldToZod), "})"].join("\n");
}

const constName = (modelId) =>
  modelId
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^(.)/, (c) => c.toUpperCase())
    .replace(/_(.)/g, (_, c) => c.toUpperCase()) + "InputSchema";

const blocks = [];
const exported = [];

for (const modelId of MODEL_IDS) {
  const schema = await fetchSchema(modelId);
  const name = constName(modelId);

  blocks.push(
    `/** \`${schema.modelId ?? modelId}\` — ${schema.description ?? schema.name ?? modelId} */\nexport const ${name} = ${objectSource(
      schema.fields ?? [],
    )};`,
  );
  exported.push(name);
}

const unformattedSource = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: GET {MAGICA_BASE_URL}/v1/models/{modelId}/schema (live).
 * Regenerate with \`pnpm tools:generate\`; CI runs \`pnpm tools:check\`.
 *
 * Property keys are wire names (\`zodExpectedName\`) and must stay that way:
 * the live API rejects renamed fields with a redacted 400.
 */

import { z } from "zod";

${blocks.join("\n\n")}
`;
const source = await format(unformattedSource, {
  parser: "typescript",
});

mkdirSync(TARGET_DIR, { recursive: true });

let existing = null;
try {
  existing = readFileSync(TARGET, "utf8");
} catch {
  existing = null;
}

if (check) {
  if (existing !== source) {
    console.error(
      `Stale generated tool schemas. Run \`pnpm tools:generate\`. (${TARGET})`,
    );
    process.exit(1);
  }
  console.log(`Tool schemas up to date (${exported.length} variants).`);
} else {
  writeFileSync(TARGET, source);
  console.log(
    `Wrote ${TARGET} — ${exported.length} variants: ${exported.join(", ")}`,
  );
}
