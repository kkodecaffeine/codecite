import { Args, Query, Resolver } from '@nestjs/graphql';
import { Order } from './order.entity';
import { OrderService } from './order.service';

@Resolver(() => Order)
export class OrderResolver {
  constructor(private readonly orderService: OrderService) {}

  @Query(() => Order, { name: 'order' })
  findOrder(@Args('id') id: string) {
    return this.orderService.find(Number(id));
  }
}
