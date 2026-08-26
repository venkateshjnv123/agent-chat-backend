import { metadata } from "@trigger.dev/sdk";

import {
  ASSISTANT_TEXT_STREAM,
  type AssistantTextDelta,
} from "@/contracts/realtime";

export type TextStream = {
  /** Publishes one delta. Cheap enough to call per token. */
  push: (delta: AssistantTextDelta) => void;
  /** Ends the stream so a subscriber stops waiting for more. */
  close: () => void;
};

/**
 * Opens the run's assistant-text stream.
 *
 * Trigger streams are registered once per run and read by the browser through
 * `useRealtimeRunWithStreams`, which is what makes token-by-token rendering
 * possible without polling. Run metadata still carries status and progress: the
 * two channels stay separate so a slow reader of one cannot stall the other.
 *
 * Failing to open a stream must never fail the turn. If registration throws —
 * an older worker, a transport problem — the turn still runs and the client
 * still reconciles from the persisted message, only without live text.
 */
export async function openAssistantTextStream(
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<TextStream> {
  let controller: ReadableStreamDefaultController<AssistantTextDelta> | null =
    null;
  let closed = false;

  const source = new ReadableStream<AssistantTextDelta>({
    start(streamController) {
      controller = streamController;
    },
  });

  try {
    await metadata.stream(ASSISTANT_TEXT_STREAM, source);
  } catch (error) {
    log("assistant text stream unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });

    return { push: () => {}, close: () => {} };
  }

  return {
    push: (delta) => {
      if (closed) return;

      try {
        controller?.enqueue(delta);
      } catch {
        // A closed or errored stream is not a reason to abandon the turn.
        closed = true;
      }
    },
    close: () => {
      if (closed) return;

      closed = true;

      try {
        controller?.close();
      } catch {
        // Already closed by the platform when the run finished.
      }
    },
  };
}
