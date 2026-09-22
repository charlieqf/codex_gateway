"""Local operator CLI; prints state, never token values."""
import argparse
import json
from pathlib import Path
from .client import Client


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('action', choices=('status', 'drain', 'resume'))
    parser.add_argument('--gpu', choices=('0', '1'))
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    client = Client(str(Path(config['runtime_directory'])/'scheduler.sock'), Path(config['token_files']['operator']).read_text().strip())
    if args.action == 'status':
        value = client.rpc('GET', '/v1/status')
    else:
        from .protocol import GPUS
        value = client.rpc('POST', '/v1/admin/'+args.action, {'scope': 'gpu' if args.gpu else 'all',
            'gpu_uuid': GPUS[int(args.gpu)] if args.gpu else None, 'reason_code': 'maintenance'})
    print(json.dumps(value, indent=2))


if __name__ == '__main__':
    main()
