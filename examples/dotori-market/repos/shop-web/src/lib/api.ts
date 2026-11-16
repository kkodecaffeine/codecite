// 브라우저에서 shop-api 를 부르는 주소. 배포 환경마다 다르다
export const SHOP_API_URL = process.env.NEXT_PUBLIC_SHOP_API_URL;

export function cancelOrder(orderId: string) {
  return fetch(`${SHOP_API_URL}/orders/${orderId}/cancel`, { method: 'POST' });
}

export function listCoupons() {
  return fetch(`${SHOP_API_URL}/coupons`);
}

export function issueCoupon(couponId: string) {
  return fetch(`${SHOP_API_URL}/coupons/${couponId}/issue`, { method: 'POST' });
}

// 주소를 호출하는 쪽이 넘긴다. 정적으로 읽을 수 없어 연결하지 못한다
export function getJson(endpoint: string) {
  return fetch(endpoint).then((response) => response.json());
}
