import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { TwilioService } from './twilio.service';
import { TwilioConfigDto } from './dto/twilio-config.dto';
import { TwilioConfigResponseDto } from './dto/twilio-config-response.dto';
import { TwilioInfoResponseDto } from './dto/twilio-info-response.dto';
import { ValidatePhoneDto } from './dto/validate-phone.dto';
import { ValidatePhoneResponseDto } from './dto/validate-phone-response.dto';
import { DeletePhoneDto } from './dto/delete-phone.dto';
import { DeletePhoneResponseDto } from './dto/delete-phone-response.dto';
import { DeleteTwilioAccountDto } from './dto/delete-twilio-account.dto';
import { CreatePhoneDto } from './dto/create-phone.dto';
import { CreatePhoneResponseDto } from './dto/create-phone-response.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('twilio')
@ApiBearerAuth()
@Controller('twilio')
export class TwilioController {
  constructor(private readonly twilioService: TwilioService) {}

  @Post('config')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Configurar credenciales de Twilio del usuario' })
  @ApiResponse({ status: 200, type: TwilioConfigResponseDto })
  async setConfig(
    @GetUser('uid') userId: string,
    @Body() config: TwilioConfigDto,
  ) {
    return this.twilioService.setTwilioConfig(userId, config);
  }

  @Get('info')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Obtener configuración de Twilio y minutos consumidos',
  })
  @ApiResponse({ status: 200, type: TwilioInfoResponseDto })
  async getInfo(@GetUser('uid') userId: string) {
    return this.twilioService.getTwilioInfo(userId);
  }

  @Post('validate-phone')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Verificar si un número de teléfono está disponible en la cuenta de Twilio del usuario',
  })
  @ApiResponse({ status: 201, type: ValidatePhoneResponseDto })
  @ApiResponse({ status: 400, description: 'Número no disponible' })
  async validatePhone(
    @GetUser('uid') userId: string,
    @Body() validatePhoneDto: ValidatePhoneDto,
  ) {
    return this.twilioService.validatePhoneNumber(
      userId,
      validatePhoneDto.countryCode,
      validatePhoneDto.number,
      validatePhoneDto.twilioAccountId,
    );
  }

  @Post('phone-number')
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crear un número de teléfono',
    description:
      'Valida las credenciales de Twilio, verifica que el número existe en la cuenta de Twilio y lo agrega a los números del usuario si no existe ya.',
  })
  @ApiResponse({ status: 201, type: CreatePhoneResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Credenciales inválidas o número ya existe',
  })
  async createPhoneNumber(
    @GetUser('uid') userId: string,
    @Body() createPhoneDto: CreatePhoneDto,
  ) {
    return this.twilioService.createPhoneNumber(
      userId,
      createPhoneDto.countryCode,
      createPhoneDto.number,
      createPhoneDto.twilioSid,
      createPhoneDto.twilioToken,
    );
  }

  @Delete('phone-number')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Eliminar un número de teléfono',
    description:
      'Elimina un número de teléfono del array phoneNumbers del usuario. Si algún agente tiene este número, se eliminará el número del agente y se pondrá su estado a "Inactivo".',
  })
  @ApiResponse({ status: 200, type: DeletePhoneResponseDto })
  @ApiResponse({ status: 404, description: 'Número de teléfono no encontrado' })
  async deletePhoneNumber(
    @GetUser('uid') userId: string,
    @Body() deletePhoneDto: DeletePhoneDto,
  ) {
    return this.twilioService.deletePhoneNumber(userId, deletePhoneDto.phoneId);
  }

  @Delete('account')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Eliminar cuenta de Twilio',
    description:
      'Desvincula una cuenta específica o todas las cuentas de Twilio asociadas al usuario.',
  })
  @ApiResponse({ status: 200, description: 'Cuenta eliminada correctamente' })
  async deleteTwilioAccount(
    @GetUser('uid') userId: string,
    @Query() deleteTwilioAccountDto: DeleteTwilioAccountDto,
  ) {
    return this.twilioService.deleteTwilioAccount(
      userId,
      deleteTwilioAccountDto.twilioAccountId !== undefined
        ? Number(deleteTwilioAccountDto.twilioAccountId)
        : undefined,
    );
  }
}
