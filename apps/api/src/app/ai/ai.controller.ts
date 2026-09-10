import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { AiService } from "./ai.service";
import { Roles } from "../auth/roles.decorator";

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) { }

  /**
   * Dependency health, not liveness. It makes a real (cached) call to the
   * provider, so it is ADMIN-only: an unauthenticated endpoint that spends
   * money is a cost-amplification vector, and this one also advertises which
   * models we run. GET /api remains the public liveness check.
   */

  @Get('health')
  @Roles('ADMIN')
  health() {
    return this.ai.health();
  }
}
