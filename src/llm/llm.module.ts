import { Module } from '@nestjs/common';
import { GptService } from './gpt.service';
@Module({ providers: [GptService], exports: [GptService] })
export class LlmModule {}
