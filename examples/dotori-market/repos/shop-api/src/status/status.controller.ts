import { Controller, Get } from '@nestjs/common';

@Controller('api/status')
export class StatusController {
  @Get()
  status() {
    return { service: 'shop-api', ok: true };
  }
}
