import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { LanguagesModule } from './languages/languages.module';
import { FishAudioModule } from './fish-audio/fish-audio.module';
import { AgentsModule } from './agents/agents.module';
import { TwilioModule } from './twilio/twilio.module';
import { HealthModule } from './health/health.module';
import { CallsModule } from './calls/calls.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
      isGlobal: true,
    }),
    CallsModule,
    AuthModule,
    UsersModule,
    LanguagesModule,
    FishAudioModule,
    AgentsModule,
    TwilioModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
