import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, Min, IsOptional, IsString } from "class-validator";

export class DepositDto {
  @ApiProperty({ example: 200000, description: 'Amount in paise (₹1 = 100 paise)' })
  @IsInt()
  @Min(1)
  amountPaise!: number;

  @ApiPropertyOptional({ example: 'rent payment' })
  @IsOptional()
  @IsString()
  description?: string;
}
