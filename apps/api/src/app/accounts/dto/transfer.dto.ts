import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsUUID, IsInt, IsString, Min, IsOptional, MaxLength } from "class-validator";

export class TransferDto {
  @ApiProperty({ format: 'uuid', example: 'c23ceb8e-ef6b-4361-9f61-4a32afab6cb2' })
  @IsUUID()
  fromAccountId!: string;

  @ApiPropertyOptional({
    description: 'One of your OWN accounts. Mutually exclusive with payeeId.',
  })
  @IsOptional()
  @IsUUID()
  toAccountId!: string;

  @ApiPropertyOptional({
    description: 'A registered, verified payee. Mutually exclusive with toAccountId.',
  })
  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @ApiProperty({ description: 'Amount in paise. Always an integer; never a float.' })
  @IsInt()
  @Min(1)
  amountPaise!: number;

  @ApiPropertyOptional({
    description: 'Ignored for payee transfers — those are labelled server-side.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;
}
