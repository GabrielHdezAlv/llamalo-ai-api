import {
  BadRequestException,
  Body,
  Controller,
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
    summary: 'Webhook Stripe (firma HMAC). Requiere rawBody en middleware.',
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
    },
  ) {
    return this.stripeService.createCheckoutSession({
      userId,
      plan: body.plan,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
    });
  }

  @Post('billing-portal')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Portal de facturación Stripe' })
  async billingPortal(
    @GetUser('uid') userId: string,
    @Body() body: { returnUrl: string; stripeCustomerId: string },
  ) {
    return this.stripeService.createBillingPortalSession({
      customerId: body.stripeCustomerId,
      returnUrl: body.returnUrl,
    });
  }
}
