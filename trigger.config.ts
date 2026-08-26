import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_adiutmpaxdmidlmnvxky",
  dirs: ["./trigger"],
  // Match production locally: process.cwd() is the build root, where the
  // additional-files extension preserves the repository-relative path.
  legacyDevProcessCwdBehaviour: false,
  build: {
    extensions: [additionalFiles({ files: ["./agent-skills/**"] })],
  },
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
