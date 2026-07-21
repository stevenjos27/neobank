import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) { }

  async createAccount(userId: string, type: 'SAVINGS' | 'CURRENT') {
    const accountNumber = String(Math.floor(100000000000 + Math.random() * 900000000000));

    return this.prisma.account.create({
      data: { userId, type, accountNumber },
    });
  }

  async getAccount(id: string) {
    return this.prisma.account.findUniqueOrThrow({ where: { id } });
  }

  async deposit(accountId: string, amountPaise: bigint, description?: string) {
    if (amountPaise <= 0n) {
      throw new BadRequestException('amount must be positive');
    }

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.update({
        where: { id: accountId },
        data: { balancePaise: { increment: amountPaise } },
      });
      await tx.transaction.create({
        data: { accountId, type: 'DEPOSIT', amountPaise, description },
      });
      return account;
    });
  }

  async transfer(fromAccountId: string, toAccountId: string, amountPaise: bigint, description?: string) {
    if (amountPaise <= 0n) throw new BadRequestException('amount must be positive');
    if (fromAccountId === toAccountId) throw new BadRequestException('cannot transfer to the same account');

    return this.prisma.$transaction(async (tx) => {
      const debited = await tx.account.updateMany({
        where: { id: fromAccountId, balancePaise: { gte: amountPaise } },
        data: { balancePaise: { decrement: amountPaise } },
      });

      if (debited.count === 0) {
        throw new BadRequestException('insufficient funds or account not found');
      }

      await tx.account.update({
        where: { id: toAccountId },
        data: { balancePaise: { increment: amountPaise } },
      });

      await tx.transaction.createMany({
        data: [
          { accountId: fromAccountId, type: 'TRANSFER_OUT', amountPaise, description },
          { accountId: toAccountId, type: 'TRANSFER_IN', amountPaise, description },
        ],
      });

      return { status: 'ok', fromAccountId, toAccountId, amountPaise };
    });
  }

  async listAccounts() {
    return this.prisma.account.findMany();
  }
}
