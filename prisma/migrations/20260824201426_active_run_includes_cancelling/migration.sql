-- A run that has been asked to stop is still active: a new send must not start
-- until it reaches a terminal state, or two runs would stream into one chat.
DROP INDEX IF EXISTS "AgentRun_one_active_per_chat";

CREATE UNIQUE INDEX "AgentRun_one_active_per_chat"
  ON "AgentRun" ("chatId")
  WHERE status IN ('QUEUED', 'RUNNING', 'WAITING', 'CANCELLING');
