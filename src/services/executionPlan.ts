import { z } from "zod";

import type {
  AgentMessage,
  AgentProvider,
  AgentTool,
  ToolCall,
  TokenUsage,
} from "@/agent/provider";
import type { PlanPayload, PlanStep } from "@/contracts/waitpoint";
import { estimateCredits } from "@/magica/client";
import { formatEstimate } from "@/services/credits";
import { stableStringify } from "@/services/planGate";
import { getTool, sanitizeInput } from "@/tools/registry";

const MAX_PLAN_STEPS = 100;
const MAX_PLANNER_ATTEMPTS = 2;
const REFERENCE_URL = "https://example.invalid/planned-output";

const DraftStepSchema = z.object({
  id: z.string().min(1).max(80),
  toolName: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(1_000),
  dependsOn: z.array(z.string().min(1).max(80)).max(MAX_PLAN_STEPS).default([]),
  input: z.record(z.string(), z.unknown()).default({}),
});

const DraftPlanSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  overview: z.string().min(1).max(2_000).optional(),
  notes: z.string().min(1).max(2_000).nullable().optional(),
  steps: z.array(DraftStepSchema).max(MAX_PLAN_STEPS),
});

export type PlannedExecution = {
  plan: PlanPayload | null;
  routedModel: string | null;
  usage: TokenUsage | null;
};

/**
 * Builds the complete billable graph before any provider tool is dispatched.
 *
 * The planner cannot spend credits: it receives tool contracts as text and no
 * callable tools. Dependent values use a persisted `$fromStep` reference. The
 * normal agent still supplies the final validated call arguments after prior
 * outputs exist; the graph controls approval, order, and release semantics.
 */
export async function buildCompleteExecutionPlan(options: {
  provider: AgentProvider;
  conversation: AgentMessage[];
  tools: AgentTool[];
  initialCalls?: ToolCall[];
  feedback?: string | null;
  signal?: AbortSignal;
}): Promise<PlannedExecution> {
  const billableTools = options.tools.filter(
    (tool) => getTool(tool.function.name) !== undefined,
  );

  if (billableTools.length === 0) {
    return { plan: null, routedModel: null, usage: null };
  }

  const prompt = plannerPrompt({
    conversation: options.conversation,
    tools: billableTools,
    initialCalls: options.initialCalls ?? [],
    feedback: options.feedback ?? null,
  });
  let routedModel: string | null = null;
  let usage: TokenUsage | null = null;
  let draft: z.infer<typeof DraftPlanSchema> | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt += 1) {
    let text = "";
    for await (const chunk of options.provider.stream({
      messages: [
        {
          role: "system",
          content:
            "You are a deterministic execution planner. Return JSON only. " +
            "Never claim a tool ran and never omit a dependent billable step.",
        },
        {
          role: "user",
          content:
            attempt === 1
              ? prompt
              : `Your previous response was invalid. Return one JSON object matching this request exactly:\n${prompt}`,
        },
      ],
      signal: options.signal,
    })) {
      if (chunk.type === "text") text += chunk.text;
      else {
        routedModel = chunk.routedModel ?? routedModel;
        usage = addTokenUsage(usage, chunk.usage);
      }
    }

    try {
      draft = DraftPlanSchema.parse(parsePlannerJson(text));
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!draft) throw lastError ?? new Error("planner_returned_invalid_plan");
  const normalized = normalizeDraft(draft, options.initialCalls ?? []);

  if (normalized.steps.length === 0) {
    return { plan: null, routedModel, usage };
  }

  const estimates = await estimatePlanSteps(normalized.steps);
  const steps: PlanStep[] = normalized.steps.map((step, index) => ({
    ...step,
    n: index + 1,
    estimateCredits: estimates[index] ?? 0,
    status: "PENDING",
  }));
  const totalEstimate = steps.reduce(
    (total, step) => total + step.estimateCredits,
    0,
  );

  return {
    plan: {
      title:
        draft.title ??
        (steps.length === 1
          ? "One step to run"
          : `${steps.length} steps to run`),
      overview:
        draft.overview ??
        `Review the complete plan before execution. Estimated total: ${formatEstimate(totalEstimate)}.`,
      steps,
      totalEstimate,
      notes: draft.notes ?? dependencyNote(steps),
    },
    routedModel,
    usage,
  };
}

/** Fallback when the planner response is unavailable or misses a later call. */
export async function buildPlanFromCalls(
  calls: ToolCall[],
): Promise<PlanPayload | null> {
  const billable = calls.flatMap((call, index) => {
    const definition = getTool(call.name);
    if (!definition) return [];

    const input = asRecord(call.input);
    return [
      {
        id: `step_${index + 1}`,
        n: index + 1,
        toolName: definition.name,
        title: humanize(definition.name),
        description: `${definition.description.split(".")[0]}.`,
        dependsOn: [] as string[],
        input: sanitizeInput(definition, input),
        estimateCredits: 0,
        status: "PENDING" as const,
      },
    ];
  });

  if (billable.length === 0) return null;

  const estimates = await estimatePlanSteps(billable);
  const steps = billable.map((step, index) => ({
    ...step,
    estimateCredits: estimates[index] ?? 0,
  }));
  const totalEstimate = steps.reduce(
    (total, step) => total + step.estimateCredits,
    0,
  );

  return {
    title:
      steps.length === 1 ? "One step to run" : `${steps.length} steps to run`,
    overview: `Review the plan before execution. Estimated total: ${formatEstimate(totalEstimate)}.`,
    steps,
    totalEstimate,
    notes: null,
  };
}

