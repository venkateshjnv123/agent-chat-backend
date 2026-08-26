-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Chat_userId_pinned_updatedAt_id_idx" ON "Chat"("userId", "pinned", "updatedAt", "id");

-- ILIKE '%term%' needs trigram indexes; a plain btree cannot serve it. Neon
-- supports pg_trgm and CREATE EXTENSION is idempotent for shared databases.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Chat_title_search_idx"
ON "Chat" USING GIN ("title" gin_trgm_ops)
WHERE "deletedAt" IS NULL;

CREATE INDEX "Message_content_search_idx"
ON "Message" USING GIN ("content" gin_trgm_ops);
