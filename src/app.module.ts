import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
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
import { TestCallModule } from './test-call/test-call.module';
import { SupportChatModule } from './support-chat/support-chat.module';
import { CryptoModule } from './crypto/crypto.module';
import { NewsModule } from './news/news.module';
import { MailerLiteModule } from './mailerlite/mailerlite.module';
import { LearningModule } from './learning/learning.module';
import { SystemLogsModule } from './system-logs/system-logs.module';
import { ProfileEventsModule } from './profile-events/profile-events.module';
import { PlanLimitsModule } from './plan-limits/plan-limits.module';
import { StripeModule } from './stripe/stripe.module';
import { WebhookActionsModule } from './webhook-actions/webhook-actions.module';

@Module({
  imports: [
    // SentryModule debe estar lo más arriba posible para que envuelva el resto
    // de módulos (instrumentación automática de controladores, providers, etc.)
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      // Carga .env como base y .env.{entorno} para sobrescribir (ej: .env.development)
      // Así funciona tanto si usas .env como .env.development
      envFilePath: ['.env', `.env.${process.env.NODE_ENV || 'development'}`],
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    CryptoModule,
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
    TestCallModule,
    SupportChatModule,
    NewsModule,
    MailerLiteModule,
    LearningModule,
    SystemLogsModule,
    ProfileEventsModule,
    PlanLimitsModule,
    StripeModule,
    WebhookActionsModule,
  ],
  controllers: [],
  providers: [
    // SentryGlobalFilter captura cualquier excepción no manejada y la reporta
    // a Sentry antes de delegar al comportamiento por defecto de NestJS.
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
  ],
})
export class AppModule {}
