import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { FishAudioService } from './fish-audio.service';
import { SetFirstInteractionDto } from './dto/set-first-interaction.dto';
import { FirstInteractionResponseDto } from './dto/first-interaction-response.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('fish-audio')
@ApiBearerAuth()
@Controller('fish-audio')
export class FishAudioController {
  constructor(private readonly fishAudioService: FishAudioService) {}

  @Post('setFirstInteraction')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Generar audio de primera interacción con Fish.audio',
  })
  @ApiResponse({ status: 200, type: FirstInteractionResponseDto })
  async setFirstInteraction(
    @GetUser('uid') userId: string,
    @Body() dto: SetFirstInteractionDto,
  ) {
    return this.fishAudioService.setFirstInteraction(
      userId,
      dto.firstInteraction,
    );
  }
}
