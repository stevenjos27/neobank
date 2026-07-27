import { Role } from "@neobank/prisma";

export interface JwtPayload {
  sub: string;
  role: Role;
  iat?: number;
  exp?: number;
}
