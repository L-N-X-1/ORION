import time
import requests

url = "http://localhost:8004/run"
payload = {
    "event_id": "evt-test-006",
    "correlation_id": "corr-test-006",
    "event_type": "CONGESTION",
    "entity_id": "C00",
    "severity_hint": "critical",
    "sim_time_s": 200.0,
    "timestamp": "2026-05-18T10:00:00Z",
}
for i in range(30):
    try:
        r = requests.post(url, json=payload, timeout=10)
        print(r.status_code)
        print(r.text)
        break
    except Exception as exc:
        print("waiting", i, exc)
        time.sleep(2)
else:
    print("timed out waiting for ai-agent")
