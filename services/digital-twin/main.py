"""
AURA-NET Digital Twin Service
Ticket: AN-TWN-001
Exposes the SimPy simulation engine via FastAPI.
"""
from fastapi import FastAPI

app = FastAPI(title="AURA-NET Digital Twin", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "digital-twin"}


@app.get("/metrics")
def get_metrics():
    # TODO: AN-TWN-001 — return live KPI stream from WorldState
    return {"message": "KPI endpoint coming in AN-TWN-001"}


@app.get("/topology")
def get_topology():
    # TODO: AN-TWN-002 — return cell graph
    return {"message": "Topology endpoint coming in AN-TWN-002"}


@app.post("/whatif/run")
def run_whatif():
    # TODO: AN-AGT-007 — clone WorldState, simulate, return delta
    return {"message": "What-if engine coming in AN-AGT-007"}
