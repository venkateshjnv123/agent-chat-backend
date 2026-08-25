import { z } from "zod";

import { listLocalTools } from "@/skills/tools";
import { toOpenRouterTools, type OpenRouterTool } from "@/tools/registry";

/**
 * The full tool surface the model sees, from both registries.
 *
 * There are two kinds of tool and exactly two: local tools run in process and
 * spend nothing, provider tools dispatch to Magica and are billed. The agent
 * loop branches on that distinction once. It never branches on a tool's name,
 * which is what keeps a hundred tools the same amount of orchestration code as
 * four.
 *
 * Local tools are listed first so the model reads about loading guidance before
 * it reads about doing work.
 */
export function agentToolSchemas(): OpenRouterTool[] {
  const local: OpenRouterTool[] = listLocalTools().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.input, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>,
    },
  }));

  return [...local, ...toOpenRouterTools()];
}
