import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';

@Processor('refunds')
export class RefundProcessor {
  @Process('refund')
  handle(job: Job<{ orderId: number; amount: number }>) {
    return { orderId: job.data.orderId, refunded: job.data.amount };
  }
}
