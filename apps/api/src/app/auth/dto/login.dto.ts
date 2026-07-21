import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: 'steven@neobank.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Secret123!', minLength: 8, maxLength: 72 })
  @IsString()
  password!: string;
}
