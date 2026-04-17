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
import type { Request } from 'express';
import { StripeService } from './stripe.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import type { PlanType } from '../common/constants/plans.constants';

@ApiTags('stripe')
@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Webhook Stripe (firma HMAC). Requiere rawBody en middleware. Eventos: checkout.session.completed, customer.subscription.*, invoice.paid o invoice.payment_succeeded (recibo al cliente por Resend).',
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
    await this.stripeService.handleWebhook(raw, signature);
    return { received: true };
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
