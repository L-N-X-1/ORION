"""
AURA-NET Collector Service
Ticket: AN-COL-001
Telemetry ingestion via HTTP, MQTT, and Kafka.
"""
from fastapi import FastAPI

app = FastAPI(title="AURA-NET Collector", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "collector"}
