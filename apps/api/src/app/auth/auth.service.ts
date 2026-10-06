import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import * as argon2 from "argon2";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "node:crypto";
import { decideRefresh } from "./refresh-decision";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Short-lived and stateless: the guard checks the signature, never the DB. */
const ACCESS_TOKEN_TTL = '15m';
/** Idle timeout. Each rotation issues a fresh 7 days, capped at the session's end. */
const REFRESH_TOKEN_TTL_MS = 7 * DAY_MS;
/** Absolute cap from login. Rotation never extends it. */
const SESSION_MAX_AGE_MS = 30 * DAY_MS;

/**
 * Refresh tokens are opaque: 32 random bytes, base64url (43 chars). Not JWTs —
 * every refresh looks the token up anyway, so a self-describing token would
 * add a signing secret and nothing else.
 */
function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this is stored. SHA-256, not argon2: the input is 256 random bits, so
 * there is nothing to brute-force, and a deterministic hash is what makes the
 * unique-index lookup possible.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function refreshExpiry(now: Date, sessionExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + REFRESH_TOKEN_TTL_MS, sessionExpiresAt.getTime()));
}

/** What refresh needs from a token row: decideRefresh's input plus ids for acting on it. */
const REFRESH_ROW = {
  id: true,
  expiresAt: true,
  usedAt: true,
  session: {
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: { role: true } },
    },
  },
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) { }

  async register(email: string, password: string, fullName: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      throw new ConflictException('email already registered');
    }

    const passwordHash = await argon2.hash(password);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, fullName },
    });

    return { id: user.id, email: user.email, fullName: user.fullName, role: user.role };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    let valid = false;
    if (user) {
      try {
        valid = await argon2.verify(user.passwordHash, password);
      }
      catch {
        valid = false;
      }
    }
    if (!valid) throw new UnauthorizedException('invalid credentials');

    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + SESSION_MAX_AGE_MS);
    const refreshToken = newRefreshToken();

    // One nested create: the session and its first token exist together or
    // not at all.
    await this.prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: sessionExpiresAt,
        tokens: {
          create: {
            tokenHash: hashRefreshToken(refreshToken),
            expiresAt: refreshExpiry(now, sessionExpiresAt),
          },
        },
      },
    });

    return {
      accessToken: await this.signAccessToken(user.id, user.role),
      refreshToken
    };
  }

  /**
   * Read, decide, act. decideRefresh says what should happen; the conditional
   * UPDATE in the 'rotate' branch guarantees it happens at most once. A
   * request that loses that race re-reads the row and decides again — with
   * usedAt now set it gets 'grace' (or 'reject'/'reuse'), never a second
   * 'rotate', so two passes always suffice.
   */
  async refresh(presented: string) {
    const tokenHash = hashRefreshToken(presented);
    const now = new Date();

    for (let pass = 0; pass < 2; pass++) {
      const row = await this.prisma.refreshToken.findUnique({
        where: { tokenHash },
        select: REFRESH_ROW,
      });
      const decision = decideRefresh(row, now);

      switch (decision.action) {
        case 'rotate': {
          const won = await this.prisma.refreshToken.updateMany({
            where: { id: row.id, usedAt: null, session: { revokedAt: null } },
            data: { usedAt: now },
          });
          if (won.count === 0) continue; // lost the race, or revoked meanwhile: look again
          return this.issuePair(row.session, now);
        }

        case 'grace':
          return this.issuePair(row.session, now);

        case 'reuse':
          await this.prisma.session.updateMany({
            where: { id: row.session.id, revokedAt: null },
            data: { revokedAt: now, revokedReason: 'REUSE' },
          });
          this.logger.warn(
            `refresh token reuse: session ${row.session.id} of user ${row.session.userId} revoked`,
          );
          throw new UnauthorizedException('invalid refresh token');

        case 'reject':
          throw new UnauthorizedException('invalid refresh token');
      }
    }

    // Unreachable: a second pass cannot be told 'rotate' after losing the
    // first. Fail closed rather than loop if that reasoning is ever wrong.
    throw new UnauthorizedException('invalid refresh token');
  }

  /**
   * Revokes the session the token belongs to. Deliberately returns nothing
   * either way: an endpoint that answered differently for live, dead and
   * unknown tokens would let anyone holding a stolen token test it.
   */
  async logout(presented: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { revokedAt: null, tokens: { some: { tokenHash: hashRefreshToken(presented) } } },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
  }

  /** The lost-phone control: ends every live session the user has. */
  async logoutAll(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT_ALL' },
    });
  }

  private async issuePair(
    session: {
      id: string;
      userId: string;
      expiresAt: Date;
      user: { role: string }
    },
    now: Date,
  ) {
    const refreshToken = newRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshExpiry(now, session.expiresAt),
      },
    });
    // Role is read fresh from the database on every refresh, not copied
    // forward from the previous token: a role change applies at next refresh.
    return {
      accessToken: await this.signAccessToken(session.userId, session.user.role),
      refreshToken
    };
  }

  private signAccessToken(userId: string, role: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, role },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: ACCESS_TOKEN_TTL },
    );
  }
}
