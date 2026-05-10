import { Module, forwardRef } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { ShopifyService } from './shopify.service';
import { CryptoModule } from '../crypto/crypto.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [CryptoModule, forwardRef(() => AgentsModule)],
  controllers: [ShopifyController],
  providers: [ShopifyService],
  exports: [ShopifyService],
})
export class ShopifyModule {}
