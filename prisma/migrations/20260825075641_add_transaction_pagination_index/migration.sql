-- DropIndex
DROP INDEX "Transaction_accountId_idx";

-- CreateIndex
CREATE INDEX "Transaction_accountId_createdAt_id_idx" ON "Transaction"("accountId", "createdAt" DESC, "id" DESC);
