import { Module } from '@nestjs/common';
import { TestCallGateway } from './test-call.gateway';
import { ShopifyModule } from '../shopify/shopify.module';

@Module({
  imports: [ShopifyModule],
  providers: [TestCallGateway],
  exports: [TestCallGateway],
})
export class TestCallModule {}
