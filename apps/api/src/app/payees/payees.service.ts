import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/** Prisma's unique-constraint violation. */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

@Injectable()
export class PayeesService {
  /**
   * NeoBank is modelled as a single-branch bank, so one IFSC identifies it.
   * A real multi-branch bank carries IFSC on the Account, not in config —
   * worth an ADR line in Phase 6.
   */

  private readonly bankIfsc = (process.env.BANK_IFSC ?? 'NEOB0000001').toUpperCase();

  constructor(private readonly prisma: PrismaService) { }

  async verify(accountNumber: string, ifsc: string) {
    if (ifsc.toUpperCase() !== this.bankIfsc) {
      throw new NotFoundException('account not found');
    }

    const account = await this.prisma.account.findUnique({
      where: { accountNumber },
      select: { accountNumber: true, user: { select: { fullName: true } } },
    });

    if (!account) throw new NotFoundException('account not found');

    return {
      accountNumber: account.accountNumber,
      beneficiaryName: account.user.fullName
    };
  }

  async create(userId: string, accountNumber: string, ifsc: string) {
    const verified = await this.verify(accountNumber, ifsc);

    try {
      return await this.prisma.payee.create({
        data: {
          userId,
          name: verified.beneficiaryName,
          accountNumber: verified.accountNumber,
          ifsc: this.bankIfsc
        },
      });
    }
    catch (e) {
      // Catching P2002 rather than checking-then-inserting: a findFirst guard
      // has a race window between the read and the write. Let the database's
      // unique constraint be the authority, exactly as the balance check lets
      // the atomic updateMany be the authority.
      if (isUniqueViolation(e)) {
        throw new ConflictException('payee already added');
      }
      throw e;
    }
  }

  list(userId: string) {
    return this.prisma.payee.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async remove(userId: string, id: string) {
    // deleteMany with userId in the where-clause: ownership is enforced by the
    // delete itself, so there is no read to race against.
    const result = await this.prisma.payee.deleteMany({
      where: { id, userId }
    });

    if (result.count === 0) throw new NotFoundException('payee not found');
  }

  /** Resolve a payee to a live destination account. Used by transfers. */
  async resolveDestination(userId: string, payeeId: string) {
    const payee = await this.prisma.payee.findFirst({
      where: { id: payeeId, userId }
    });

    if (!payee) throw new NotFoundException('payee not found');

    const destination = await this.prisma.account.findUnique({
      where: { accountNumber: payee.accountNumber },
      select: { id: true }
    });

    // A payee whose account has since vanished is a real state, not a bug.
    if (!destination) throw new BadRequestException('payee account is no longer active');

    return { accountId: destination.id, name: payee.name, accountNumber: payee.accountNumber };
  }
}
