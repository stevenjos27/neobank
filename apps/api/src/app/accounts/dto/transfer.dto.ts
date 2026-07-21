import { IsUUID, IsInt, IsString, Min, IsOptional } from "class-validator";

export class TransferDto {
  @IsUUID()
  fromAccountId!: string;

  @IsUUID()
  toAccountId!: string;

  @IsInt()
  @Min(1)
  amountPaise!: number;

  @IsOptional()
  @IsString()
  description?: string;
}
