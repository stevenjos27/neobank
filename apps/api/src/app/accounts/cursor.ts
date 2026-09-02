import { BadRequestException } from '@nestjs/common';

export type LedgerCursor = { createdAt: Date; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque bookmark: base64url of "<iso timestamp>|<uuid>". */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): LedgerCursor {
  // Buffer.from does NOT throw on malformed base64 — it silently discards
  // invalid characters. So every check below has to be on the decoded content.
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep === -1) throw new BadRequestException('Invalid cursor');

  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);

  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(id)) {
    throw new BadRequestException('Invalid cursor');
  }
  return { createdAt, id };
}
