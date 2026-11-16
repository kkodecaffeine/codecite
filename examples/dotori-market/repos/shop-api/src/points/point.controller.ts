import { Body, Controller, Post } from '@nestjs/common';
import { PointService } from './point.service';

@Controller('points')
export class PointController {
  constructor(private readonly pointService: PointService) {}

  @Post('earn')
  earn(@Body() body: { memberId: number; amount: number }) {
    return this.pointService.earn(body.memberId, body.amount);
  }
}
