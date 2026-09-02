import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PayeesService } from "./payees.service";
import { Throttle } from "@nestjs/throttler";
import { VerifyPayeeDto } from "./dto/verify-payee.dto";
import { CreatePayeeDto } from "./dto/create-payee.dto";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtPayload } from "../auth/jwt-payload.interface";

@ApiTags('payees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payees')
export class PayeesController {
  constructor(private readonly payees: PayeesService) { }

  /**
   * POST because it takes a body, 200 because it creates nothing — the same
   * reasoning applied to login and refresh in Phase 1.
   *
   * Throttled hard: this is the only endpoint in the API that will confirm a
   * stranger's name from an account number. Ten a minute is plenty for a human
   * adding a payee and useless for walking the account-number space.
   */

  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Body() body: VerifyPayeeDto) {
    return this.payees.verify(body.accountNumber, body.ifsc);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Body() body: CreatePayeeDto, @CurrentUser() user: JwtPayload) {
    return this.payees.create(user.sub, body.accountNumber, body.ifsc);
  }

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.payees.list(user.sub);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.payees.remove(user.sub, id);
  }

}
