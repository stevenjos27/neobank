import { Test } from "@nestjs/testing";
import { AccountsService } from "./accounts.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

describe('AccountsService', () => {
  let service: AccountsService;

  const tx = {
    account: {
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn()
    },
    transaction: {
      create: jest.fn(),
      createMany: jest.fn()
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AccountsService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
            account: {
              create: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              findMany: jest.fn()
            },
          },
        },
      ]
    }).compile();
    service = module.get(AccountsService);
  });

  it('transfer rejects a non-positive amount', async () => {
    await expect(service.transfer('u1', 'a', 'b', 0n)).rejects.toThrow(BadRequestException);
  });

  it('rejects transfer to same account', async () => {
    await expect(service.transfer('u1', 'a', 'a', 100n)).rejects.toThrow(BadRequestException);
  });

  it('rejects insufficient funds and never credits', async () => {
    tx.account.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.transfer('u1', 'a', 'b', 100n)).rejects.toThrow('insufficient funds');
    expect(tx.account.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.transaction.createMany).not.toHaveBeenCalled();
  });

  it('debits, credits and writes two ledger rows on success', async () => {
    tx.account.updateMany.mockResolvedValue({ count: 1 });

    await service.transfer('u1', 'a', 'b', 100n, 'rent');

    expect(tx.account.updateMany).toHaveBeenCalledWith({
      where: { id: 'a', balancePaise: { gte: 100n }, userId: 'u1' },
      data: { balancePaise: { decrement: 100n } },
    });

    expect(tx.account.updateMany).toHaveBeenCalledWith({
      where: { id: 'b' },
      data: { balancePaise: { increment: 100n } },
    });

    expect(tx.transaction.createMany).toHaveBeenCalledWith({
      data: [
        { accountId: 'a', type: 'TRANSFER_OUT', amountPaise: 100n, description: 'rent' },
        { accountId: 'b', type: 'TRANSFER_IN', amountPaise: 100n, description: 'rent' },
      ],
    });
  });

  it('deposit rejects a non-positive amount', async () => {
    await expect(service.deposit('u1', 'a', 0n)).rejects.toThrow(BadRequestException);
  });

  it('deposit 404s on unowned or missing account and writes no ledger row', async () => {
    tx.account.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.deposit('u1', 'a', 100n)).rejects.toThrow(NotFoundException);
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it('deposit increments only the owned account and writes one ledger row', async () => {
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

  it('404s when the destination account does not exist and rolls back', async () => {
    tx.account.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.transfer('u1', 'a', 'ghost', 100n)).rejects.toThrow(NotFoundException);
    expect(tx.transaction.createMany).not.toHaveBeenCalled();
  });
});
