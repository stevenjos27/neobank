import { BadRequestException } from "@nestjs/common";
import { decodeCursor, encodeCursor } from "./cursor";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('cursor', () => {
  it('round-trips a row through encode and decode', () => {
    const row = { createdAt: new Date('2026-06-10T09:15:00.000Z'), id: uuid(7) };

    // Guards against encoder/decoder drift: the encoder accepts anything with
    // an id, the decoder insists on a UUID. If those ever disagree, the server
    // emits cursors it will itself reject on the next request.
    expect(decodeCursor(encodeCursor(row))).toEqual(row);
  });

  it('preserves millisecond precision', () => {
    const row = { createdAt: new Date('2026-06-10T09:15:00.123Z'), id: uuid(1) };
    expect(decodeCursor(encodeCursor(row)).createdAt.getTime()).toBe(row.createdAt.getTime());
  });

  it.each([
    ['garbage that is not base64 at all', 'not-base64-at-all!!'],
    ['valid base64 with no separator', b64('no-separator-here')],
    ['a non-UUID id', b64(`2026-06-10T09:15:00.000Z|not-a-uuid`)],
    ['an unparseable timestamp', b64(`rubbish|${uuid(1)}`)],
    ['an empty string', ''],
    ['an empty id', b64('2026-06-10T09:15:00.000Z|')],
  ])('rejects %s', (_label, bad) => {
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
  });

  it('does not treat a decoded-to-junk cursor as valid', () => {
    // Buffer.from does NOT throw on malformed base64 — it silently discards
    // invalid characters and returns *something*. This is why decodeCursor
    // validates the decoded content rather than wrapping the decode in
    // try/catch: there is no throw to catch.
    expect(() => Buffer.from('!!!!', 'base64url')).not.toThrow();
    expect(() => decodeCursor('!!!!')).toThrow(BadRequestException);
  });
});
