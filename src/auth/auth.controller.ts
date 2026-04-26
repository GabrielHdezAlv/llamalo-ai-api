import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { RecoverDto } from './dto/recover.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { VerifyDeviceLoginDto } from './dto/verify-device-login.dto';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { GetUser } from './get-user.decorator';

@ApiTags('auth')
@Controller('auth')
@Throttle({ default: { limit: 5, ttl: 60000 } })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    return this.authService.registerUser(createUserDto);
  }

  @Post('register/complete-plan-selection')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Marca como completada la elección de plan o prueba gratuita tras el registro',
  })
  async completePlanSelection(@GetUser('uid') userId: string) {
    return this.authService.completePlanSelection(userId);
  }

  @Delete('register/cancel')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancela el registro si aún no se eligió plan ni prueba (borra usuario)',
  })
  async cancelIncompleteRegistration(@GetUser('uid') userId: string) {
    return this.authService.cancelIncompleteRegistration(userId);
  }

  @Post('google')
  @ApiOperation({ summary: 'Autenticación con Google' })
  @ApiResponse({
    status: 200,
    description: 'Login exitoso',
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        userId: { type: 'string' },
      },
    },
  })
  async googleLogin(@Body() body: { token: string }) {
    return this.authService.googleLogin(body.token);
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('verify-device-login')
  @ApiOperation({
    summary:
      'Completar login tras código enviado al correo (nuevo dispositivo/navegador)',
  })
  async verifyDeviceLogin(@Body() dto: VerifyDeviceLoginDto) {
    return this.authService.verifyDeviceLogin(dto);
  }

  @Post('recover')
  async recover(@Body() recoverDto: RecoverDto) {
    return this.authService.recoverPassword(recoverDto);
  }

  @Post('change-password')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambiar contraseña del usuario autenticado' })
  @ApiResponse({
    status: 200,
    description: 'Contraseña actualizada correctamente',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Contraseña actualizada correctamente',
        },
      },
    },
  })
  async changePassword(
    @GetUser('uid') userId: string,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, changePasswordDto);
  }

  @Post('verify-email')
  @ApiOperation({ summary: 'Verificar email del usuario' })
  @ApiResponse({
    status: 200,
    description: 'Email verificado correctamente',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Email verificado correctamente',
        },
      },
    },
  })
  async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    return await this.authService.verifyEmail(verifyEmailDto.token);
  }

  @Post('resend-verification')
  @ApiOperation({ summary: 'Reenviar email de verificación' })
  @ApiResponse({
    status: 200,
    description: 'Email de verificación reenviado',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Email de verificación reenviado correctamente',
        },
      },
    },
  })
  async resendVerification(@Body() resendDto: ResendVerificationDto) {
    return await this.authService.resendVerificationEmail(resendDto.email);
  }
}
