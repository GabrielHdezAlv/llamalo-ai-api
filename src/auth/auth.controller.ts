import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { RecoverDto } from './dto/recover.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { GetUser } from './get-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    return this.authService.registerUser(createUserDto);
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
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
