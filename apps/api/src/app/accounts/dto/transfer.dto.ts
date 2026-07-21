import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsUUID, IsInt, IsString, Min, IsOptional } from "class-validator";

export class TransferDto {
  @ApiProperty({ format: 'uuid', example: 'c23ceb8e-ef6b-4361-9f61-4a32afab6cb2' })
  @IsUUID()
  fromAccountId!: string;

  @ApiProperty({ format: 'uuid', example: 'b3143d4d-7b01-402c-95bc-acfcfc921112' })
  @IsUUID()
  toAccountId!: string;

  @ApiProperty({ example: 200000, description: 'Amount in paise (₹1 = 100 paise)' })
  @IsInt()
  @Min(1)
  amountPaise!: number;

  @ApiPropertyOptional({ example: 'rent payment' })
  @IsOptional()
  @IsString()
  description?: string;
}
