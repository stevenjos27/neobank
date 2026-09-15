import { Controller, Get, HttpCode, InternalServerErrorException, Post, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { AiService } from "./ai.service";
import { Roles } from "../auth/roles.decorator";
import { IngestionService } from "./ingestion.service";
import { Throttle } from "@nestjs/throttler";
import { LlmError } from "./llm-provider.interface";

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly ingestion: IngestionService
  ) { }

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

  /**
   * Re-embed the knowledge base and enrich transactions.
   *
   * POST with 200, not 201: nothing addressable is created, so there is no
   * Location to return — same reasoning as login, refresh and payee verify.
   *
   * ADMIN-only and throttled to two a minute. This is the most expensive
   * endpoint in the API by a wide margin; every call is real provider spend.
   * The limit is not about load, it is about the bill.
   *
   * It runs SYNCHRONOUSLY and can take a minute or more on a cold database.
   * That is a deliberate trade for admin tooling — the report is the whole
   * point, and a 202 with a job id would mean building job storage and a
   * polling endpoint to deliver it. What makes it survivable is the in-flight
   * guard in IngestionService: a client that gives up and retries JOINS the
   * run already underway instead of starting a second one, so a timeout costs
   * nothing but the wait. If a deploy platform's request ceiling turns out to
   * be lower than a cold run, Step 7 moves this behind a queue.
   */

  @Post('ingest')
  @Roles('ADMIN')
  @HttpCode(200)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  async ingest() {
    try {
      return await this.ingestion.ingestAll();
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  /**
   * Map provider failures onto statuses an operator can act on.
   *
   * The distinction the LlmError kinds exist for pays off here: a spend cap
   * and a rate limit are both HTTP 429 from OpenAI, but they mean opposite
   * things to whoever is holding the pager. 503 says "stop retrying, go and
   * fix the billing"; 429 says "wait and try again".
   *
   * Nothing from the provider's message reaches the client. Prompts carry
   * customer financial data and provider errors can echo request content, so
   * only our own kind label crosses the boundary. The detail is already in
   * the logs, where it belongs.
   *
   * One route justifies a private helper; a second one would justify an
   * exception filter instead.
   */
  private toHttp(error: unknown): Error {
    if (!(error instanceof LlmError)) {
      return new InternalServerErrorException('Ingestion failed');
    }

    switch (error.kind) {
      case 'spend_limit':
        return new ServiceUnavailableException(
          'AI provider spend limit reached. Ingestion cannot proceed until it is raised.',
        );
      case 'auth':
        // A rejected key is OUR misconfiguration, not the caller's fault, so
        // it must not come back as 401 — that would tell an admin their own
        // session had expired and send them to re-login for no reason.
        return new InternalServerErrorException('AI provider rejected our credentials');
      default:
        return new InternalServerErrorException(`Ingestion failed: ${error.kind}`);
    }
  }
}
