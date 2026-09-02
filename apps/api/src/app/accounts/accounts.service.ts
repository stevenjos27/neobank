import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Role } from "@neobank/prisma";
import { ListTransactionsQueryDto } from "./dto/list-transactions.dto";
import { decodeCursor, encodeCursor } from "./cursor";
import { PayeesService } from "../payees/payees.service";

export type TransferInput = {
  fromAccountId: string;
  toAccountId?: string;
  payeeId?: string;
  amountPaise: bigint;
  description?: string;
};

const mask = (accountNumber: string) => `...${accountNumber.slice(-4)}`;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payees: PayeesService
  ) { }

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

  async transfer(userId: string, input: TransferInput) {
    const { fromAccountId, toAccountId, payeeId, amountPaise, description } = input;

    if (amountPaise <= 0n) throw new BadRequestException('amount must be positive');

    // Exactly one destination. `toAccountId` now means a self-transfer between
    // your own accounts; anything going to a third party must go through a payee
    // that was verified and recorded. This removes the old unrestricted path
    // where any account UUID in the system was a valid destination.

    const destinationsGiven = (toAccountId ? 1 : 0) + (payeeId ? 1 : 0);
    if (destinationsGiven !== 1) {
      throw new BadRequestException('provide exactly one of toAccountId or payeeId')
    }

    // ---- resolution phase: OUTSIDE the transaction ----------------------------
    // Everything here is either a lookup that decides *where* money goes or a
    // read used only for labelling. Authorisation is NOT done here — it stays in
    // the atomic updateMany where-clauses below, so there is no read-then-write
    // race. Reads for labels are fine; reads for permission are not.

    const sender = await this.prisma.account.findFirst({
      where: { id: fromAccountId, userId },
      select: { accountNumber: true, user: { select: { fullName: true } } },
    });
    if (!sender) throw new NotFoundException('account not found');

    let destinationId: string;
    let destinationIsOwn: boolean;
    let outDescription: string;
    let inDescription: string;

    if (payeeId) {
      const payee = await this.payees.resolveDestination(userId, payeeId);
      destinationId = payee.accountId;
      destinationIsOwn = false;
      // Server-authored on BOTH legs so each side's ledger names the other
      // party correctly. Previously the payer's description was written into
      // the recipient's row too — at best unhelpful, at worst a channel for
      // writing arbitrary text into someone else's bank statement.
      outDescription = `Transfer to ${payee.name} (${mask(payee.accountNumber)})`;
      inDescription = `Transfer from ${sender.user.fullName} (${mask(sender.accountNumber)})`;
    }
    else {
      destinationId = toAccountId as string;
      destinationIsOwn = true;
      outDescription = input.description ?? 'Transfer between own accounts';
      inDescription = outDescription;
    }

    if (fromAccountId === destinationId) {
      throw new BadRequestException('cannot transfer to the same account');
    }

    //---- money phase: everything below is atomic -----
    return this.prisma.$transaction(async (tx) => {
      const debited = await tx.account.updateMany({
        where: { id: fromAccountId, balancePaise: { gte: amountPaise }, userId },
        data: { balancePaise: { decrement: amountPaise } },
      });

      if (debited.count === 0) {
        throw new BadRequestException('insufficient funds or account not found');
      }

      const credited = await tx.account.updateMany({
        // For a self-transfer the destination must also be yours, and that
        // ownership check rides in the SAME where-clause as the credit — no
        // extra query, no window between checking and crediting. For a payee
        // transfer there is deliberately no userId: the whole point is that it
        // belongs to someone else, and it was verified when the payee was added.
        where: { id: destinationId, ...(destinationIsOwn ? { userId } : {}) },
        data: { balancePaise: { increment: amountPaise } },
      });

      if (credited.count === 0) {
        throw new NotFoundException('destination account not found');
      }

      await tx.transaction.createMany({
        data: [
          {
            accountId: fromAccountId,
            type: 'TRANSFER_OUT',
            amountPaise,
            description: outDescription
          },
          {
            accountId: destinationId,
            type: 'TRANSFER_IN',
            amountPaise,
            description: inDescription
          },
        ],
      });

      return { status: 'ok', fromAccountId, toAccountId: destinationId, amountPaise };
    });
  }

  async listAccounts(userId: string, role: Role) {
    if (role === 'ADMIN')
      return this.prisma.account.findMany();
    return this.prisma.account.findMany({ where: { userId } });
  }

  async listTransactions(
    accountId: string,
    userId: string,
    query: ListTransactionsQueryDto
  ) {
    await this.getAccount(accountId, userId);

    const { limit } = query;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.transaction.findMany({
      where: {
        accountId,
        ...(cursor && {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items,
      nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
    };
  }
}