export function markPlanStep(
  plan: PlanPayload,
  call: ToolCall,
  status: PlanStep["status"],
): PlanPayload {
  const eligible = status === "RUNNING" ? ["PENDING"] : ["RUNNING", "PENDING"];
  const definition = getTool(call.name);
  if (!definition) return plan;
  const input = sanitizeInput(definition, asRecord(call.input));
  const index = plan.steps.findIndex(
    (step) =>
      eligible.includes(step.status) &&
      step.toolName === call.name &&
      (status !== "RUNNING" || dependenciesCompleted(plan, step)) &&
      approvedInputMatches(plan, step, step.input, input),
  );

  if (index < 0) return plan;

  return {
    ...plan,
    steps: plan.steps.map((step, current) =>
      current === index ? { ...step, status } : step,
    ),
  };
}

export function hasPendingPlannedTool(
  plan: PlanPayload,
  toolName: string,
): boolean {
  return plan.steps.some(
    (step) => step.status === "PENDING" && step.toolName === toolName,
  );
}

/** Multiset coverage: one approved node can release at most one actual call. */
export function planCoversCalls(
  plan: PlanPayload,
  calls: readonly ToolCall[],
): boolean {
  const used = new Set<string>();

  for (const call of calls) {
    const definition = getTool(call.name);
    if (!definition) continue;
    const input = sanitizeInput(definition, asRecord(call.input));
    const step = plan.steps.find(
      (candidate) =>
        !used.has(candidate.id) &&
        candidate.status === "PENDING" &&
        candidate.toolName === call.name &&
        dependenciesCompleted(plan, candidate) &&
        approvedInputMatches(plan, candidate, candidate.input, input),
    );
    if (!step) return false;
    used.add(step.id);
  }

  return true;
}

function dependenciesCompleted(plan: PlanPayload, step: PlanStep): boolean {
  return step.dependsOn.every(
    (dependency) =>
      plan.steps.find((candidate) => candidate.id === dependency)?.status ===
      "COMPLETED",
  );
}

function approvedInputMatches(
  plan: PlanPayload,
  step: PlanStep,
  approved: unknown,
  actual: unknown,
): boolean {
  if (Array.isArray(approved)) {
    return (
      Array.isArray(actual) &&
      approved.length === actual.length &&
      approved.every((item, index) =>
        approvedInputMatches(plan, step, item, actual[index]),
      )
    );
  }

  if (approved && typeof approved === "object") {
    const expected = approved as Record<string, unknown>;
    if (typeof expected.$fromStep === "string") {
      return (
        step.dependsOn.includes(expected.$fromStep) &&
        plan.steps.find((candidate) => candidate.id === expected.$fromStep)
          ?.status === "COMPLETED"
      );
    }

    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return false;
    }

    const received = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expected).sort();
    const receivedKeys = Object.keys(received).sort();
    return (
      sameJson(expectedKeys, receivedKeys) &&
      expectedKeys.every((key) =>
        approvedInputMatches(plan, step, expected[key], received[key]),
      )
    );
  }

  return Object.is(approved, actual);
}

function plannerPrompt(options: {
  conversation: AgentMessage[];
  tools: AgentTool[];
  initialCalls: ToolCall[];
  feedback: string | null;
}): string {
  const visibleConversation = options.conversation
    .filter((message) => message.role !== "system")
    .slice(-20);

  return JSON.stringify({
    task: "Return complete billable execution graph for request. Include downstream dependent tools, not only first immediately-callable tool. Return zero steps if no billable tool is needed.",
    format: {
      title: "short plan title",
      overview: "one sentence",
      notes: "dependency or caveat, or null",
      steps: [
        {
          id: "stable-local-id",
          toolName: "exact tool name",
          title: "human title",
          description: "what this step does",
          dependsOn: ["prior-step-id"],
          input: {
            field: "literal value",
            dependentField: {
              $fromStep: "prior-step-id",
              path: "result.urls.0",
            },
          },
        },
      ],
    },
    rules: [
      "Use only supplied billable tools.",
      "Keep steps in dependency order.",
      "Every dependsOn id must refer to an earlier step.",
      "Copy known sanitized inputs; use $fromStep only for values produced later.",
      "Include supplied initialCalls in the graph.",
      "Do not use markdown fences or prose outside JSON.",
    ],
    requestedChanges: options.feedback,
    conversation: visibleConversation,
    initialCalls: options.initialCalls,
    tools: options.tools.map((tool) => tool.function),
  });
}

