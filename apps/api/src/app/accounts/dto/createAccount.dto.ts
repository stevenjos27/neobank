import { ApiProperty } from "@nestjs/swagger";
import { IsUUID, IsIn } from "class-validator";

export class CreateAccountDto {
  @ApiProperty({ format: 'uuid', example: 'c23ceb8e-ef6b-4361-9f61-4a32afab6cb2' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: ['SAVINGS', 'CURRENT'], example: 'SAVINGS' })
  @IsIn(['SAVINGS', 'CURRENT'])
  type!: 'SAVINGS' | 'CURRENT';
}
