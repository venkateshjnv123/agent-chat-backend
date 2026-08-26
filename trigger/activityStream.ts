import { metadata } from "@trigger.dev/sdk";

import {
  ASSISTANT_ACTIVITY_STREAM,
  AgentActivityEventSchema,
  type AgentActivityEvent,
} from "@/contracts/realtime";

export type ActivityStream = {
  push: (event: AgentActivityEvent) => void;
  close: () => void;
};

/** Best-effort typed lifecycle stream parallel to assistant text. */
export async function openAgentActivityStream(
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<ActivityStream> {
  let controller: ReadableStreamDefaultController<AgentActivityEvent> | null =
    null;
  let closed = false;
  const source = new ReadableStream<AgentActivityEvent>({
    start(streamController) {
      controller = streamController;
    },
  });

  try {
    await metadata.stream(ASSISTANT_ACTIVITY_STREAM, source);
  } catch (error) {
    log("assistant activity stream unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { push: () => {}, close: () => {} };
  }

  return {
    push: (event) => {
      if (closed) return;
      try {
        controller?.enqueue(AgentActivityEventSchema.parse(event));
      } catch {
        closed = true;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        // Platform may already have closed completed run streams.
      }
    },
  };
}
