import { issueCoupon, listCoupons } from '../lib/api';

export async function CouponList() {
  const response = await listCoupons();
  const coupons: Array<{ id: string }> = await response.json();
  return coupons.map((coupon) => ({
    id: coupon.id,
    issue: () => issueCoupon(coupon.id),
  }));
}
