import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";
import { CreateAccountDto } from "./dto/createAccount.dto";
import { DepositDto } from "./dto/deposit.dto";
import { TransferDto } from "./dto/transfer.dto";

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) { }

  @Post()
  createAccount(@Body() body: CreateAccountDto) {
    return this.accounts.createAccount(body.userId, body.type);
  }

  @Get(':id')
  async getAccount(@Param('id') id: string) {
    return await this.accounts.getAccount(id);
  }

  @Post(':id/deposit')
  deposit(@Body() body: DepositDto, @Param('id') id: string) {
    return this.accounts.deposit(id, BigInt(body.amountPaise), body.description);
  }

  @Post('transfer')
  transfer(@Body() body: TransferDto) {
    return this.accounts.transfer(body.fromAccountId, body.toAccountId, BigInt(body.amountPaise), body.description);
  }

  @Get()
  @Roles('ADMIN')
  listAccounts() {
    return this.accounts.listAccounts();
  }

}
