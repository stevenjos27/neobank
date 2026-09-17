import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Period, PERIODS } from '../period';

export class SpendByCategoryDto {
  /**
   * REQUIRED, with no default, deliberately.
   *
   * A defaulted period means an unspecified request silently becomes a
   * specific window, and the caller gets a number they cannot reconcile
   * because they never chose the range it covers. That is the same class of
   * problem as a guessed retrieval threshold: the wrong answer arrives
   * looking exactly like the right one.
   *
   * The spread is not cosmetic — `PERIODS` is a readonly tuple and
   * class-validator wants a mutable array.
   */
  @ApiProperty({ enum: PERIODS })
  @IsIn([...PERIODS])
  period!: Period;
}
