import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { LanguagesModule } from './languages/languages.module';
import { AgentsModule } from './agents/agents.module';
import { TwilioModule } from './twilio/twilio.module';
import { HealthModule } from './health/health.module';
import { CallsModule } from './calls/calls.module';
import { MetricsModule } from './metrics/metrics.module';
import { ShopifyModule } from './shopify/shopify.module';
import { KnowledgeBaseModule } from './knowledge-base/knowledge-base.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    CallsModule,
    AuthModule,
    UsersModule,
    LanguagesModule,
    AgentsModule,
    TwilioModule,
    HealthModule,
    MetricsModule,
    ShopifyModule,
    KnowledgeBaseModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
