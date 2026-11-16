import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CouponService } from './coupon.service';

@Injectable()
export class CouponScheduler {
  constructor(private readonly couponService: CouponService) {}

  // 매일 새벽 기한이 지난 쿠폰을 닫는다
  @Cron('0 0 4 * * *', { name: 'close-expired-coupons' })
  closeExpired() {
    return this.couponService.expireOld(new Date());
  }
}
