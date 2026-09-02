import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length, Matches } from "class-validator";

export class VerifyPayeeDto {
  @ApiProperty({ example: '900000000004' })
  @IsString()
  @Length(9, 18)
  @Matches(/^\d+$/, { message: 'accountNumber must be digits only' })
  accountNumber!: string;

  @ApiProperty({ example: 'NEOB0000001' })
  @IsString()
  // Real IFSC shape: 4 letters, a literal 0, then 6 alphanumerics.
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/i, { message: 'ifsc is not a valid IFSC code' })
  ifsc!: string;
}
