import { ApiProperty } from "@nestjs/swagger";
import { IsIn } from "class-validator";

export class CreateAccountDto {
  @ApiProperty({ enum: ['SAVINGS', 'CURRENT'], example: 'SAVINGS' })
  @IsIn(['SAVINGS', 'CURRENT'])
  type!: 'SAVINGS' | 'CURRENT';
}