function normalizeDraft(
  draft: z.infer<typeof DraftPlanSchema>,
  initialCalls: ToolCall[],
) {
  const seenIds = new Set<string>();
  const valid = draft.steps.filter((step) => {
    if (!getTool(step.toolName) || seenIds.has(step.id)) return false;
    seenIds.add(step.id);
    return true;
  });
  const draftEntries = valid.map((step) => {
    const definition = getTool(step.toolName)!;
    const input = sanitizeInput(definition, asRecord(step.input));

    return {
      sourceId: step.id,
      toolName: step.toolName,
      title: step.title,
      description: step.description,
      sourceDependencies: step.dependsOn,
      input,
    };
  });

  // Planner failure must not drop calls the agent already proposed. Prepend a
  // missing call so automatic safety gating remains conservative.
  const missing = [] as Array<{
    sourceId: null;
    toolName: string;
    title: string;
    description: string;
    sourceDependencies: string[];
    input: Record<string, unknown>;
  }>;
  for (const call of initialCalls) {
    const definition = getTool(call.name);
    if (!definition) continue;
    const input = sanitizeInput(definition, asRecord(call.input));
    const present = draftEntries.some(
      (step) => step.toolName === call.name && sameJson(step.input, input),
    );
    if (present) continue;

    missing.push({
      sourceId: null,
      toolName: call.name,
      title: humanize(call.name),
      description: `${definition.description.split(".")[0]}.`,
      sourceDependencies: [],
      input,
    });
  }

  const all = [...missing, ...draftEntries];
  const sourceToFinal = new Map<string, string>();
  const sourceIndex = new Map<string, number>();
  all.forEach((step, index) => {
    if (step.sourceId) {
      sourceToFinal.set(step.sourceId, `step_${index + 1}`);
      sourceIndex.set(step.sourceId, index);
    }
  });

  return {
    steps: all.map((step, index) => {
      const normalized = step.sourceId
        ? normalizeInputReferences(
            step.input,
            index,
            sourceToFinal,
            sourceIndex,
          )
        : { value: step.input, dependencies: [] as string[] };
      const explicitDependencies = step.sourceDependencies.flatMap(
        (dependency) => {
          const finalId = sourceToFinal.get(dependency);
          const dependencyIndex = sourceIndex.get(dependency);
          return finalId &&
            dependencyIndex !== undefined &&
            dependencyIndex < index
            ? [finalId]
            : [];
        },
      );

      return {
        id: `step_${index + 1}`,
        toolName: step.toolName,
        title: step.title,
        description: step.description,
        dependsOn: [
          ...new Set([...explicitDependencies, ...normalized.dependencies]),
        ],
        input: normalized.value,
      };
    }),
  };
}

function normalizeInputReferences(
  input: Record<string, unknown>,
  currentIndex: number,
  sourceToFinal: Map<string, string>,
  sourceIndex: Map<string, number>,
): { value: Record<string, unknown>; dependencies: string[] } {
  const dependencies = new Set<string>();

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;

    const record = value as Record<string, unknown>;
    if (typeof record.$fromStep === "string") {
      const finalId = sourceToFinal.get(record.$fromStep);
      const dependencyIndex = sourceIndex.get(record.$fromStep);
      if (
        !finalId ||
        dependencyIndex === undefined ||
        dependencyIndex >= currentIndex
      ) {
        throw new Error("planner_returned_invalid_dependency_reference");
      }

      dependencies.add(finalId);
      return {
        $fromStep: finalId,
        ...(typeof record.path === "string" ? { path: record.path } : {}),
      };
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, visit(child)]),
    );
  };

  return {
    value: visit(input) as Record<string, unknown>,
    dependencies: [...dependencies],
  };
}

async function estimatePlanSteps(
  steps: Array<{ toolName: string; input: Record<string, unknown> }>,
): Promise<number[]> {
  const estimates = steps.map(() => 0);
  const prepared: Array<{
    index: number;
    value: { type: string; data: Record<string, unknown> };
  }> = [];

  steps.forEach((step, index) => {
    try {
      const definition = getTool(step.toolName);
      if (!definition) return;
      const substituted = substituteReferences(step.input);
      const parsed = definition.input.parse(substituted);

      prepared.push({
        index,
        value: {
          type: definition.nodeType,
          data: definition.toNodeInput(parsed),
        },
      });
    } catch {
      // Keep this step at zero; valid siblings can still receive estimates.
    }
  });

  if (prepared.length === 0) return estimates;

  try {
    const priced = await estimateCredits(prepared.map((entry) => entry.value));
    prepared.forEach((entry, index) => {
      estimates[entry.index] = priced[index]?.microcredits ?? 0;
    });
  } catch {
    // Pricing outage must not weaken the approval gate.
  }

  return estimates;
}

function substituteReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(substituteReferences);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record.$fromStep === "string") return REFERENCE_URL;

  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      substituteReferences(item),
    ]),
  );
}

function parsePlannerJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("planner_returned_no_json");
  return JSON.parse(text.slice(start, end + 1));
}

function dependencyNote(steps: PlanStep[]): string | null {
  return steps.some((step) => step.dependsOn.length > 0)
    ? "Dependent steps run only after their prerequisites complete."
    : null;
}

function humanize(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function addTokenUsage(
  current: TokenUsage | null,
  next: TokenUsage | null,
): TokenUsage | null {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
  };
}
