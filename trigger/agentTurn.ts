import { batch, logger, metadata, task, wait } from "@trigger.dev/sdk";

import {
  EmptyStreamError,
  type AgentMessage,
  type ToolCall,
} from "@/agent/provider";
import { buildSystemPrompt } from "@/agent/prompt";
import {
  MAX_CONTEXT_MESSAGES,
  selectBoundedConversation,
} from "@/agent/context";
import { OpenRouterProvider } from "@/agent/providers/openrouter";
import { PermanentProviderError, TransientProviderError } from "@/agent/retry";
import { agentToolSchemas } from "@/agent/tools";
import { prisma } from "@/db/client";
import { recordModelUsage } from "@/services/creditLedger";
import { finalizeCancelledRun } from "@/services/cancelRun";
import {
  checkpointAssistantState,
  STREAM_CHECKPOINT_CHARACTERS,
  STREAM_CHECKPOINT_INTERVAL_MS,
} from "@/services/messageStream";
import { needsPlanApproval } from "@/services/planGate";
import {
  acknowledgePlanResolution,
  createPlanWaitpoint,
  expirePlanWaitpoint,
  type PlanDecision,
  updatePlanWaitpointPayload,
} from "@/services/waitpoints";
import { getTool } from "@/tools/registry";
import {
  AssetSchema,
  ToolResultSchema,
  type ContentBlock,
} from "@/contracts/chat";
import { magicaTool } from "./magicaTool";
import { openAgentActivityStream } from "./activityStream";
import { openAssistantTextStream } from "./textStream";
import {
  claimToolCall,
  executionKeyFor,
  readTerminalToolExecution,
  type ToolExecution,
} from "@/tools/execute";
import type { PlanPayload } from "@/contracts/waitpoint";
import {
  buildCompleteExecutionPlan,
  buildPlanFromCalls,
  markPlanStep,
  planCoversCalls,
} from "@/services/executionPlan";
import {
  getLocalTool,
  restoredSkillsPrompt,
  runLocalTool,
} from "@/skills/tools";

export type AgentTurnPayload = {
  chatId: string;
  runId: string;
  assistantMessageId: string;
  userAccountId: string;
  traceId: string;
  /** Composer plan mode: pause for approval before the first tool runs. */
  planMode?: boolean;
  /** Zero on the first dispatch; incremented by an explicit retry. */
  attempt?: number;
  /** Client session, mirrored from `x-session-id` so logs join up. */
  sessionId?: string | null;
};

/**
 * The durable unit of work for one assistant turn.
 *
 * Context is restored from Postgres at the start of every attempt rather than
 * carried in memory, so a retry, a resume after a deploy, and a first run all
 * produce the same conversation. Status rides on run metadata; the persisted
 * message is the source of truth the client reconciles against.
 *
 * A turn is a loop: the model may answer, or call tools and then answer with
 * their results. The loop knows nothing about individual tools — it asks the
 * registry for the schemas and hands each call to `executeTool` — so a new tool
 * never adds a branch here.
 */

/**
 * Ceiling on model calls in one turn.
 *
 * A model that keeps calling tools without concluding would otherwise burn
 * credits until the task hit `maxDuration`. Stopping at the ceiling leaves a
 * complete, persisted turn rather than a timeout.
 */
