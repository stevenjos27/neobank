import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LLM_PROVIDER_TOKEN,
  LlmError,
  LlmErrorKind,
  LlmProvider
} from './llm-provider.interface';

export type AiHealth = {
  status: 'ok' | 'degraded';
  provider: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  latencyMs?: number;
  reason?: LlmErrorKind;
  checkedAt: string;
};

const PROBE_TEXT = 'neobank health probe';

/**
 * A health check that calls a paid API is a health check that costs money.
 * An uptime monitor at 30s intervals is ~2,900 calls a day; cheap, but not
 * free, and entirely wasted. One live probe a minute is plenty.
 */
const CACHE_MS = 60_000;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private cached?: { at: number; result: AiHealth };

  constructor(@Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider) { }

  async health(): Promise<AiHealth> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) {
      return this.cached.result;
    }

    const identity = {
      provider: this.llm.name,
      chatModel: this.llm.chatModel,
      embeddingModel: this.llm.embeddingModel,
      embeddingDimensions: this.llm.embeddingDimensions,
      checkedAt: new Date().toISOString(),
    };

    const started = Date.now();
    let result: AiHealth;

    try {
      await this.llm.embed([PROBE_TEXT]);
      result = { ...identity, status: 'ok', latencyMs: Date.now() - started };
    }
    catch (error) {
      // Report the failure, don't throw it. A health endpoint that 500s tells
      // you the app is unwell; one that says `spend_limit` tells you what to
      // go and fix.
      const reason = error instanceof LlmError ? error.kind : 'unknown';
      this.logger.warn(`AI health probe failed: ${reason}`);
      result = { ...identity, status: 'degraded', reason };
    }

    // Failures are cached too — repeatedly probing a spend-limited account
    // achieves nothing. Cost: up to 60s of stale "degraded" after you fix it.
    this.cached = { at: now, result };
    return result;
  }
}
