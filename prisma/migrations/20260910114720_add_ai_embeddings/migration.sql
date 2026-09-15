-- CreateTable
CREATE TABLE "TransactionEnrichment" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "category" TEXT,
    "confidence" DOUBLE PRECISION,
    "modelVersion" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "source" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "embedding" vector(1536),
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEnrichment_transactionId_key" ON "TransactionEnrichment"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_source_chunkIndex_key" ON "KnowledgeChunk"("source", "chunkIndex");

-- AddForeignKey
ALTER TABLE "TransactionEnrichment" ADD CONSTRAINT "TransactionEnrichment_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HNSW: approximate nearest-neighbour, the right index for vector search.
-- vector_cosine_ops because OpenAI embeddings are L2-normalised, which makes
-- cosine the meaningful distance. Using the wrong opclass silently returns
-- poor matches rather than erroring — the index still "works".
CREATE INDEX "TransactionEnrichment_embedding_hnsw"
  ON "TransactionEnrichment" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX "KnowledgeChunk_embedding_hnsw"
  ON "KnowledgeChunk" USING hnsw (embedding vector_cosine_ops);