const MAX_TURNS = 8;
export const agentTurn = task({
  id: "agent-turn",
  // A media workflow can run several slow children in sequence (image, video,
  // audio, merge) and still needs one final model call after they finish.
  // Five minutes cut healthy demo runs off immediately after the first tool.
  maxDuration: 30 * 60,
  run: async (payload: AgentTurnPayload, { signal }) => {
    const log = (message: string, extra: Record<string, unknown> = {}) =>
      logger.info(message, {
        chatId: payload.chatId,
        runId: payload.runId,
        messageId: payload.assistantMessageId,
        traceId: payload.traceId,
        sessionId: payload.sessionId ?? null,
        attempt: payload.attempt ?? 0,
        ...extra,
      });

    const claimed = await prisma.agentRun.updateMany({
      where: {
        id: payload.runId,
        status: "QUEUED",
        attempt: payload.attempt ?? 0,
      },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    if (claimed.count === 0) {
      const current = await prisma.agentRun.findUnique({
        where: { id: payload.runId },
        select: { status: true, attempt: true },
      });

      if (current?.status === "CANCELLING") {
        await finalizeCancelledRun(payload.runId);
        metadata.set("status", "cancelled");
      }

      log("turn start ignored", {
        status: current?.status ?? "missing",
        currentAttempt: current?.attempt ?? null,
      });

      return { runId: payload.runId, characters: 0 };
    }

    metadata.set("status", "running");
    metadata.set("runId", payload.runId);
    metadata.set("messageId", payload.assistantMessageId);
    metadata.set("currentStep", "Planning request");
    metadata.set("progress", 0);

    // Token-by-token delivery. Separate from run metadata so status and text
    // travel on their own channels, and best-effort so a stream that cannot
    // open never costs the turn. Opened outside the try because a failed turn
    // must close it too.
    const textStream = await openAssistantTextStream(log);
    const activityStream = await openAgentActivityStream(log);

    try {
      const history = await restoreConversation(
        payload.chatId,
        payload.assistantMessageId,
      );

      log("conversation restored", { messages: history.length });

      const provider = new OpenRouterProvider();
      const tools = agentToolSchemas();
      // The system turn is rebuilt each attempt rather than persisted: it is
      // derived from the skill registry, and a resume should see the registry
      // as it is now. What the run must reproduce exactly is the guidance it
      // loaded, and RunSkill rows carry that.
      const restoredSkills = await restoredSkillsPrompt(payload.runId);
      const conversation: AgentMessage[] = [
        {
          role: "system",
          content: [buildSystemPrompt(), restoredSkills]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...history,
      ];
      const blocks: ContentBlock[] = [];

      let text = "";
      let routedModel: string | null = null;
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let turns = 0;
      // Set when the loop stops because it ran out of turns rather than because
      // the model was finished. The distinction is the whole point of 3.5: a
      // capped turn keeps its partial output and says why it stopped.
      let exhausted = false;
      let cancellationObserved = false;
      let lastCancellationCheck = 0;
      let checkpointedCharacters = 0;
      let nextCheckpointAt = 0;
      let streamStarted = false;
      let textSequence = 0;
      let activitySequence = 0;
      let thinkingDurationMs = 0;
      let approvalState: ApprovalState | null = null;
      let planningStopped = false;

      activityStream.push({
        type: "progress",
        runId: payload.runId,
        messageId: payload.assistantMessageId,
        sequence: ++activitySequence,
        stage: "planning",
        currentStep: "Building execution plan",
        progress: 0.05,
      });

      const preflight = await safelyBuildCompletePlan({
        provider,
        conversation,
        tools,
        signal,
        log,
      });
      routedModel = preflight.routedModel ?? routedModel;
      usage = addUsage(usage, preflight.usage);

      if (preflight.plan || payload.planMode) {
        const approval = await approveCompletePlan({
          payload,
          provider,
          conversation,
          tools,
          initialPlan: preflight.plan ?? noBillablePlan(),
          signal,
          log,
        });

        routedModel = approval.routedModel ?? routedModel;
        usage = addUsage(usage, approval.usage);

        if (approval.terminalMessage) {
          text = approval.terminalMessage;
          blocks.push({ type: "text", text });
          planningStopped = true;
        } else {
          approvalState = approval.state;
        }
      }

      for (turns = 1; !planningStopped && turns <= MAX_TURNS; turns += 1) {
        if (await cancellationRequested(payload.runId)) {
          cancellationObserved = true;
          break;
        }

        let turnText = "";
        let turnThinking = "";
        let thinkingStartedAt: number | null = null;
        let toolCalls: ToolCall[] = [];

        metadata.set("currentStep", "Thinking");
        metadata.set("progress", Math.min(0.1 + turns * 0.08, 0.7));

        for await (const chunk of provider.stream({
          messages: conversation,
          tools,
          signal,
        })) {
          // Cancellation is checked between chunks so a stopped run stops
          // promptly and still persists whatever it produced.
          if (signal?.aborted) break;

          if (Date.now() - lastCancellationCheck >= 1_000) {
            lastCancellationCheck = Date.now();

            if (await cancellationRequested(payload.runId)) {
              cancellationObserved = true;
              break;
            }
          }

          if (chunk.type === "reasoning") {
            const now = Date.now();
            thinkingStartedAt ??= now;
            turnThinking += chunk.text;
            activityStream.push({
              type: "thinking",
              runId: payload.runId,
              messageId: payload.assistantMessageId,
              sequence: ++activitySequence,
              text: chunk.text,
              elapsedMs: thinkingDurationMs + (now - thinkingStartedAt),
            });
            metadata.set("currentStep", "Thinking");

            if (now >= nextCheckpointAt) {
              nextCheckpointAt = now + STREAM_CHECKPOINT_INTERVAL_MS;
              try {
                await checkpointAssistantState({
                  messageId: payload.assistantMessageId,
                  content: text,
                  blocks: withPartialBlocks(blocks, turnThinking, turnText),
                  reasoning: allThinking(
                    withPartialBlocks(blocks, turnThinking, turnText),
                  ),
                  turns,
                  thinkingDurationSeconds:
                    (thinkingDurationMs + now - thinkingStartedAt) / 1_000,
                });
              } catch (error) {
                log("assistant state checkpoint failed", {
                  reason:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }
          } else if (chunk.type === "text") {
            if (thinkingStartedAt !== null) {
              thinkingDurationMs += Date.now() - thinkingStartedAt;
              thinkingStartedAt = null;
              metadata.set(
                "thinkingDurationSeconds",
                thinkingDurationMs / 1_000,
              );
            }
            turnText += chunk.text;
            text += chunk.text;
            textStream.push({
              runId: payload.runId,
              messageId: payload.assistantMessageId,
              sequence: ++textSequence,
              turn: turns,
              text: chunk.text,
            });
            metadata.set("currentStep", "Writing response");
            metadata.set("streamedCharacters", text.length);

            const now = Date.now();
            const checkpointDue =
              !streamStarted ||
              (text.length - checkpointedCharacters >=
                STREAM_CHECKPOINT_CHARACTERS &&
                now >= nextCheckpointAt);

            if (checkpointDue) {
              // Move the deadline before I/O so a temporary database failure
              // does not turn every following token into another write attempt.
              streamStarted = true;
              checkpointedCharacters = text.length;
              nextCheckpointAt = now + STREAM_CHECKPOINT_INTERVAL_MS;

              try {
                await checkpointAssistantState({
                  messageId: payload.assistantMessageId,
                  content: text,
                  blocks: withPartialBlocks(blocks, turnThinking, turnText),
                  reasoning: allThinking(
                    withPartialBlocks(blocks, turnThinking, turnText),
                  ),
                  turns,
                  thinkingDurationSeconds: thinkingDurationMs / 1_000,
                });
              } catch (error) {
                log("assistant text checkpoint failed", {
                  reason:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }
          } else {
            if (thinkingStartedAt !== null) {
              thinkingDurationMs += Date.now() - thinkingStartedAt;
              thinkingStartedAt = null;
            }
            routedModel = chunk.routedModel ?? routedModel;
            // Usage is per model call; the turn total is what the run records.
            usage = addUsage(usage, chunk.usage);
            toolCalls = chunk.toolCalls;
          }
        }

        if (thinkingStartedAt !== null) {
          thinkingDurationMs += Date.now() - thinkingStartedAt;
        }
        if (turnThinking) {
          blocks.push({ type: "thinking", thinking: turnThinking });
        }
        if (turnText) blocks.push({ type: "text", text: turnText });

        if (signal?.aborted || cancellationObserved || toolCalls.length === 0) {
          break;
        }

        conversation.push({
          role: "assistant",
          content: turnText,
          toolCalls,
        });

        for (const call of toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: asRecord(call.input),
          });
        }

        log("tool calls requested", {
          turn: turns,
          tools: toolCalls.map((call) => call.name),
        });

        // A batch needs approval when it would spend credits on calls the user
        // has not already seen. Turns that only read local guidance cost
        // nothing and are never interrupted, which is how the reference product
        // behaves: the card appears for billable work and for nothing else.
        const currentPlan = approvalState?.plan;
        const coveredByPlan =
          currentPlan !== undefined && planCoversCalls(currentPlan, toolCalls);

        if (!coveredByPlan && needsPlanApproval(toolCalls, new Set())) {
          const planned = await safelyBuildCompletePlan({
            provider,
            conversation,
            tools,
            initialCalls: toolCalls,
            signal,
            log,
          });
          routedModel = planned.routedModel ?? routedModel;
          usage = addUsage(usage, planned.usage);
          const fallbackPlan =
            planned.plan ?? (await buildPlanFromCalls(toolCalls));

          if (!fallbackPlan) {
            throw new Error("billable_plan_unavailable");
          }

          const approval = await approveCompletePlan({
            payload,
            provider,
            conversation,
            tools,
            initialCalls: toolCalls,
            initialPlan: fallbackPlan,
            signal,
            log,
          });
          routedModel = approval.routedModel ?? routedModel;
          usage = addUsage(usage, approval.usage);

          if (approval.terminalMessage) {
            for (const call of toolCalls) {
              executionsOf(conversation, call.id, approval.terminalMessage);
            }
            blocks.push({ type: "text", text: approval.terminalMessage });
            text += `\n\n${approval.terminalMessage}`;
            break;
          }

          approvalState = approval.state;

          if (!approvalState) {
            const decisionMessage = "The plan was not approved.";
            // Nothing was dispatched, so nothing needs unwinding. The model is
            // told what the person said and gets another pass at the plan.
            for (const call of toolCalls) {
              executionsOf(conversation, call.id, decisionMessage);
            }

            blocks.push({ type: "text", text: decisionMessage });
            text += `\n\n${decisionMessage}`;
            continue;
          }
        }

        metadata.set("status", "running_tools");
        metadata.set("currentStep", "Running tools");
        activityStream.push({
          type: "progress",
          runId: payload.runId,
          messageId: payload.assistantMessageId,
          sequence: ++activitySequence,
          stage: "running_tools",
          currentStep: toolCalls.map((call) => call.name).join(", "),
          progress: Math.min(0.2 + turns * 0.1, 0.85),
        });
        for (const call of toolCalls) {
          if (!getTool(call.name)) continue;
          activityStream.push({
            type: "tool",
            runId: payload.runId,
            messageId: payload.assistantMessageId,
            sequence: ++activitySequence,
            toolCallId: call.id,
            toolName: call.name,
            state: "RUNNING",
            result: null,
          });
        }
        const approvedExecution = await runApprovedToolCalls({
          payload,
          toolCalls,
          approvalState,
          provider,
          conversation,
          tools,
          signal,
          log,
        });
        approvalState = approvedExecution.approvalState;
        const executions = approvedExecution.executions;

        // Results are appended in the order the model asked for them, not the
        // order they finished, so a replayed conversation is byte-identical.
        for (const call of toolCalls) {
          const execution = executions.get(call.id);
          const parsedResult = ToolResultSchema.safeParse(execution?.result);

          if (getTool(call.name) && execution) {
            activityStream.push({
              type: "tool",
              runId: payload.runId,
              messageId: payload.assistantMessageId,
              sequence: ++activitySequence,
              toolCallId: call.id,
              toolName: call.name,
              state: execution.state,
              result: parsedResult.success ? parsedResult.data : null,
            });

            if (
              parsedResult.success &&
              (parsedResult.data.type === "image" ||
                parsedResult.data.type === "video" ||
                parsedResult.data.type === "audio")
            ) {
              for (const url of parsedResult.data.urls) {
                activityStream.push({
                  type: "asset",
                  runId: payload.runId,
                  messageId: payload.assistantMessageId,
                  sequence: ++activitySequence,
                  toolCallId: call.id,
                  assetType: parsedResult.data.type,
                  url,
                });
              }
            }
          }

          conversation.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify(
              execution?.state === "COMPLETED"
                ? { status: "completed", result: execution.result }
                : {
                    status: execution?.state.toLowerCase() ?? "failed",
                    // The model sees the user-safe copy only; internal codes
                    // stay in our logs and rows.
                    message:
                      execution?.userMessage ?? "That step could not be run.",
                  },
            ),
          });
        }

        if (approvedExecution.terminalMessage) {
          blocks.push({
            type: "text",
            text: approvedExecution.terminalMessage,
          });
          text += `\n\n${approvedExecution.terminalMessage}`;
          break;
        }

        if (signal?.aborted || (await cancellationRequested(payload.runId))) {
          cancellationObserved = true;
          break;
        }

        if (turns === MAX_TURNS) exhausted = true;
      }

      const cancelled = (signal?.aborted ?? false) || cancellationObserved;

      // The ceiling is reported in the transcript, not just in a log. A turn
      // that silently stops mid-plan reads to the user as the model giving up.
      if (exhausted && !cancelled) {
        const notice =
          `I stopped after ${MAX_TURNS} steps without finishing. ` +
          "Everything above already ran. Send a follow-up to continue from here.";

        blocks.push({ type: "text", text: notice });
        text += (text ? "\n\n" : "") + notice;

        log("max turns reached", { turns });
      }

      // OpenRouter Free costs us nothing, but a turn with no ledger entry looks
      // like a turn that did no work. The zero-delta row is where our decision
      // not to bill for the model is visible and auditable.
      if (usage) {
        await recordModelUsage({
          ownerId: payload.userAccountId,
          runId: payload.runId,
          subject: payload.assistantMessageId,
          model: routedModel ?? "openrouter/free",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      }

      // The text channel closes before the durable write so a subscriber stops
      // waiting for deltas and falls back to the persisted message, which is
      // about to become the complete one.
      textStream.close();
      activityStream.push({
        type: "progress",
        runId: payload.runId,
        messageId: payload.assistantMessageId,
        sequence: ++activitySequence,
        stage: "finalizing",
        currentStep: "Saving result",
        progress: 0.95,
      });

      const finalStatus = await persistTurnTerminal(payload, {
        text,
        blocks,
        usage,
        routedModel,
        turns,
        exhausted,
        cancelled,
        thinkingDurationSeconds: thinkingDurationMs / 1_000,
      });

      activityStream.close();

      metadata.set(
        "status",
        finalStatus === "CANCELLED"
          ? "cancelled"
          : finalStatus === "COMPLETED"
            ? "completed"
            : "failed",
      );
      metadata.set("progress", 1);
      metadata.set("currentStep", "Complete");
      log("turn finished", {
        cancelled: finalStatus === "CANCELLED",
        characters: text.length,
        turns,
      });

      return { runId: payload.runId, characters: text.length };
    } catch (error) {
      textStream.close();
      activityStream.close();
      await failRun(payload, error);
      throw error;
    }
  },
});

/**
 * What the loop needs back from a tool call, whichever kind it was.
 *
 * Local and provider tools settle differently — one returns in microseconds
 * with nothing to bill, the other runs for minutes as a child task — but the
 * conversation only cares whether the step worked and what it produced.
 */
type TurnToolResult = {
  state: "COMPLETED" | "FAILED" | "CANCELLED";
  result: unknown;
  userMessage: string | null;
};

/**
 * Claims every call, then runs the ones that need work in parallel.
 *
 * Calls within a single model turn are independent by construction — a chained
 * request produces its second call in a later turn, once the first result is
 * visible — so there is nothing to serialise. Each runs as its own child task
 * and the batch waits for all of them.
 *
 * Claiming happens in this task rather than in the children: the unique index
 * has to settle who owns an execution before any child can spend money on it.
 */
async function runToolCalls(
  payload: AgentTurnPayload,
  toolCalls: ToolCall[],
): Promise<Map<string, TurnToolResult>> {
  const executions = new Map<string, TurnToolResult>();
  const pending: {
    toolCallId: string;
    payload: Parameters<typeof magicaTool.trigger>[0];
    idempotencyKey: string;
  }[] = [];
  const inFlight: { toolCallId: string; invocationId: string }[] = [];

  for (const call of toolCalls) {
    // Local tools read guidance and spend nothing, so they neither claim an
    // execution key nor start a child task. This is the loop's only branch on
    // tool kind, and there is no branch anywhere on tool name.
    const local = getLocalTool(call.name);

    if (local) {
      const outcome = await runLocalTool(local, call.input, {
        runId: payload.runId,
      });

      executions.set(
        call.id,
        outcome.ok
          ? { state: "COMPLETED", result: outcome.output, userMessage: null }
          : {
              state: "FAILED",
              result: null,
              userMessage: outcome.userMessage,
            },
      );

      continue;
    }

    const claim = await claimToolCall({
      runId: payload.runId,
      ownerId: payload.userAccountId,
      messageId: payload.assistantMessageId,
      toolName: call.name,
      toolCallId: call.id,
      rawInput: call.input,
    });

    if (claim.status === "in_flight") {
      inFlight.push({
        toolCallId: call.id,
        invocationId: claim.invocationId,
      });
      continue;
    }

    // A step that could not be afforded is settled, not dispatched. The turn
    // continues so the model can explain the shortfall and whatever already
    // succeeded is preserved.
    if (claim.status !== "claimed") {
      executions.set(call.id, toTurnResult(claim.execution));
      continue;
    }

    pending.push({
      toolCallId: call.id,
      idempotencyKey: executionKeyFor({
        runId: payload.runId,
        toolCallId: call.id,
      }),
      payload: {
        invocationId: claim.invocationId,
        ownerId: payload.userAccountId,
        nodeType: claim.nodeType,
        nodeInput: claim.nodeInput,
        reserved: claim.reserved,
        runId: payload.runId,
        traceId: payload.traceId,
      },
    });
  }

  if (pending.length > 0) {
    const results = await batch.triggerAndWait<typeof magicaTool>(
      pending.map((item) => ({
        id: "magica-tool" as const,
        payload: item.payload,
        // Second layer under our unique index: a redelivered batch must not
        // enqueue the same paid execution twice.
        options: { idempotencyKey: item.idempotencyKey },
      })),
    );

    results.runs.forEach((run, index) => {
      const item = pending[index];

      if (run.ok) {
        executions.set(item.toolCallId, toTurnResult(run.output));
        return;
      }

      // A parent retry joins this non-terminal row. It must not tell the model
      // a paid child failed while that child can still complete.
      logger.error("tool task did not complete", {
        runId: payload.runId,
        invocationId: item.payload.invocationId,
      });
      inFlight.push({
        toolCallId: item.toolCallId,
        invocationId: item.payload.invocationId,
      });
    });
  }

  if (inFlight.length > 0) {
    await joinInFlightTools(payload.runId, inFlight, executions);
  }

  return executions;
}

/** Joins paid children found by a replay without inventing a failed result. */
async function joinInFlightTools(
  runId: string,
  inFlight: { toolCallId: string; invocationId: string }[],
  executions: Map<string, TurnToolResult>,
): Promise<void> {
  const remaining = new Map(
    inFlight.map((item) => [item.invocationId, item.toolCallId]),
  );
  const deadline = Date.now() + 10 * 60 * 1_000;

  while (remaining.size > 0) {
    for (const [invocationId, toolCallId] of remaining) {
      const execution = await readTerminalToolExecution(invocationId);

      if (execution) {
        executions.set(toolCallId, toTurnResult(execution));
        remaining.delete(invocationId);
      }
    }

    if (remaining.size === 0 || (await cancellationRequested(runId))) return;

    if (Date.now() >= deadline) {
      throw new TransientProviderError("tool_execution_still_running");
    }

    // Trigger checkpoints this wait, so joining a child does not occupy the
    // agent worker for the duration of the media run.
    await wait.for({ seconds: 1 });
  }
}

function toTurnResult(execution: ToolExecution): TurnToolResult {
  return {
    state: execution.state,
    result: execution.result,
    userMessage: execution.userMessage,
  };
}

/**
 * Tells the model a tool call was not run, without inventing a result for it.
 *
 * Every requested call needs a matching tool message or the provider rejects
 * the next request as a malformed conversation, so a plan that was declined
 * still has to answer each id.
 */
function executionsOf(
  conversation: AgentMessage[],
  toolCallId: string,
  message: string,
) {
  conversation.push({
    role: "tool",
    toolCallId,
    content: JSON.stringify({ status: "not_run", message }),
  });
}

type ApprovalState = {
  plan: PlanPayload;
  mode: "RUN_ALL" | "STEP_BY_STEP";
  waitpointId: string;
  /** STEP_BY_STEP approval releases exactly one pending billable node. */
  stepReleased: boolean;
};

type PlanDecisionResult = {
  waitpointId: string;
  decision: PlanDecision | null;
  terminalMessage: string | null;
};

/** Pauses on one persisted Trigger token and returns the exact decision. */
async function requestPlanDecision(
  payload: AgentTurnPayload,
  plan: PlanPayload,
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<PlanDecisionResult> {
  const { waitpointId, tokenId } = await createPlanWaitpoint({
    runId: payload.runId,
    plan,
  });

  await prisma.agentRun.update({
    where: { id: payload.runId },
    data: { status: "WAITING" },
  });

  // Realtime carries the card to an open tab; the row is what a reloaded tab
  // reads back from GET /v1/runs/:runId/waitpoint.
  metadata.set("status", "awaiting_approval");
  metadata.set("waitpointId", waitpointId);
  metadata.set("currentStep", "Awaiting plan approval");

  log("plan awaiting approval", {
    waitpointTokenId: tokenId,
    steps: plan.steps.length,
    totalEstimate: plan.totalEstimate,
  });

  // The deadline was set when the token was created, so a plan nobody answers
  // releases this wait as a failure rather than hanging the run forever.
  const result = await wait.forToken<PlanDecision>(tokenId);

  if (!result.ok) {
    // Expiry is terminal. Resuming an hour-old plan on nobody's authority is
    // worse than stopping and telling the user how to continue.
    await expirePlanWaitpoint(waitpointId);

    const resumed = await prisma.agentRun.updateMany({
      where: { id: payload.runId, status: "WAITING" },
      data: { status: "RUNNING" },
    });

    if (resumed.count === 0) {
      return {
        waitpointId,
        decision: null,
        terminalMessage: "This run was cancelled.",
      };
    }

    metadata.set("status", "running");
    metadata.set("currentStep", "Plan approval expired");

    return {
      waitpointId,
      decision: null,
      terminalMessage:
        "This plan expired before it was approved. Send the request again to start over.",
    };
  }

  await acknowledgePlanResolution(waitpointId, result.output);

  const resumed = await prisma.agentRun.updateMany({
    where: { id: payload.runId, status: "WAITING" },
    data: { status: "RUNNING" },
  });

  if (resumed.count === 0) {
    return {
      waitpointId,
      decision: null,
      terminalMessage: "This run was cancelled.",
    };
  }

  metadata.set("status", "running");
  metadata.set("currentStep", "Resuming approved plan");

  return { waitpointId, decision: result.output, terminalMessage: null };
}

/** Rebuilds until user approves or wait expires/cancels. */
async function approveCompletePlan(options: {
  payload: AgentTurnPayload;
  provider: OpenRouterProvider;
  conversation: AgentMessage[];
  tools: ReturnType<typeof agentToolSchemas>;
  initialCalls?: ToolCall[];
  initialPlan: PlanPayload;
  signal?: AbortSignal;
  log: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<{
  state: ApprovalState | null;
  terminalMessage: string | null;
  routedModel: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}> {
  let plan = options.initialPlan;
  let routedModel: string | null = null;
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  while (true) {
    const outcome = await requestPlanDecision(
      options.payload,
      plan,
      options.log,
    );

    if (outcome.terminalMessage) {
      return {
        state: null,
        terminalMessage: outcome.terminalMessage,
        routedModel,
        usage,
      };
    }

    const decision = outcome.decision!;
    if (
      decision.resolution === "RUN_ALL" ||
      decision.resolution === "STEP_BY_STEP"
    ) {
      return {
        state: {
          plan,
          mode: decision.resolution,
          waitpointId: outcome.waitpointId,
          stepReleased: decision.resolution === "STEP_BY_STEP",
        },
        terminalMessage: null,
        routedModel,
        usage,
      };
    }

    const revised = await safelyBuildCompletePlan({
      provider: options.provider,
      conversation: [
        ...options.conversation,
        {
          role: "user",
          content: `Revise this proposed plan:\n${JSON.stringify(plan)}`,
        },
      ],
      tools: options.tools,
      initialCalls: options.initialCalls,
      feedback: decision.feedback,
      signal: options.signal,
      log: options.log,
    });
    routedModel = revised.routedModel ?? routedModel;
    usage = addUsage(usage, revised.usage);
    plan = revised.plan ?? plan;
  }
}

async function safelyBuildCompletePlan(
  options: Parameters<typeof buildCompleteExecutionPlan>[0] & {
    log: (message: string, extra?: Record<string, unknown>) => void;
  },
) {
  const { log, ...plannerOptions } = options;

  try {
    return await buildCompleteExecutionPlan(plannerOptions);
  } catch (error) {
    log("complete plan generation failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { plan: null, routedModel: null, usage: null };
  }
}

function noBillablePlan(): PlanPayload {
  return {
    title: "Plan response",
    overview:
      "Plan mode is on. Review this zero-credit response step before continuing.",
    steps: [
      {
        id: "step_1",
        n: 1,
        toolName: "respond_without_tools",
        title: "Prepare response",
        description: "Answer using available context without a billable tool.",
        dependsOn: [],
        input: {},
        estimateCredits: 0,
        status: "PENDING",
      },
    ],
    totalEstimate: 0,
    notes: "Automatic billable safety approval remains active on every send.",
  };
}

async function runApprovedToolCalls(options: {
  payload: AgentTurnPayload;
  toolCalls: ToolCall[];
  approvalState: ApprovalState | null;
  provider: OpenRouterProvider;
  conversation: AgentMessage[];
  tools: ReturnType<typeof agentToolSchemas>;
  signal?: AbortSignal;
  log: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<{
  executions: Map<string, TurnToolResult>;
  approvalState: ApprovalState | null;
  terminalMessage: string | null;
}> {
  let state = options.approvalState;
  const billableCalls = options.toolCalls.filter((call) => getTool(call.name));

  if (
    billableCalls.length > 0 &&
    (!state || !planCoversCalls(state.plan, billableCalls))
  ) {
    throw new Error("billable_call_not_in_approved_plan");
  }

  if (!state || state.mode === "RUN_ALL") {
    if (state) {
      for (const call of options.toolCalls) {
        if (!getTool(call.name)) continue;
        state = {
          ...state,
          plan: markPlanStep(state.plan, call, "RUNNING"),
        };
      }
      await updatePlanWaitpointPayload(state.waitpointId, state.plan);
    }
    const executions = await runToolCalls(options.payload, options.toolCalls);
    if (state) {
      for (const call of options.toolCalls) {
        const execution = executions.get(call.id);
        if (!getTool(call.name) || !execution) continue;
        state = {
          ...state,
          plan: markPlanStep(
            state.plan,
            call,
            execution.state === "COMPLETED"
              ? "COMPLETED"
              : execution.state === "FAILED"
                ? "FAILED"
                : "SKIPPED",
          ),
        };
      }
      await updatePlanWaitpointPayload(state.waitpointId, state.plan);
    }
    return { executions, approvalState: state, terminalMessage: null };
  }

  const executions = new Map<string, TurnToolResult>();
  for (const call of options.toolCalls) {
    if (getTool(call.name) && !state.stepReleased) {
      const outcome = await requestPlanDecision(
        options.payload,
        state.plan,
        options.log,
      );
      if (outcome.terminalMessage) {
        executions.set(call.id, {
          state: "CANCELLED",
          result: null,
          userMessage: outcome.terminalMessage,
        });
        return {
          executions,
          approvalState: state,
          terminalMessage: outcome.terminalMessage,
        };
      }

      const decision = outcome.decision!;
      if (decision.resolution === "REQUEST_CHANGES") {
        const revised = await safelyBuildCompletePlan({
          provider: options.provider,
          conversation: options.conversation,
          tools: options.tools,
          initialCalls: [call],
          feedback: decision.feedback,
          signal: options.signal,
          log: options.log,
        });
        const approval = await approveCompletePlan({
          ...options,
          initialCalls: [call],
          initialPlan: revised.plan ?? state.plan,
        });
        if (approval.terminalMessage || !approval.state) {
          const message =
            approval.terminalMessage ?? "The plan was not approved.";
          executions.set(call.id, {
            state: "CANCELLED",
            result: null,
            userMessage: message,
          });
          return {
            executions,
            approvalState: approval.state,
            terminalMessage: message,
          };
        }
        state = approval.state;
      } else {
        state = {
          ...state,
          mode: decision.resolution,
          waitpointId: outcome.waitpointId,
          stepReleased: decision.resolution === "STEP_BY_STEP",
        };
      }
    }

    if (getTool(call.name)) {
      if (!planCoversCalls(state.plan, [call])) {
        throw new Error("billable_call_not_in_approved_plan");
      }
      state = {
        ...state,
        plan: markPlanStep(state.plan, call, "RUNNING"),
      };
      await updatePlanWaitpointPayload(state.waitpointId, state.plan);
    }

    const execution = await runToolCalls(options.payload, [call]);
    const result = execution.get(call.id);
    if (result) executions.set(call.id, result);

    if (getTool(call.name) && result) {
      state = {
        ...state,
        plan: markPlanStep(
          state.plan,
          call,
          result.state === "COMPLETED"
            ? "COMPLETED"
            : result.state === "FAILED"
              ? "FAILED"
              : "SKIPPED",
        ),
        stepReleased: state.mode === "RUN_ALL",
      };
      await updatePlanWaitpointPayload(state.waitpointId, state.plan);
    }
  }

  return { executions, approvalState: state, terminalMessage: null };
}

function addUsage(
  total: { inputTokens: number; outputTokens: number } | null,
  next: { inputTokens: number; outputTokens: number } | null,
) {
  if (!next) return total;
  if (!total) return next;

  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

/** Tool input is persisted as a content block, which requires an object. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function withPartialBlocks(
  persisted: ContentBlock[],
  thinking: string,
  text: string,
): ContentBlock[] {
  return [
    ...persisted,
    ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

function allThinking(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
    .join("\n\n");
}

function filenameFromUrl(value: string): string | null {
  try {
    const name = new URL(value).pathname.split("/").filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : null;
  } catch {
    return null;
  }
}

async function cancellationRequested(runId: string): Promise<boolean> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });

  return run?.status === "CANCELLING" || run?.status === "CANCELLED";
}

async function persistTurnTerminal(
  payload: AgentTurnPayload,
  outcome: {
    text: string;
    blocks: ContentBlock[];
    usage: { inputTokens: number; outputTokens: number } | null;
    routedModel: string | null;
    turns: number;
    exhausted: boolean;
    cancelled: boolean;
    thinkingDurationSeconds: number;
  },
) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.agentRun.findUnique({
      where: { id: payload.runId },
      select: { status: true, attempt: true },
    });

    if (!current) return "FAILED" as const;

    // A stale/duplicate Trigger execution cannot resurrect a terminal row or a
    // newer explicit retry attempt.
    if (
      current.attempt !== (payload.attempt ?? 0) ||
      ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)
    ) {
      return current.status;
    }

    const cancelled = outcome.cancelled || current.status === "CANCELLING";
    const status = cancelled ? ("CANCELLED" as const) : ("COMPLETED" as const);
    const updated = await tx.agentRun.updateMany({
      where: {
        id: payload.runId,
        attempt: payload.attempt ?? 0,
        status: { in: ["RUNNING", "WAITING", "CANCELLING"] },
      },
      data: {
        status,
        routedModel: outcome.routedModel,
        turns: outcome.turns,
        errorCode: outcome.exhausted && !cancelled ? "max_turns_reached" : null,
        userMessage: cancelled
          ? "This run was cancelled."
          : outcome.exhausted
            ? `This turn hit the ${MAX_TURNS}-step limit before finishing.`
            : null,
        retryable: !cancelled && outcome.exhausted,
        completedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      const winner = await tx.agentRun.findUnique({
        where: { id: payload.runId },
        select: { status: true },
      });

      return winner?.status ?? ("FAILED" as const);
    }

    const invocations = await tx.toolInvocation.findMany({
      where: { runId: payload.runId, state: "COMPLETED" },
      orderBy: { createdAt: "asc" },
      select: {
        executionKey: true,
        toolName: true,
        result: true,
        sanitizedInput: true,
        creditUsed: true,
      },
    });
    const assets = invocations.flatMap((invocation) => {
      const result = ToolResultSchema.safeParse(invocation.result);
      if (
        !result.success ||
        (result.data.type !== "image" &&
          result.data.type !== "video" &&
          result.data.type !== "audio")
      ) {
        return [];
      }
      const media = result.data;

      const input = asRecord(invocation.sanitizedInput);
      const prompt = typeof input.prompt === "string" ? input.prompt : null;
      const toolCallId = invocation.executionKey.startsWith(`${payload.runId}:`)
        ? invocation.executionKey.slice(payload.runId.length + 1)
        : null;

      return media.urls.map((url) =>
        AssetSchema.parse({
          type: media.type,
          url,
          model: invocation.toolName,
          mode: media.type,
          creditUsed: invocation.creditUsed,
          toolCallId,
          prompt,
          filename: filenameFromUrl(url),
          metadata: {
            mimeType: media.mimeType,
            width: media.type === "image" ? media.width : null,
            height: media.type === "image" ? media.height : null,
            fileSize: null,
          },
        }),
      );
    });

    await tx.message.updateMany({
      where: {
        id: payload.assistantMessageId,
        status: { in: ["PENDING", "STREAMING"] },
      },
      data: {
        content: outcome.text,
        contentBlocks:
          outcome.blocks.length > 0 ? (outcome.blocks as never) : undefined,
        reasoning: allThinking(outcome.blocks) || null,
        assets: assets.length > 0 ? (assets as never) : undefined,
        status: cancelled ? "CANCELLED" : "SUCCESS",
        tokenUsage: outcome.usage ?? undefined,
        aiModel: outcome.routedModel
          ? {
              id: outcome.routedModel,
              name: outcome.routedModel,
              provider: "openrouter",
            }
          : undefined,
        metadata: {
          turns: outcome.turns,
          maxTurnsReached: outcome.exhausted,
          thinkingDurationSeconds: outcome.thinkingDurationSeconds,
        },
      },
    });

    return status;
  });
}

/**
 * Rebuilds the prompt from persisted rows.
 *
 * The assistant placeholder for this run is excluded — it is the row we are
 * about to fill, and feeding an empty assistant turn back to the model corrupts
 * the conversation on every retry.
 */
async function restoreConversation(
  chatId: string,
  assistantMessageId: string,
): Promise<AgentMessage[]> {
  const rows = await prisma.message.findMany({
    where: {
      chatId,
      id: { not: assistantMessageId },
      status: { in: ["SUCCESS", "STREAMING"] },
    },
    orderBy: { sequence: "desc" },
    take: MAX_CONTEXT_MESSAGES,
    select: { role: true, content: true },
  });

  return selectBoundedConversation(rows);
}

/**
 * Records a failure the UI can explain on its own.
 *
 * `errorCode` keeps the internal detail for logs; `userMessage` is what the
 * client renders. Keeping them apart is what stops a stack trace reaching a
 * chat bubble.
 */
async function failRun(payload: AgentTurnPayload, error: unknown) {
  const isEmptyStream = error instanceof EmptyStreamError;
  const isTimeout = error instanceof Error && error.name === "TimeoutError";
  const errorCode = isEmptyStream
    ? "empty_stream"
    : error instanceof Error
      ? error.message.slice(0, 120)
      : "unknown_error";

  // Retryability comes from the provider layer's own classification rather than
  // from matching on message text here. Offering a retry that is certain to
  // fail the same way is worse than offering none, and the layer that made the
  // request is the one that knows which it was.
  const retryable =
    isEmptyStream ||
    isTimeout ||
    (error instanceof TransientProviderError &&
      !(error instanceof PermanentProviderError));

  const userMessage = isEmptyStream
    ? "The model returned an empty response. Try sending the message again."
    : isTimeout
      ? "This turn took longer than expected. You can retry it safely."
      : retryable
        ? "The model provider was unavailable. You can retry this turn."
        : "This turn failed before it finished.";

  logger.error("turn failed", {
    chatId: payload.chatId,
    runId: payload.runId,
    traceId: payload.traceId,
    errorCode,
  });

  const finalStatus = await prisma.$transaction(async (tx) => {
    const current = await tx.agentRun.findUnique({
      where: { id: payload.runId },
      select: { status: true, attempt: true },
    });

    if (!current) return "FAILED" as const;

    if (current.status === "CANCELLING") {
      await tx.agentRun.updateMany({
        where: { id: payload.runId, status: "CANCELLING" },
        data: {
          status: "CANCELLED",
          userMessage: "This run was cancelled.",
          retryable: false,
          completedAt: new Date(),
        },
      });
      await tx.message.updateMany({
        where: {
          id: payload.assistantMessageId,
          status: { in: ["PENDING", "STREAMING"] },
        },
        data: { status: "CANCELLED" },
      });

      return "CANCELLED" as const;
    }

    if (
      current.attempt !== (payload.attempt ?? 0) ||
      ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)
    ) {
      return current.status;
    }

    const updated = await tx.agentRun.updateMany({
      where: {
        id: payload.runId,
        attempt: payload.attempt ?? 0,
        status: { in: ["QUEUED", "RUNNING", "WAITING"] },
      },
      data: {
        status: "FAILED",
        errorCode,
        userMessage,
        retryable,
        completedAt: new Date(),
      },
    });

    if (updated.count > 0) {
      await tx.message.updateMany({
        where: {
          id: payload.assistantMessageId,
          status: { in: ["PENDING", "STREAMING"] },
        },
        data: { status: "FAILED" },
      });
    }

    return "FAILED" as const;
  });

  metadata.set(
    "status",
    finalStatus === "CANCELLED"
      ? "cancelled"
      : finalStatus === "COMPLETED"
        ? "completed"
        : "failed",
  );
  metadata.set(
    "currentStep",
    finalStatus === "CANCELLED" ? "Cancelled" : "Failed",
  );
}
