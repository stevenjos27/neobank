import { Logger, Module } from "@nestjs/common";
import { LLM_PROVIDER_TOKEN, LlmProvider } from "./llm-provider.interface";
import { OpenAiProvider } from "./openai.provider";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";

const llmProviderRegistration = {
  provide: LLM_PROVIDER_TOKEN,
  useFactory: (): LlmProvider => {
    const configured = (process.env.AI_PROVIDER ?? 'openai').toLowerCase();

    // Instantiated HERE, not listed in `providers`. See note below — this is
    // what lets CI boot with no OPENAI_API_KEY at all.
    let provider: LlmProvider;
    switch (configured) {
      case 'openai':
        provider = new OpenAiProvider();
        break;
      default:
        // Fail loudly. A typo'd AI_PROVIDER silently falling back to OpenAI
        // is worse than not booting: you would be billed by a provider you
        // thought you had switched away from.
        throw new Error(
          `Unknown AI_PROVIDER "${configured}". Supported values: openai.`,
        );
    }

    // One line at startup that states the whole AI configuration. Cheap, and
    // it turns "why is it using the wrong model?" into a scroll instead of an
    // investigation.
    new Logger('AiModule').log(`provider=${provider.name} chat=${provider.chatModel} ` + `embeddings=${provider.embeddingModel} (${provider.embeddingDimensions}d)`,
    );

    return provider;
  }
};

@Module({
  controllers: [AiController],
  providers: [llmProviderRegistration, AiService],
  // Both are exported: Step 2's ingestion pipeline injects LLM_PROVIDER_TOKEN
  // directly to batch-embed, without going through AiService.
  exports: [AiService, LLM_PROVIDER_TOKEN],
})
export class AiModule { }
