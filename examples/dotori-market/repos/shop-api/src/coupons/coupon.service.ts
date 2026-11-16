import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Coupon } from './coupon.entity';

@Injectable()
export class CouponService {
  constructor(
    @InjectRepository(Coupon) private readonly coupons: Repository<Coupon>,
  ) {}

  list() {
    return this.coupons.find({ where: { expired: false } });
  }

  async issue(couponId: number) {
    return this.coupons.findOneByOrFail({ id: couponId });
  }

  async expireOld(now: Date) {
    await this.coupons.update({ expiresAt: LessThan(now) }, { expired: true });
  }
}
