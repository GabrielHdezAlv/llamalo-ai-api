import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import type { UploadFile, UserProfileResponse } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { UpdateProfileResponseDto } from './dto/update-profile-response.dto';
import { UploadImageResponseDto } from './dto/upload-image-response.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('phone-numbers')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Obtener los números de teléfono del usuario' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        phoneNumbers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              phoneId: { type: 'number' },
              countryCode: { type: 'string' },
              number: { type: 'string' },
              state: { type: 'string', enum: ['Activo', 'Inactivo'] },
              importedBy: { type: 'string' },
            },
          },
        },
      },
    },
  })
  async getPhoneNumbers(
    @GetUser('uid') userId: string,
    @Query('q') query?: string,
  ): Promise<{
    phoneNumbers: Array<{
      phoneId: number;
      countryCode: string;
      number: string;
      state: 'Activo' | 'Inactivo';
      importedBy: string;
    }>;
  }> {
    return this.usersService.getUserPhoneNumbers(userId, query);
  }

  @Get('profile')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Obtener perfil del usuario autenticado' })
  @ApiResponse({ status: 200, type: UserProfileResponseDto })
  async getProfile(
    @GetUser('uid') userId: string,
  ): Promise<UserProfileResponse> {
    return this.usersService.getUserProfile(userId);
  }

  @Put('profile')
  @UseGuards(FirebaseAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({
    summary: 'Actualizar perfil del usuario (con imagen opcional)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del usuario' },
        lastname: { type: 'string', description: 'Apellido del usuario' },
        country: { type: 'string', description: 'Código de país' },
        marketingConsent: {
          type: 'boolean',
          description: 'Consentimiento de marketing',
        },
        hasCompletedSetup: {
          type: 'boolean',
          description: 'Indica si el usuario completó el onboarding',
        },
        image: {
          type: 'string',
          format: 'binary',
          description: 'Imagen de perfil opcional (PNG, JPG o WebP, máx 5MB)',
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: UpdateProfileResponseDto })
  async updateProfile(
    @GetUser('uid') userId: string,
    @Body() updateDto: UpdateProfileDto,
    @UploadedFile() file?: UploadFile,
  ) {
    // Si hay archivo, subirlo primero
    if (file) {
      const imageResult = await this.usersService.uploadProfileImage(
        userId,
        file,
      );
      updateDto.profileImage = imageResult.imageUrl;
    }

    return this.usersService.updateUserProfile(userId, updateDto);
  }

  @Post('profile/image')
  @UseGuards(FirebaseAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: 'Subir imagen de perfil (endpoint alternativo)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          format: 'binary',
          description: 'Imagen de perfil (PNG, JPG o WebP, máx 5MB)',
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: UploadImageResponseDto })
  async uploadImage(
    @GetUser('uid') userId: string,
    @UploadedFile() file: UploadFile,
  ) {
    return this.usersService.uploadProfileImage(userId, file);
  }

  @Delete('account')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Eliminar cuenta del usuario',
    description:
      'Programa la eliminación de la cuenta para dentro de 10 días. Durante este período, el usuario puede recuperar sus datos. Después de 10 días, la cuenta será marcada como "Eliminado".',
  })
  @ApiResponse({
    status: 200,
    description: 'Cuenta programada para eliminación',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Cuenta programada para eliminación en 10 días',
        },
        scheduledDeletionDate: {
          type: 'string',
          format: 'date-time',
          example: '2026-02-06T10:30:00.000Z',
        },
      },
    },
  })
  async deleteAccount(@GetUser('uid') userId: string) {
    return this.usersService.scheduleAccountDeletion(userId);
  }

  @Post('rewards/redeem')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Canjear recompensa y añadir minutos extra',
    description: 'Permite al usuario canjear una recompensa para obtener minutos adicionales.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        rewardType: { type: 'string', description: 'El tipo de recompensa a canjear (ej. Trustpilot, instagram)' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Recompensa canjeada correctamente',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        extraMinutes: { type: 'number' },
        redeemedRewards: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  async redeemReward(
    @GetUser('uid') userId: string,
    @Body('rewardType') rewardType: string,
  ) {
    if (!rewardType) {
      throw new BadRequestException('El tipo de recompensa es requerido');
    }
    return this.usersService.redeemReward(userId, rewardType);
  }

  @Post('plan')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Cambiar el plan del usuario (Upgrade/Downgrade)',
  })
  @ApiResponse({
    status: 200,
    description: 'Plan actualizado correctamente',
  })
  @ApiResponse({
    status: 403,
    description:
      'Producción: cambio manual desactivado salvo ALLOW_PLAN_CHANGE_MOCK=true',
  })
  async changePlan(
    @GetUser('uid') userId: string,
    @Body() changePlanDto: ChangePlanDto,
  ) {
    return this.usersService.changePlan(userId, changePlanDto.plan);
  }
}
