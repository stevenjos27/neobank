import { Logger, Module } from "@nestjs/common";
import { LLM_PROVIDER_TOKEN, LlmProvider } from "./llm-provider.interface";
import { OpenAiProvider } from "./openai.provider";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { MockLlmProvider } from "./mock.provider";
import { CategoriserService } from "./categoriser.service";
import { IngestionService } from "./ingestion.service";
import { RetrievalService } from "./retrieval.service";
import { AggregatesService } from "./aggregates.service";
import { ToolRegistryService } from "./tool-registry.service";

const llmProviderRegistration = {
  provide: LLM_PROVIDER_TOKEN,
  useFactory: (): LlmProvider => {
    const configured = (process.env.AI_PROVIDER ?? 'openai').toLowerCase();

    // Instantiated HERE rather than listed in `providers`, so that selecting
    // the mock never constructs OpenAiProvider and never demands a key.
    //
    // Note this factory still runs EAGERLY at bootstrap — Nest instantiates
    // module providers on module init. It defers construction past module
    // *definition*, not past startup. So `AI_PROVIDER=openai` with no key
    // fails the whole boot, which is why CI has to select the mock.
    let provider: LlmProvider;
    switch (configured) {
      case 'openai':
        provider = new OpenAiProvider();
        break;

      case 'mock':
        // The mock returns hash-derived categories and directionless vectors.
        // In production that is not a degraded assistant, it is a confident
        // one with nothing behind it — the worst possible failure mode,
        // because everything looks like it works. Refuse to boot.
        if (process.env.NODE_ENV === 'production') {
          throw new Error(
            'AI_PROVIDER=mock is not permitted when NODE_ENV=production. The mock ' +
            'returns deterministic nonsense; serving it would look like success.',
          );
        }
        provider = new MockLlmProvider();
        break;

      default:
        // Fail loudly. A typo'd AI_PROVIDER silently falling back to OpenAI
        // is worse than not booting: you would be billed by a provider you
        // thought you had switched away from.
        throw new Error(
          `Unknown AI_PROVIDER "${configured}". Supported values: openai, mock.`,
        );
    }

    // One line at startup that states the whole AI configuration. Cheap, and
    // it turns "why is it using the wrong model?" into a scroll instead of an
    // investigation.
    new Logger('AiModule').log(
      `provider=${provider.name} chat=${provider.chatModel} ` +
      `embeddings=${provider.embeddingModel} (${provider.embeddingDimensions}d)`,
    );

    return provider;
  },
};

@Module({
  controllers: [AiController],
  providers: [
    llmProviderRegistration,
    AiService,
    CategoriserService,
    IngestionService,
    RetrievalService,
    AggregatesService,
    ToolRegistryService
  ],
  // IngestionService is exported because Step 2's admin route and Step 5's
  // eval harness both drive it from outside this module. PrismaModule is
  // @Global(), so nothing needs importing for PrismaService.
  exports: [AiService, IngestionService, LLM_PROVIDER_TOKEN],
})
export class AiModule { }
