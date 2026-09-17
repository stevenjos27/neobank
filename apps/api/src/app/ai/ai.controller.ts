import {
  Body,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  Post,
  ServiceUnavailableException,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { AiService } from "./ai.service";
import { Roles } from "../auth/roles.decorator";
import { IngestionService } from "./ingestion.service";
import { Throttle } from "@nestjs/throttler";
import { LlmError } from "./llm-provider.interface";
import { RetrievalService } from "./retrieval.service";
import { SearchKnowledgeDto } from "./dto/search-knowledge.dto";
import { AggregatesService } from "./aggregates.service";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { SpendByCategoryDto } from "./dto/spend-by-category.dto";

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly ingestion: IngestionService,
    private readonly retrieval: RetrievalService,
    private readonly aggregates: AggregatesService
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
      throw this.toHttp(error, 'Ingestion');
    }
  }

  /**
 * Inspect what retrieval returns for a query, with distances.
 *
 * ADMIN-only, and it stays that way. The customer-facing surface is the
 * chat endpoint in Step 4 — not raw search — so exposing this publicly
 * would create an API we'd have to support forever for no user benefit.
 * As an admin diagnostic it keeps earning its place: "why did the
 * assistant say that?" is answerable by replaying the question here and
 * reading the distances.
 *
 * Its immediate job is calibration. `DEFAULT_MAX_DISTANCE` in
 * RetrievalService is currently a guess, and passing `maxDistance: 2`
 * here returns everything so the real distribution can be measured.
 *
 * NOTE FOR WHOEVER ADDS TRANSACTION SEARCH: do not add it to this route.
 * KnowledgeChunk is global by design, which is the only reason this
 * endpoint needs no userId scoping. Transaction vectors are per-customer
 * and must be scoped to the caller's own accounts. Extending an
 * unscoped route with scoped data is how that scoping gets forgotten.
 */
  @Post('search')
  @Roles('ADMIN')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async search(@Body() body: SearchKnowledgeDto) {
    try {
      return await this.retrieval.searchKnowledge(body.q, {
        limit: body.limit,
        maxDistance: body.maxDistance,
      });
    } catch (error) {
      throw this.toHttp(error, 'Knowledge search');
    }
  }

  /**
 * Spending by category for the AUTHENTICATED CALLER.
 *
 * Note what is absent: `@Roles('ADMIN')` and any user identifier in the
 * DTO. Both absences are the design.
 *
 * Not ADMIN, unlike /ai/search — and the contrast is the rule. Search hits
 * a GLOBAL corpus and bills a third party on every call, so it is gated on
 * cost. This is free SQL over the caller's own rows, so it is an ordinary
 * customer endpoint. Gating it on ADMIN would also make the scoping
 * property untestable: an administrator's own data is just another user's
 * data, and "it returned something" would prove nothing.
 *
 * No user id in the body. `user.sub` comes from the verified JWT, so the
 * question "whose money?" is answered by the token and is unaskable by the
 * caller. When this same service is driven by tool-calling in the next
 * step, the model fills `period` and nothing else — the identity argument
 * simply does not exist for it to hallucinate.
 *
 * No @Throttle either. In this codebase a throttle marks SPEND, not load:
 * ingest is 2/min and search 20/min because each call bills OpenAI. This
 * one bills nobody, so it inherits the global 100/min and adding a tighter
 * limit would be a control protecting nothing.
 *
 * No try/catch, for the same species of reason: there is no provider call
 * here, so no LlmError is reachable, and wrapping it in a handler that maps
 * nothing would just be noise for the next reader to decode.
 */
  @Post('aggregates/spend')
  @HttpCode(200)
  async spendByCategory(
    @Body() body: SpendByCategoryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.aggregates.spendByCategory(user.sub, body.period);
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
  private toHttp(error: unknown, operation: string): Error {
    if (!(error instanceof LlmError)) {
      return new InternalServerErrorException(`${operation} failed`);
    }

    switch (error.kind) {
      case 'spend_limit':
        return new ServiceUnavailableException(
          `AI provider spend limit reached. ${operation} cannot proceed until it is raised.`,
        );
      case 'auth':
        // A rejected key is OUR misconfiguration, not the caller's fault, so
        // it must not come back as 401 — that would tell an admin their own
        // session had expired and send them to re-login for no reason.
        return new InternalServerErrorException('AI provider rejected our credentials');
      default:
        return new InternalServerErrorException(`${operation} failed: ${error.kind}`);
    }
  }
}
