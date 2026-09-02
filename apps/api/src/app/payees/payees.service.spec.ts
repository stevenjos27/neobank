import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PayeesService } from './payees.service';
import { PrismaService } from '../../prisma/prisma.service';

const BANK_IFSC = 'NEOB0000001';

describe('PayeesService', () => {
  let service: PayeesService;

  let prisma: {
    account: { findUnique: jest.Mock };
    payee: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.BANK_IFSC = BANK_IFSC;

    prisma = {
      account: { findUnique: jest.fn() },
      payee: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [PayeesService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(PayeesService);
  });

  // ─────────────────────────────────────────────────────────────────── verify

  describe('verify (Confirmation of Payee)', () => {
    it('returns the account holder\'s name', async () => {
      prisma.account.findUnique.mockResolvedValue({
        accountNumber: '900000000004',
        user: { fullName: 'Priya Nair' },
      });

      await expect(service.verify('900000000004', BANK_IFSC)).resolves.toEqual({
        accountNumber: '900000000004',
        beneficiaryName: 'Priya Nair',
      });
    });

    it('404s a foreign IFSC WITHOUT touching the database', async () => {
      await expect(service.verify('900000000004', 'HDFC0000123'))
        .rejects.toThrow(NotFoundException);

      expect(prisma.account.findUnique).not.toHaveBeenCalled();
    });

    it('accepts a lowercase IFSC', async () => {
      prisma.account.findUnique.mockResolvedValue({
        accountNumber: '900000000004',
        user: { fullName: 'Priya Nair' },
      });

      await expect(service.verify('900000000004', 'neob0000001')).resolves.toMatchObject({
        beneficiaryName: 'Priya Nair',
      });
    });

    it('404s an unknown account number', async () => {
      prisma.account.findUnique.mockResolvedValue(null);

      await expect(service.verify('999999999999', BANK_IFSC))
        .rejects.toThrow(NotFoundException);
    });

    it('returns the SAME error for a bad IFSC and a missing account', async () => {
      prisma.account.findUnique.mockResolvedValue(null);

      const badIfsc = await service.verify('900000000004', 'HDFC0000123').catch((e) => e);
      const noAccount = await service.verify('999999999999', BANK_IFSC).catch((e) => e);

      expect(badIfsc.message).toBe(noAccount.message);
    });
  });

  // ─────────────────────────────────────────────────────────────────── create

  describe('create', () => {
    const holderIs = (fullName: string) =>
      prisma.account.findUnique.mockResolvedValue({
        accountNumber: '900000000004',
        user: { fullName },
      });

    it('stores the VERIFIED name, never client input', async () => {
      holderIs('Priya Nair');
      prisma.payee.create.mockResolvedValue({ id: 'p1' });

      await service.create('u1', '900000000004', BANK_IFSC);

      expect(prisma.payee.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          name: 'Priya Nair',
          accountNumber: '900000000004',
          ifsc: BANK_IFSC,
        },
      });
    });

    it('normalises the stored IFSC to the bank\'s canonical form', async () => {
      holderIs('Priya Nair');
      prisma.payee.create.mockResolvedValue({ id: 'p1' });

      await service.create('u1', '900000000004', 'neob0000001');

      expect(prisma.payee.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ifsc: BANK_IFSC }) }),
      );
    });

    it('does not create a payee for an account that fails verification', async () => {
      prisma.account.findUnique.mockResolvedValue(null);

      await expect(service.create('u1', '999999999999', BANK_IFSC))
        .rejects.toThrow(NotFoundException);

      expect(prisma.payee.create).not.toHaveBeenCalled();
    });

    it('turns a unique-constraint violation into 409 Conflict', async () => {
      holderIs('Priya Nair');
      prisma.payee.create.mockRejectedValue({ code: 'P2002' });

      // Catching P2002 rather than checking-then-inserting: a findFirst guard
      // has a race window between the read and the write.
      await expect(service.create('u1', '900000000004', BANK_IFSC))
        .rejects.toThrow(ConflictException);
    });

    it('rethrows any error that is NOT a unique violation', async () => {
      holderIs('Priya Nair');
      prisma.payee.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.create('u1', '900000000004', BANK_IFSC))
        .rejects.toThrow('connection lost');
    });
  });

  // ──────────────────────────────────────────────────────────── list / remove

  describe('list and remove', () => {
    it('scopes the listing to the caller', async () => {
      prisma.payee.findMany.mockResolvedValue([]);

      await service.list('u1');

      expect(prisma.payee.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('deletes with ownership in the same where-clause', async () => {
      prisma.payee.deleteMany.mockResolvedValue({ count: 1 });

      await service.remove('u1', 'p1');

      expect(prisma.payee.deleteMany).toHaveBeenCalledWith({
        where: { id: 'p1', userId: 'u1' },
      });
    });

    it('404s when the payee is not yours or does not exist', async () => {
      prisma.payee.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.remove('u1', 'p1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────── resolveDestination

  describe('resolveDestination', () => {
    it('404s a payee belonging to someone else', async () => {
      prisma.payee.findFirst.mockResolvedValue(null);

      await expect(service.resolveDestination('u1', 'p1'))
        .rejects.toThrow(NotFoundException);

      expect(prisma.payee.findFirst).toHaveBeenCalledWith({
        where: { id: 'p1', userId: 'u1' },
      });
      expect(prisma.account.findUnique).not.toHaveBeenCalled();
    });

    it('400s when the payee\'s account no longer exists', async () => {
      prisma.payee.findFirst.mockResolvedValue({
        id: 'p1', name: 'Priya Nair', accountNumber: '900000000004',
      });
      prisma.account.findUnique.mockResolvedValue(null);

      // 400 not 404: the payee is real and yours, but its target is gone —
      // a different situation from "no such payee", and the user can act on it.
      await expect(service.resolveDestination('u1', 'p1'))
        .rejects.toThrow(BadRequestException);
    });

    it('returns the account id, name and number for a live payee', async () => {
      prisma.payee.findFirst.mockResolvedValue({
        id: 'p1', name: 'Priya Nair', accountNumber: '900000000004',
      });
      prisma.account.findUnique.mockResolvedValue({ id: 'acct-b' });

      await expect(service.resolveDestination('u1', 'p1')).resolves.toEqual({
        accountId: 'acct-b',
        name: 'Priya Nair',
        accountNumber: '900000000004',
      });
    });
  });
});
