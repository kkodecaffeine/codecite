import { Controller, Get, Param, Post } from '@nestjs/common';
import { OrderService } from './order.service';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get(':orderId')
  find(@Param('orderId') orderId: string) {
    return this.orderService.find(Number(orderId));
  }

  @Post(':orderId/cancel')
  cancel(@Param('orderId') orderId: string) {
    return this.orderService.cancel(Number(orderId));
  }
}
