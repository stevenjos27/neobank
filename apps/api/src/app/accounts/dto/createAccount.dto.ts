import { IsUUID, IsIn } from "class-validator";

export class CreateAccountDto {
  @IsUUID()
  userId!: string;

  @IsIn(['SAVINGS', 'CURRENT'])
  type!: 'SAVINGS' | 'CURRENT';
}
