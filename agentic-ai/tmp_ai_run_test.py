import requests
payload = {
    'event_id': 'evt-test-001',
    'correlation_id': 'corr-test-001',
    'event_type': 'CONGESTION',
    'entity_id': 'C00',
    'severity_hint': 'critical',
    'sim_time_s': 200.0,
    'timestamp': '2026-05-18T10:00:00Z'
}
response = requests.post('http://localhost:8004/run', json=payload)
print(response.status_code)
print(response.text)
