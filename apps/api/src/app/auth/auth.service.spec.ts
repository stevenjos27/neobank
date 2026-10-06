import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { AuthService, hashRefreshToken } from "./auth.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * The WIRING between decideRefresh and the database, with Prisma mocked.
 * The decision logic has its own spec (refresh-decision.spec.ts) and the real
 * concurrency is proven against Postgres in api-e2e; this file checks that
 * each decision becomes exactly the right writes — and no others.
 */

const DAY = 86_400_000;

describe('AuthService', () => {
  let service: AuthService;

  const prisma = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    session: { create: jest.fn(), updateMany: jest.fn() },
    refreshToken: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  };

  const jwt = {
    signAsync: jest.fn(),
  };

  /** A live, unused token row in a live session, as REFRESH_ROW selects it. */
  const liveRow = (overrides: { usedAt?: Date | null } = {}) => ({
    id: 'rt1',
    expiresAt: new Date(Date.now() + 7 * DAY),
    usedAt: overrides.usedAt ?? null,
    session: {
      id: 's1',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 30 * DAY),
      revokedAt: null,
      user: { role: 'ADMIN' },
    },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jwt.signAsync.mockResolvedValue('signed-access-token');
    prisma.session.create.mockResolvedValue({});
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.refreshToken.create.mockResolvedValue({});

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('register', () => {
    it('rejects an already registered email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      await expect(service.register('ab@co.in', 'Secret!123', 'X')).rejects.toThrow(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('registers a new user and never returns the hash', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u1', email: 'ab@co.in', fullName: 'X', role: 'CUSTOMER' });

      const result = await service.register('ab@co.in', 'Secret!123', 'X');

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'ab@co.in',
          fullName: 'X',
          passwordHash: expect.any(String),
        }),
      });
      expect(result).not.toHaveProperty('passwordHash');
    });
  });

  describe('login', () => {
    it('rejects an unknown email, and opens no session', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login('ab@co.in', 'secret!123')).rejects.toThrow(UnauthorizedException);
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('rejects a wrong password, and opens no session', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1', role: 'CUSTOMER', passwordHash: await argon2.hash('correct-password'),
      });
      await expect(service.login('ab@co.in', 'wrong-password')).rejects.toThrow(UnauthorizedException);
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('opens a 30-day session holding the HASH of a fresh 7-day opaque token', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1', role: 'CUSTOMER', passwordHash: await argon2.hash('correct-password'),
      });

      const before = Date.now();
      const result = await service.login('ab@co.in', 'correct-password');
      const after = Date.now();

      expect(result.accessToken).toBe('signed-access-token');
      // 32 random bytes, base64url: 43 chars, no padding.
      expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const { data } = prisma.session.create.mock.calls[0][0];
      expect(data.userId).toBe('u1');
      expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY);
      expect(data.expiresAt.getTime()).toBeLessThanOrEqual(after + 30 * DAY);

      const token = data.tokens.create;
      expect(token.tokenHash).toBe(hashRefreshToken(result.refreshToken));
      expect(token.tokenHash).not.toBe(result.refreshToken);
      expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY);
      expect(token.expiresAt.getTime()).toBeLessThanOrEqual(after + 7 * DAY);
    });
  });

  describe('refresh', () => {
    it('looks the token up by its hash, never by the raw value', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.refresh('presented-token')).rejects.toThrow(UnauthorizedException);

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashRefreshToken('presented-token') } }),
      );
    });

    it('rejects an unknown token and writes nothing', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.refresh('unknown')).rejects.toThrow(UnauthorizedException);

      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rotates: marks the token used ONLY IF still unused in a live session, then issues a successor', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(liveRow());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.refresh('t1');

      // Both guards in one statement: this is what makes rotation atomic.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt1', usedAt: null, session: { revokedAt: null } },
        data: { usedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sessionId: 's1', tokenHash: hashRefreshToken(result.refreshToken) }),
      });
      // Role comes from the database row, not from any previous token.
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u1', role: 'ADMIN' }, expect.anything());
    });

    it('on losing the rotation race, re-reads and takes grace — never a second rotation', async () => {
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce(liveRow())                        // first read: unused
        .mockResolvedValueOnce(liveRow({ usedAt: new Date() })); // re-read: the winner just used it
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 }); // we lost

      await expect(service.refresh('t1')).resolves.toHaveProperty('refreshToken');

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('on reuse, revokes that session with reason REUSE and issues nothing', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(liveRow({ usedAt: new Date(Date.now() - 60_000) }));

      await expect(service.refresh('t1')).rejects.toThrow(UnauthorizedException);

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', revokedAt: null },
        data: { revokedAt: expect.any(Date), revokedReason: 'REUSE' },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the live session holding that token hash, with reason LOGOUT', async () => {
      await expect(service.logout('t1')).resolves.toBeUndefined();

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { revokedAt: null, tokens: { some: { tokenHash: hashRefreshToken('t1') } } },
        data: { revokedAt: expect.any(Date), revokedReason: 'LOGOUT' },
      });
    });

    it('logoutAll revokes every live session of that user, with reason LOGOUT_ALL', async () => {
      await expect(service.logoutAll('u1')).resolves.toBeUndefined();

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date), revokedReason: 'LOGOUT_ALL' },
      });
    });
  });
});
