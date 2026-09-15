-- RENAME, not drop-and-add.
--
-- Prisma's generated migration for a renamed field is a DROP COLUMN followed
-- by an ADD COLUMN, because the schema diff cannot tell a rename from "one
-- field removed, another added". On this table that would silently orphan
-- every vector already embedded: the column holding "which model produced
-- this embedding" would come back NULL for all 249 rows, the next ingest run
-- would see them as never-embedded, and you would pay to re-embed the lot
-- while believing the migration was free.
--
-- Locally that costs nothing, because `db:reset` replays from scratch. In
-- production it is the difference between a rename and a data-loss incident.
ALTER TABLE "TransactionEnrichment" RENAME COLUMN "modelVersion" TO "embeddingModelVersion";

-- Nullable now that the two enrichment passes are independent: the
-- categoriser can create a row before the embedder has ever seen it.
ALTER TABLE "TransactionEnrichment" ALTER COLUMN "embeddingModelVersion" DROP NOT NULL;

ALTER TABLE "TransactionEnrichment" ADD COLUMN "categoryModelVersion" TEXT;
