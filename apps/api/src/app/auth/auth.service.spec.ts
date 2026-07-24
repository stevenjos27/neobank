import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";

describe('AuthService', () => {
  let service: AuthService;

  const prisma = {
    user: { findUnique: jest.fn(), create: jest.fn() },
  };

  const jwt = {
    signAsync: jest.fn().mockResolvedValue('signed-token'),
    verifyAsync: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jwt.signAsync.mockResolvedValue('signed-token');
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('register rejects an already registered email', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    await expect(service.register('ab@co.in', 'Secret!123', 'X')).rejects.toThrow(ConflictException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('registers a new user and never return the hash', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'u1', email: 'ab@co.in', fullName: 'X', role: 'Customer'
    });

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

  it('rejects login for an unknown email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.login('ab@co.in', 'secret!123')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects login with a wrong password', async () => {
    prisma.user.findUnique.mockResolvedValue(
      {
        id: 'u1',
        role: 'CUSTOMER',
        passwordHash: await argon2.hash('correct-password')
      });

    await expect(service.login('ab@co.in', 'wrong-password')).rejects.toThrow(UnauthorizedException);
  });

  it('accepts login with correct password', async () => {
    prisma.user.findUnique.mockResolvedValue(
      {
        id: 'u1',
        role: 'CUSTOMER',
        passwordHash: await argon2.hash('correct-password')
      });

    await expect(service.login('ab@co.in', 'correct-password')).resolves.toEqual({
      accessToken: 'signed-token',
      refreshToken: 'signed-token',
    });
  });

  it('rejects invalid refresh token', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('bad'));

    await expect(service.refresh('refresh-token')).rejects.toThrow(UnauthorizedException);
  });
});
