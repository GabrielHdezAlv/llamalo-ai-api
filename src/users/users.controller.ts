import {
  Controller,
  Get,
  Put,
  Post,
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
  async getProfile(@GetUser('uid') userId: string): Promise<UserProfileResponse> {
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
}
