import { IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_LIMIT } from '../retrieval.service';

export class SearchKnowledgeDto {
  /**
   * Capped at 500 characters. Two reasons, and neither is arbitrary:
   * embedding cost scales with input length, and a "question" longer than a
   * paragraph is either an essay nobody will read the answer to or an
   * attempt to smuggle instructions into the corpus lookup. Both deserve a
   * 400 rather than a bill.
   */
  @ApiProperty({ example: 'what is the daily transfer limit?', maxLength: 500 })
  @IsString()
  @Length(1, 500)
  q!: string;

  /**
   * Same ceiling as the service, imported rather than retyped — but the two
   * behave DIFFERENTLY on violation, deliberately.
   *
   * Here, out of range is a 400: an HTTP caller made a mistake and should be
   * told. In the service, out of range is silently clamped, because its other
   * caller — from the next file onward — is the MODEL choosing tool
   * arguments. Failing a whole tool call because a model guessed `limit: 50`
   * would turn a trivial overreach into a dead conversation turn. Reject a
   * human, clamp a model.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIMIT, default: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;

  /**
   * Cosine distance ceiling. The full legal range is allowed here — not
   * because a caller should normally set it, but because CALIBRATING the
   * default requires seeing unfiltered results. Passing 2 disables filtering
   * entirely, which is exactly what the next step needs.
   */
  @ApiPropertyOptional({ minimum: 0, maximum: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  maxDistance?: number;
}
