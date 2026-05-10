"""
AURA-NET API Gateway
Ticket: AN-GWY-001
Central entry point — proxies to downstream services with auth + RBAC.
"""
from fastapi import FastAPI

app = FastAPI(title="AURA-NET API Gateway", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "api-gateway"}
