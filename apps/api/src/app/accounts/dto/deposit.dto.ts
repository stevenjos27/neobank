import { IsInt, Min, IsOptional, IsString } from "class-validator";

export class DepositDto {
  @IsInt()
  @Min(1)
  amountPaise!: number;

  @IsOptional()
  @IsString()
  description?: string;
}
