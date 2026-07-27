import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Role } from "@neobank/prisma";

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) { }

  async createAccount(userId: string, type: 'SAVINGS' | 'CURRENT') {
    const accountNumber = String(Math.floor(100000000000 + Math.random() * 900000000000));

    return this.prisma.account.create({
      data: { userId, type, accountNumber },
    });
  }

  async getAccount(id: string, userId: string) {
    const account = await this.prisma.account.findFirst({ where: { id, userId } });
    if (!account) throw new NotFoundException('account not found');
    return account;
  }

  async deposit(userId: string, accountId: string, amountPaise: bigint, description?: string) {
    if (amountPaise <= 0n) {
      throw new BadRequestException('amount must be positive');
    }

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.updateMany({
        where: { id: accountId, userId },
        data: { balancePaise: { increment: amountPaise } },
      });

      if (account.count === 0) throw new NotFoundException('account not found');

      await tx.transaction.create({
        data: { accountId, type: 'DEPOSIT', amountPaise, description },
      });
      return tx.account.findUniqueOrThrow({ where: { id: accountId } });
    });
  }

  async transfer(userId: string, fromAccountId: string, toAccountId: string, amountPaise: bigint, description?: string) {
    if (amountPaise <= 0n) throw new BadRequestException('amount must be positive');
    if (fromAccountId === toAccountId) throw new BadRequestException('cannot transfer to the same account');

    return this.prisma.$transaction(async (tx) => {
      const debited = await tx.account.updateMany({
        where: { id: fromAccountId, balancePaise: { gte: amountPaise }, userId },
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

  async listAccounts(userId: string, role: Role) {
    if (role === 'ADMIN')
      return this.prisma.account.findMany();
    return this.prisma.account.findMany({ where: { userId } });
  }
}
