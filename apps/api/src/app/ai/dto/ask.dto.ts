import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AskDto {
  /**
   * Capped at 500 characters, same as the search query and for a sharper
   * reason here: this string goes into a prompt alongside the assistant's
   * instructions. A length bound is not a defence against prompt injection —
   * a hostile instruction fits in twenty characters — but it does bound how
   * much of the context window a single request can claim, and an unbounded
   * user string reaching a model is a cost vector as well as a safety one.
   */
  @ApiProperty({ example: 'what happens if I do not have enough money in my account?', maxLength: 500 })
  @IsString()
  @Length(1, 500)
  question!: string;
}
