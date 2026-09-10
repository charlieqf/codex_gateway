import collections
import hashlib
import json
import pathlib
import sqlite3

root = pathlib.Path('/tmp/doctor-research-repair-20260910-heldouta67d2d3')
manifest = json.loads((root / 'audit-manifest.json').read_text())
assert manifest.get('code_unchanged_after_test') and manifest['probe_exit_code'] == 0
results = json.loads((root / 'full-results.json').read_text())
assert len(results) == 8
events = [json.loads(line) for line in (root / 'probe.jsonl').read_text().splitlines()]
artifact_count = 0
for index, row in enumerate(results):
    case = root / ('full-' + str(index))
    d = sqlite3.connect('file:' + str(case / 'research.db') + '?mode=ro', uri=True)
    d.execute('pragma query_only=on')
    d.row_factory = sqlite3.Row
    run = dict(d.execute('select run_id,status,terminal_reason,active_elapsed_ms,warning_codes_json from research_runs').fetchone())
    run['warnings'] = json.loads(run.pop('warning_codes_json'))
    row['run'] = run
    checkpoint = d.execute("select payload_json from research_checkpoints where stage='resolve_identity'").fetchone()
    row['identity_checkpoint'] = json.loads(checkpoint['payload_json']) if checkpoint else None
    row['search_attempts'] = [e for e in events if e.get('event') == 'probe_external_request' and e.get('name') == row['name'] and e.get('host') == 'serpapi.com']
    row['artifact_files_verified'] = 0
    for a in d.execute('select storage_path,sha256,size_bytes from research_artifacts'):
        p = case / 'artifacts' / a['storage_path']
        assert p.resolve().is_relative_to((case / 'artifacts').resolve()) and not p.is_symlink()
        data = p.read_bytes()
        assert len(data) == a['size_bytes'] and hashlib.sha256(data).hexdigest() == a['sha256']
        row['artifact_files_verified'] += 1
        artifact_count += 1
    assert d.execute('pragma quick_check').fetchone()[0] == 'ok'
    assert len(d.execute('pragma foreign_key_check').fetchall()) == 0
    d.close()
payload = dict(manifest=manifest, results=results, verified_artifacts=artifact_count,
               outcome_counts=dict(collections.Counter(row['outcome'] for row in results)),
               boundary='One complete workflow attempt per case, including adapter retries; no Worker requeue loop or public API admission.')
(root / 'audit-results.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2))
print(json.dumps(dict(verified_artifacts=artifact_count, outcome_counts=payload['outcome_counts'],
                     results=[dict(name=r['name'], elapsed_ms=r['elapsed_ms'], outcome=r['outcome'],
                                   reason=r.get('reason'), warnings=r['run']['warnings'],
                                   identity=r['identity_checkpoint']) for r in results]), ensure_ascii=False))
