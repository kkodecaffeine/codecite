from celery import Celery

app = Celery("shop-worker")

app.conf.beat_schedule = {
    "settle-daily-points": {
        "task": "worker.tasks.settle_daily_points",
        "schedule": 86400,
    },
}
