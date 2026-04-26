import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import * as Sentry from '@sentry/nestjs';
import type { Request } from 'express';
import { StripeService } from './stripe.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import type { PlanType } from '../common/constants/plans.constants';
import { AuthService } from '../auth/auth.service';

@ApiTags('stripe')
@Controller('stripe')
export class StripeController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly authService: AuthService,
  ) {}

  @Post('webhook')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Webhook Stripe (firma HMAC). Requiere rawBody en middleware. Eventos: checkout.session.completed, customer.subscription.*, subscription_schedule.updated|completed|released (downgrade programado vía portal), invoice.paid o invoice.payment_succeeded (recibo), invoice.payment_failed (aviso cobro + sync suscripción).',
  })
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature?: string,
  ) {
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException(
        'rawBody requerido para verificar firma Stripe (middleware en main.ts)',
      );
    }
    // Etiquetamos el scope para que cualquier excepción lanzada por
    // handleWebhook llegue a Sentry con el contexto correcto (tipo de evento,
    // id, etc.) sin silenciar el error: Stripe reintentará si devolvemos 5xx.
    return Sentry.withScope(async (scope) => {
      scope.setTag('webhook', 'stripe');
      scope.setContext('stripe_signature', {
        present: !!signature,
        length: signature?.length ?? 0,
      });
      try {
        await this.stripeService.handleWebhook(raw, signature);
        return { received: true };
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });
  }

  @Post('onboarding-free-trial')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Onboarding: 7 días gratis sin tarjeta — crea Customer en Stripe (y opcionalmente suscripción €0) y marca selección de plan completada',
  })
  async onboardingFreeTrial(@GetUser('uid') userId: string) {
    await this.stripeService.ensureOnboardingFreeCustomer(userId);
    return this.authService.completePlanSelection(userId);
  }

  @Post('checkout-session')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear sesión de Checkout para suscripción' })
  async checkoutSession(
    @GetUser('uid') userId: string,
    @Body()
    body: {
      plan: PlanType;
      successUrl: string;
      cancelUrl: string;
      /** Solo plan `starter`: `trial` (7 días, tarjeta obligatoria; cobro al acabar si no cancelan) o `pay`. */
      starterMode?: 'trial' | 'pay';
      /** `year` usa precios anuales (`STRIPE_PRICE_*_ANNUAL`). Por defecto mensual. */
      billingInterval?: 'month' | 'year';
    },
  ) {
    return this.stripeService.createCheckoutSession({
      userId,
      plan: body.plan,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      starterMode: body.starterMode,
      billingInterval: body.billingInterval,
    });
  }

  @Post('billing-portal')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Portal de facturación Stripe' })
  async billingPortal(
    @GetUser('uid') userId: string,
    @Body() body: { returnUrl: string },
  ) {
    return this.stripeService.createBillingPortalSessionForUser({
      userId,
      returnUrl: body.returnUrl,
    });
  }

  @Post('subscription/change-plan')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cambiar plan de la suscripción actual (precio base + metered). Mantiene mensual/anual y prorratea.',
  })
  async changeSubscriptionPlan(
    @GetUser('uid') userId: string,
    @Body() body: { plan: PlanType },
  ) {
    return this.stripeService.changeSubscriptionPlanForUser({
      userId,
      plan: body.plan,
    });
  }

  @Post('subscription/preview-plan-change')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Vista previa de factura (sin aplicar cambio) al sustituir plan base + metered.',
  })
  async previewPlanChange(
    @GetUser('uid') userId: string,
    @Body() body: { plan: PlanType },
  ) {
    return this.stripeService.previewSubscriptionPlanChangeForUser({
      userId,
      plan: body.plan,
    });
  }

  @Get('latest-invoice')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Última factura (enlaces PDF / página alojada)',
    description:
      'Devuelve URLs de Stripe para la factura pagada más reciente del cliente asociado al usuario.',
  })
  async latestInvoice(@GetUser('uid') userId: string) {
    return this.stripeService.getLatestInvoiceDownloadForUser(userId);
  }
}
