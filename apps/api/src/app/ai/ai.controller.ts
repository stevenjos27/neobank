import {
  Body,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  Post,
  Res,
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
import { AnsweringService } from "./answering.service";
import { AskDto } from "./dto/ask.dto";
import type { ServerResponse } from 'node:http';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly ingestion: IngestionService,
    private readonly retrieval: RetrievalService,
    private readonly aggregates: AggregatesService,
    private readonly answering: AnsweringService
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
 * Ask the assistant a question.
 *
 * Customer-facing and scoped to the caller, for the same reason as the
 * spend route: gating it on ADMIN would make the scoping property
 * untestable, since an administrator's own data is just another user's.
 *
 * Throttled at 10/min because this is the most expensive endpoint per call
 * after ingest — two or three chat completions, each carrying the system
 * prompt, the tool schemas and up to five retrieved chunks. Roughly
 * ₹0.12 / $0.0014 a question, so 10/min is a ceiling on a runaway client
 * rather than a limit anyone will notice. Consistent with the rest of the
 * codebase: a throttle here marks spend, not load.
 */
  @Post('ask')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async ask(@Body() body: AskDto, @CurrentUser() user: JwtPayload) {
    try {
      // One instant for the whole turn.
      //
      // The answering loop can call tools more than once, and each call used
      // to read the clock independently — so a reply that straddles IST
      // midnight could resolve two different "last month"s and reconcile
      // neither. Fixing it here, at the edge of the request, means everything
      // downstream answers the question as it was asked rather than as the
      // clock has since become.
      //
      // It is assembled in the same object as `userId` on purpose. Both are
      // facts about the request that the model must not supply: identity
      // comes from the verified JWT, time comes from the server. Neither is
      // negotiable from inside the conversation.
      const result = await this.answering.answer(body.question, {
        userId: user.sub,
        now: new Date(),
      });

      // THIS MAPPING IS THE SECOND HALF OF THE GUARDRAIL, not tidiness.
      //
      // `result.withheldAnswer` holds the text containing the figure we just
      // decided not to show. Returning the service's result object wholesale
      // — the obvious thing to write — would hand the customer the exact
      // amount the suppression existed to withhold, and the response would
      // still *look* correct because `answer` carries the refusal.
      //
      // `result.sources` is withheld for a second, separate reason: it is
      // every passage RETRIEVED, which overstates. The first real run fetched
      // three and used one, so publishing it would have credited two passages
      // the answer never touched. A reader who follows a citation and finds
      // nothing relevant stops trusting the ones that were real, which makes
      // an over-broad list worse than no list. `citedSources` is the subset
      // the answer actually names.
      //
      // The wire field stays `sources` even though it is fed by
      // `citedSources`. "Cited" is a contrast with an internal superset the
      // client never sees, and an external name should not carry a
      // distinction its consumer cannot observe — from out here, these simply
      // are the sources. The mismatch is deliberate and lives only here.
      //
      // Everything else stripped is internal: tool arguments, token usage,
      // the prompt version, the model name, and each hit's cosine distance.
      // Step 5's evals drive AnsweringService directly, so nothing needs this
      // route to leak diagnostics to get at them.
      return {
        answer: result.answer,
        sources: result.citedSources.map(({ source, heading, chunkIndex }) => ({
          source,
          heading,
          chunkIndex,
        })),
      };
    } catch (error) {
      throw this.toHttp(error, 'Answering');
    }
  }

  /**
 * Ask the assistant, streamed.
 *
 * POST, NOT GET, AND NOT @Sse(). Nest's @Sse() decorator registers a GET
 * route, and a GET carries the question in the URL — where it lands in
 * access logs, proxy logs, browser history and Referer headers. "How much
 * did I spend on my divorce lawyer last month" is not a query string. The
 * cost is that the browser cannot use EventSource, which is GET-only, so
 * the client reads the body with fetch instead; that is about fifteen lines
 * and it is the right trade for a bank.
 *
 * ONE FRAME PER LINE, `data: {json}`. Each frame carries its own `type`
 * rather than using SSE's named-event field, because a fetch-based reader
 * parses the body itself and a single shape is simpler than two.
 *
 * THE SAME MAPPING AS /ai/ask, and for the same reasons. `withheldAnswer`
 * never crosses this boundary either — it holds the figure the suppression
 * existed to withhold — and `sources` is fed by `citedSources`, the subset
 * the answer actually names.
 *
 * TYPED AS NODE'S ServerResponse, NOT express's Response. express is not a
 * dependency of this app — it arrives inside @nestjs/platform-express, and
 * pnpm's isolated node_modules makes it unresolvable from here, correctly.
 * Declaring @types/express would describe a package this app cannot import
 * and would pin it to express 4 or 5 over a route that uses neither's
 * distinctive features. Every member used below is on the Node response
 * that express's extends, so the accurate type is also the portable one.
 */
  @Post('ask/stream')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async askStream(
    @Body() body: AskDto,
    @CurrentUser() user: JwtPayload,
    @Res() res: ServerResponse,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx, and most CDNs, buffer a response until it completes — which
    // turns a token stream back into a slow request/response and would make
    // this whole step look broken in production while working locally.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // A customer who closes the tab should not have frames written at them.
    // Guarded inside `send` rather than at each call site, so the `done` and
    // `error` frames are covered too — they are the ones most likely to be
    // written after a client has gone.
    //
    // The model call itself is NOT cancelled: there is no AbortSignal threaded
    // through the provider seam yet, so the request still costs what it costs.
    // Logged as a gap rather than half-solved here.
    let clientGone = false;

    const send = (frame: unknown): void => {
      if (clientGone) return;
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    res.on('close', () => {
      clientGone = true;
    });

    try {
      const result = await this.answering.answerStream(
        body.question,
        // One instant for the whole turn, as on /ai/ask. See ToolContext.
        { userId: user.sub, now: new Date() },
        send,
      );

      // The authoritative text, after suppression. The client has been
      // accumulating deltas, but this is what it should end up displaying:
      // it is correct in the withheld case, where the deltas are not.
      send({
        type: 'done',
        answer: result.answer,
        sources: result.citedSources.map(({ source, heading, chunkIndex }) => ({
          source,
          heading,
          chunkIndex,
        })),
      });
    } catch (error) {
      // The status line went out with the headers, so a failure here cannot
      // become a 500 — it has to be a frame. `toHttp` is reused for its other
      // job: producing a message safe to show a customer, since provider
      // errors can echo prompt content and prompts carry financial data.
      send({ type: 'error', message: this.toHttp(error, 'Answering').message });
    } finally {
      res.end();
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
