import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { CreateAccountDto } from "./dto/createAccount.dto";
import { DepositDto } from "./dto/deposit.dto";
import { TransferDto } from "./dto/transfer.dto";
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtPayload } from "../auth/jwt-payload.interface";

@ApiTags('accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) { }

  @Post()
  createAccount(@Body() body: CreateAccountDto, @CurrentUser() user: JwtPayload) {
    return this.accounts.createAccount(user.sub, body.type);
  }

  @Get(':id')
  async getAccount(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return await this.accounts.getAccount(id, user.sub);
  }

  @Post(':id/deposit')
  deposit(@Body() body: DepositDto, @Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.accounts.deposit(user.sub, id, BigInt(body.amountPaise), body.description);
  }

  @Post('transfer')
  transfer(@Body() body: TransferDto, @CurrentUser() user: JwtPayload) {
    return this.accounts.transfer(user.sub, body.fromAccountId, body.toAccountId, BigInt(body.amountPaise), body.description);
  }

  @Get()
  listAccounts(@CurrentUser() user: JwtPayload) {
    return this.accounts.listAccounts(user.sub, user.role);
  }

}
