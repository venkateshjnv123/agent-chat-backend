import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./trigger"],
  maxDuration: 300,
  machine: "small-1x",
  retries: {
    enabledInDev: false,
    default: {
      // AgentRun owns retry state. Platform retry would expose FAILED between
      // attempts and release the one-run lock while another attempt is alive.
      maxAttempts: 1,
      factor: 2,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 10_000,
      randomize: true,
    },
  },
});
