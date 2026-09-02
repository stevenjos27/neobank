import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Role } from '@neobank/prisma';
import { AccountsService } from './accounts.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PayeesService } from '../payees/payees.service';
import { decodeCursor, encodeCursor } from './cursor';

/** Realistic ids — the cursor decoder validates UUID shape, so `tx-1` would be rejected. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Ledger rows newest-first, one minute apart — the shape findMany really returns. */
const ledgerRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: uuid(i),
    accountId: 'a',
    type: 'DEPOSIT' as const,
    amountPaise: 100n,
    description: `txn ${i}`,
    createdAt: new Date(Date.UTC(2026, 7, 25, 12, 0, 0) - i * 60_000),
  }));

describe('AccountsService', () => {
  let service: AccountsService;

  let prisma: {
    $transaction: jest.Mock;
    account: { create: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    transaction: { findMany: jest.Mock };
  };

  let payees: { resolveDestination: jest.Mock };

  const tx = {
    account: {
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    transaction: {
      create: jest.fn(),
      createMany: jest.fn(),
    },
  };

  /** The caller owns account 'a'. Needed by listTransactions AND by transfer. */
  const ownsAccount = () =>
    prisma.account.findFirst.mockResolvedValue({ id: 'a', userId: 'u1' });

  /** transfer() reads the sender for labelling only — this is that read. */
  const senderIs = (fullName = 'Steven Joseph', accountNumber = '900000000002') =>
    prisma.account.findFirst.mockResolvedValue({
      accountNumber,
      user: { fullName },
    });

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      $transaction: jest.fn(
        async (fn: (transactionClient: typeof tx) => unknown) => fn(tx),
      ),
      account: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
      transaction: { findMany: jest.fn() },
    };

    payees = { resolveDestination: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PayeesService, useValue: payees },
      ],
    }).compile();

    service = module.get(AccountsService);
  });

  // ──────────────────────────────────────────────────────────────── transfer

  describe('transfer — input validation', () => {
    it('rejects a non-positive amount', async () => {
      await expect(
        service.transfer('u1', { fromAccountId: 'a', toAccountId: 'b', amountPaise: 0n }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when NEITHER destination is given', async () => {
      await expect(
        service.transfer('u1', { fromAccountId: 'a', amountPaise: 100n }),
      ).rejects.toThrow('exactly one of toAccountId or payeeId');
    });

    it('rejects when BOTH destinations are given', async () => {
      await expect(
        service.transfer('u1', {
          fromAccountId: 'a',
          toAccountId: 'b',
          payeeId: 'p1',
          amountPaise: 100n,
        }),
      ).rejects.toThrow('exactly one of toAccountId or payeeId');
    });

    it('404s an unowned source account and never opens a transaction', async () => {
      prisma.account.findFirst.mockResolvedValue(null);

      await expect(
        service.transfer('u1', { fromAccountId: 'a', toAccountId: 'b', amountPaise: 100n }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a transfer to the same account', async () => {
      senderIs();
      await expect(
        service.transfer('u1', { fromAccountId: 'a', toAccountId: 'a', amountPaise: 100n }),
      ).rejects.toThrow('cannot transfer to the same account');
    });

    it('rejects a payee that resolves back to the source account', async () => {
      senderIs();
      payees.resolveDestination.mockResolvedValue({
        accountId: 'a', // same as fromAccountId
        name: 'Priya Nair',
        accountNumber: '900000000004',
      });

      // Resolution happens before the same-account check for exactly this case:
      // a payee is an indirection, and indirection can point home.
      await expect(
        service.transfer('u1', { fromAccountId: 'a', payeeId: 'p1', amountPaise: 100n }),
      ).rejects.toThrow('cannot transfer to the same account');
    });
  });

  describe('transfer — self transfer (toAccountId)', () => {
    it('requires the DESTINATION to be yours, in the same atomic where-clause', async () => {
      senderIs();
      tx.account.updateMany.mockResolvedValue({ count: 1 });

      await service.transfer('u1', {
        fromAccountId: 'a',
        toAccountId: 'b',
        amountPaise: 100n,
      });

      expect(tx.account.updateMany).toHaveBeenCalledWith({
        where: { id: 'a', balancePaise: { gte: 100n }, userId: 'u1' },
        data: { balancePaise: { decrement: 100n } },
      });

      // userId on the CREDIT is the new restriction: toAccountId used to accept
      // any account UUID in the system.
      expect(tx.account.updateMany).toHaveBeenCalledWith({
        where: { id: 'b', userId: 'u1' },
        data: { balancePaise: { increment: 100n } },
      });
    });

    it('rejects insufficient funds and never credits or writes a ledger row', async () => {
      senderIs();
      tx.account.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.transfer('u1', { fromAccountId: 'a', toAccountId: 'b', amountPaise: 100n }),
      ).rejects.toThrow('insufficient funds');

      expect(tx.account.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.transaction.createMany).not.toHaveBeenCalled();
    });

    it('404s when the destination does not exist, and rolls back', async () => {
      senderIs();
      tx.account.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(
        service.transfer('u1', { fromAccountId: 'a', toAccountId: 'ghost', amountPaise: 100n }),
      ).rejects.toThrow(NotFoundException);

      expect(tx.transaction.createMany).not.toHaveBeenCalled();
    });

    it('uses the caller\'s description on both legs', async () => {
      senderIs();
      tx.account.updateMany.mockResolvedValue({ count: 1 });

      await service.transfer('u1', {
        fromAccountId: 'a',
        toAccountId: 'b',
        amountPaise: 100n,
        description: 'moving savings',
      });

      expect(tx.transaction.createMany).toHaveBeenCalledWith({
        data: [
          { accountId: 'a', type: 'TRANSFER_OUT', amountPaise: 100n, description: 'moving savings' },
          { accountId: 'b', type: 'TRANSFER_IN', amountPaise: 100n, description: 'moving savings' },
        ],
      });
    });
  });

  describe('transfer — payee transfer (payeeId)', () => {
    const resolvesToPriya = () =>
      payees.resolveDestination.mockResolvedValue({
        accountId: 'b',
        name: 'Priya Nair',
        accountNumber: '900000000004',
      });

    it('credits WITHOUT an ownership clause — the point is that it is not yours', async () => {
      senderIs();
      resolvesToPriya();
      tx.account.updateMany.mockResolvedValue({ count: 1 });

      await service.transfer('u1', { fromAccountId: 'a', payeeId: 'p1', amountPaise: 100n });

      expect(payees.resolveDestination).toHaveBeenCalledWith('u1', 'p1');
      expect(tx.account.updateMany).toHaveBeenCalledWith({
        where: { id: 'b' }, // no userId
        data: { balancePaise: { increment: 100n } },
      });
    });

    it('authors BOTH descriptions server-side, naming the other party on each leg', async () => {
      senderIs('Steven Joseph', '900000000002');
      resolvesToPriya();
      tx.account.updateMany.mockResolvedValue({ count: 1 });

      await service.transfer('u1', {
        fromAccountId: 'a',
        payeeId: 'p1',
        amountPaise: 100n,
        description: 'IGNORE ME — client supplied',
      });

      const [outLeg, inLeg] = tx.transaction.createMany.mock.calls[0][0].data;

      // The payer's text is discarded. It used to be written verbatim into the
      // recipient's ledger, which let one user put arbitrary text on another
      // user's statement.
      expect(outLeg.description).toBe('Transfer to Priya Nair (...0004)');
      expect(inLeg.description).toBe('Transfer from Steven Joseph (...0002)');
      expect(outLeg.description).not.toContain('IGNORE ME');
      expect(inLeg.description).not.toContain('IGNORE ME');
    });

    it('does not open a transaction when the payee cannot be resolved', async () => {
      senderIs();
      payees.resolveDestination.mockRejectedValue(new NotFoundException('payee not found'));

      await expect(
        service.transfer('u1', { fromAccountId: 'a', payeeId: 'nope', amountPaise: 100n }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────── deposit

  describe('deposit', () => {
    it('rejects a non-positive amount', async () => {
      await expect(service.deposit('u1', 'a', 0n)).rejects.toThrow(BadRequestException);
    });

    it('404s on an unowned or missing account and writes no ledger row', async () => {
      tx.account.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.deposit('u1', 'a', 100n)).rejects.toThrow(NotFoundException);
      expect(tx.transaction.create).not.toHaveBeenCalled();
    });

    it('increments only the owned account and writes one ledger row', async () => {
      tx.account.updateMany.mockResolvedValue({ count: 1 });
      tx.account.findUniqueOrThrow.mockResolvedValue({ id: 'a', balancePaise: 100n });

      await service.deposit('u1', 'a', 100n, 'top-up');

      expect(tx.account.updateMany).toHaveBeenCalledWith({
        where: { id: 'a', userId: 'u1' },
        data: { balancePaise: { increment: 100n } },
      });
      expect(tx.transaction.create).toHaveBeenCalledWith({
        data: { accountId: 'a', type: 'DEPOSIT', amountPaise: 100n, description: 'top-up' },
      });
    });
  });

  // ──────────────────────────────────────────────────────── listTransactions

  describe('listTransactions', () => {
    it('404s for an account that is not yours, without querying transactions', async () => {
      prisma.account.findFirst.mockResolvedValue(null);

      await expect(service.listTransactions('a', 'u1', { limit: 50 }))
        .rejects.toThrow(NotFoundException);

      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
    });

    it('orders newest-first with a total ordering, so pages cannot overlap', async () => {
      ownsAccount();
      prisma.transaction.findMany.mockResolvedValue([]);

      await service.listTransactions('a', 'u1', { limit: 50 });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
    });

    it('returns nextCursor: null when the page is not full', async () => {
      ownsAccount();
      const rows = ledgerRows(3);
      prisma.transaction.findMany.mockResolvedValue(rows);

      const result = await service.listTransactions('a', 'u1', { limit: 50 });

      expect(result.items).toHaveLength(3);
      expect(result.items).toEqual(rows);
      expect(result.nextCursor).toBeNull();
    });

    it('trims the probe row and anchors the cursor on the last returned row', async () => {
      ownsAccount();
      const rows = ledgerRows(51);
      prisma.transaction.findMany.mockResolvedValue(rows);

      const result = await service.listTransactions('a', 'u1', { limit: 50 });

      expect(result.items).toHaveLength(50);
      expect(result.items).toEqual(rows.slice(0, 50));
      expect(result.items).not.toContain(rows[50]);

      // Anchoring on the probe (row 50) instead of the last returned row (49)
      // silently skips one transaction per page. not.toBeNull() misses it.
      expect(decodeCursor(result.nextCursor as string)).toEqual({
        createdAt: rows[49].createdAt,
        id: rows[49].id,
      });
    });

    it('anchors the query on the supplied cursor', async () => {
      ownsAccount();
      prisma.transaction.findMany.mockResolvedValue([]);
      const at = new Date('2026-06-10T00:00:00.000Z');

      await service.listTransactions('a', 'u1', {
        limit: 10,
        cursor: encodeCursor({ createdAt: at, id: uuid(7) }),
      });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            accountId: 'a',
            OR: [
              { createdAt: { lt: at } },
              { createdAt: at, id: { lt: uuid(7) } },
            ],
          }),
        }),
      );
    });

    it('fetches one row beyond the limit to detect a further page', async () => {
      ownsAccount();
      prisma.transaction.findMany.mockResolvedValue([]);

      await service.listTransactions('a', 'u1', { limit: 25 });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 26 }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────── listAccounts

  describe('listAccounts', () => {
    it('scopes the listing to the caller for customers', async () => {
      prisma.account.findMany.mockResolvedValue([]);

      await service.listAccounts('u1', 'CUSTOMER' as Role);

      expect(prisma.account.findMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });

    it('returns EVERY user\'s accounts for admins (known gap — Phase 5 replaces this)', async () => {
      prisma.account.findMany.mockResolvedValue([]);

      await service.listAccounts('u1', 'ADMIN' as Role);

      // Deliberately uncomfortable to read: an ADMIN token reads every
      // customer's accounts through a CUSTOMER endpoint. Documented, not endorsed.
      expect(prisma.account.findMany).toHaveBeenCalledWith();
    });
  });
});
