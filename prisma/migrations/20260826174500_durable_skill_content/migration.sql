-- New loads persist the immutable body. Existing rows remain nullable because
-- their historical content cannot be reconstructed from a hash alone.
ALTER TABLE "RunSkill" ADD COLUMN "content" TEXT;
