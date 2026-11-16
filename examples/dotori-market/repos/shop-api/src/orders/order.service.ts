import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bull';
import { Repository } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectQueue('refunds') private readonly refundQueue: Queue,
  ) {}

  find(orderId: number) {
    return this.orders.findOneBy({ id: orderId });
  }

  async cancel(orderId: number) {
    const order = await this.orders.findOneByOrFail({ id: orderId });
    if (order.status === 'SHIPPED') {
      throw new Error('shipped orders cannot be cancelled');
    }
    order.status = 'CANCELLED';
    await this.orders.save(order);
    await this.refundQueue.add('refund', {
      orderId,
      amount: order.totalAmount,
    });
    return order;
  }
}
