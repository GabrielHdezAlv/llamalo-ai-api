import { Module } from '@nestjs/common';
import { SupportChatController } from './support-chat.controller';
import { SupportChatService } from './support-chat.service';
import { SupportChatGateway } from './support-chat.gateway';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';
import { AuthModule } from '../auth/auth.module'; // Importar AuthModule para usar EmailService

@Module({
  imports: [KnowledgeBaseModule, AuthModule],
  controllers: [SupportChatController],
  providers: [SupportChatService, SupportChatGateway],
  exports: [SupportChatGateway],
})
export class SupportChatModule {}
