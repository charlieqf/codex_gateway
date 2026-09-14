import datetime
import json
import subprocess

TARGET = 'req-c16a568d-b565-4e59-81dd-2ec8bdca11d2'
SINCE = '2026-09-14T00:00:00Z'
UNTIL = datetime.datetime.now(datetime.timezone.utc).isoformat()
CONTAINER = 'codex_gateway_r760-gateway-1'
meta = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER], text=True))[0]
run = subprocess.run(['docker', 'logs', '--since', SINCE, '--until', UNTIL, CONTAINER],
                     capture_output=True, text=True, check=True)
incoming, completed = {}, {}
parsed_count = non_json_count = 0
timestamps = []
for line in (run.stdout + '\n' + run.stderr).splitlines():
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except ValueError:
        non_json_count += 1
        continue
    if not isinstance(event, dict):
        continue
    parsed_count += 1
    if isinstance(event.get('time'), (int, float)):
        timestamps.append(event['time'])
    request_id = event.get('reqId')
    if not request_id:
        continue
    req = event.get('req')
    if isinstance(req, dict):
        path = str(req.get('url', '')).split('?')[0]
        if path.startswith('/gateway/admin/billing/') or request_id == TARGET:
            incoming[request_id] = {
                'request_id': request_id, 'time': event.get('time'),
                'method': req.get('method'), 'path': path,
                'request_body_logged': 'body' in req or 'body' in event,
            }
    res = event.get('res')
    if isinstance(res, dict):
        completed[request_id] = {
            'status_code': res.get('statusCode'), 'response_time_ms': event.get('responseTime')
        }

def utc(value):
    return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).isoformat() if value else None

rows = []
counts = {}
for request_id, event in incoming.items():
    result = {**event, **completed.get(request_id, {})}
    result['started_at'] = utc(result.pop('time'))
    key = (result['method'], result['path'], result.get('status_code'))
    counts[key] = counts.get(key, 0) + 1
    if result['method'] != 'GET' or request_id == TARGET:
        rows.append(result)
rows.sort(key=lambda row: row['started_at'] or '')
incident_start = '2026-09-14T05:34:09.621000+00:00'
incident_end = '2026-09-14T05:47:33.142000+00:00'
provision_paths = ['/gateway/admin/billing/v1/subjects', '/gateway/admin/billing/v1/subjects/resolve']
provision_rows = [r for r in rows if r['method'] == 'POST' and r['path'] in provision_paths]
report = {
    'checked_at': UNTIL, 'since': SINCE,
    'release': meta['Config']['Labels'].get('org.opencontainers.image.revision'),
    'container_started_at': meta['State']['StartedAt'],
    'container_health': meta['State'].get('Health', {}).get('Status'),
    'parsed_log_lines': parsed_count, 'non_json_lines': non_json_count,
    'first_available_log': utc(min(timestamps)) if timestamps else None,
    'latest_available_log': utc(max(timestamps)) if timestamps else None,
    'billing_http_counts': [dict(method=k[0], path=k[1], status_code=k[2], count=v) for k,v in counts.items()],
    'provision_requests': provision_rows,
    'target_http': [r for r in rows if r['request_id'] == TARGET],
    'provision_requests_in_incident_window': [r for r in provision_rows if incident_start <= r['started_at'] <= incident_end],
    'limit': 'Container HTTP logs only; request bodies and external-backend logs are unavailable. No inference that unrelated same-day provisioning requests belong to the target.'
}
print(json.dumps(report, indent=2))
