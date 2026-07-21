import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class RefreshDto {
  @ApiProperty({ example: 'xnfsklfsv' })
  @IsString()
  refreshToken!: string;
}
