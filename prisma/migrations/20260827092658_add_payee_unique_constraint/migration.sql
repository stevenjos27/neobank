/*
  Warnings:

  - A unique constraint covering the columns `[userId,accountNumber]` on the table `Payee` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Payee_userId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Payee_userId_accountNumber_key" ON "Payee"("userId", "accountNumber");
