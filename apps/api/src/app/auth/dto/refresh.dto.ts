import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

/**
 * Body of POST /auth/refresh and POST /auth/logout — the same single field,
 * so one class rather than two definitions of one contract.
 *
 * The cap rejects obviously malformed input before it costs a hash and a
 * database round trip. There is deliberately NO exact-length or format rule:
 * a well-formed-looking wrong token and a malformed one must get the same
 * answer (401 from refresh, 204 from logout), not a 400 that tells the caller
 * which rule it broke.
 */
export class RefreshDto {
  @ApiProperty({
    description:
      'Opaque, single-use refresh token (43 characters, base64url) from login or the previous refresh. ' +
      'Each refresh returns a new one; presenting a used one again outside a short grace window revokes the session.',
    example: 'q3Jd0vX9nB7mK2pL5sT8wY1zA4cE6fH0iJ3kM5nP7rU',
    maxLength: 256,
  })
  @IsString()
  @MaxLength(256)
  refreshToken!: string;
}
