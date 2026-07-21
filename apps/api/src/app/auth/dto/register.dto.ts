import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'steven@neobank.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Secret123!', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({ example: 'Steven Joseph' })
  @IsString()
  @MinLength(1)
  fullName!: string;
}
