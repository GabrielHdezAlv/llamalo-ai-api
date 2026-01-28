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
  @ApiOperation({ summary: 'Actualizar perfil del usuario' })
  @ApiResponse({ status: 200, type: UpdateProfileResponseDto })
  async updateProfile(
    @GetUser('uid') userId: string,
    @Body() updateDto: UpdateProfileDto,
  ) {
    return this.usersService.updateUserProfile(userId, updateDto);
  }

  @Post('profile/image')
  @UseGuards(FirebaseAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: 'Subir imagen de perfil' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          format: 'binary',
          description: 'Imagen de perfil (PNG o JPG, máx 5MB)',
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
}
