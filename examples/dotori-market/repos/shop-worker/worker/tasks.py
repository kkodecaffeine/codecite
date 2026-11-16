import os

import requests

from worker.app import app

SHOP_API_URL = os.environ["SHOP_API_URL"]
PAYMENT_URL = "https://pay.example.com/v1/refunds"


@app.task(name="points.earn")
def earn_points(member_id, amount):
    """주문을 마친 회원에게 적립금을 더하도록 shop-api 에 알린다"""
    response = requests.post(
        f"{SHOP_API_URL}/points/earn",
        json={"memberId": member_id, "amount": amount},
        timeout=5,
    )
    response.raise_for_status()
    return response.json()


@app.task
def settle_daily_points():
    """하루치 적립 대기 건을 모아 earn_points 로 넘긴다"""
    for member_id, amount in pending_points():
        earn_points.delay(member_id, amount)


@app.task
def request_refund(order_id, amount):
    """바깥 결제 대행사에 환불을 요청한다. 내부 저장소와 잇지 않는다"""
    return requests.post(PAYMENT_URL, json={"orderId": order_id, "amount": amount}, timeout=10)


def check_status(base_url):
    """주소를 인자로 받으므로 어느 저장소의 /api/status 인지 정할 수 없다"""
    return requests.get(f"{base_url}/api/status", timeout=3)


def pending_points():
    return []
