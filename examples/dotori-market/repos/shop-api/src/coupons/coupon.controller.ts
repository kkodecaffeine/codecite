import { Controller, Get, Param, Post } from '@nestjs/common';
import { CouponService } from './coupon.service';

@Controller('coupons')
export class CouponController {
  constructor(private readonly couponService: CouponService) {}

  @Get()
  list() {
    return this.couponService.list();
  }

  @Post(':couponId/issue')
  issue(@Param('couponId') couponId: string) {
    return this.couponService.issue(Number(couponId));
  }
}
