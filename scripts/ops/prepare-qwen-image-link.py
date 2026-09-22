"""Provision only the private Qwen link; credentials never enter local artifacts/output."""
import json
from pathlib import Path
import subprocess

IDENTITY=str(Path.home()/'.ssh/id_ed25519')


def remote(port,user,script,payload=None):
    source='PAYLOAD = '+repr(payload)+'\n'+script
    result=subprocess.run(['ssh','-p',str(port),'-i',IDENTITY,'-o','BatchMode=yes','-o','ConnectTimeout=15',f'{user}@117.186.49.26','python3 -'],input=source.encode(),capture_output=True)
    if result.returncode:
        raise RuntimeError(f'Remote preparation failed on port {port}; inspect controlled server logs (exit {result.returncode}).')
    return json.loads(result.stdout)


def main():
    # Both initial SSH connections use the workstation's already trusted host keys.
    star=remote(7722,'aiuser',"""
from pathlib import Path
import json
print(json.dumps({'host_key':Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().strip()}))
""")
    material=remote(7723,'root',"""
import json,secrets,subprocess
from pathlib import Path
root=Path('/opt/codex-gateway-r760/shared')
directory=root/'ssh'; directory.mkdir(mode=0o700,exist_ok=True); directory.chmod(0o700)
key=directory/'qwen-image-ed25519'
if not key.exists(): subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','qwen-image-star-tunnel','-f',str(key)],check=True)
key.chmod(0o600)
token=root/'config/qwen-image.key'
if not token.exists(): token.write_text(secrets.token_hex(32)+'\\n'); token.chmod(0o600)
assert token.stat().st_mode & 0o777 == 0o600
print(json.dumps({'public_key':key.with_suffix('.pub').read_text().strip(),'api_key':token.read_text().strip()}))
""")
    receipt=remote(7722,'aiuser',"""
import json,shutil,datetime
from pathlib import Path
root=Path('/data/apps/qwen-image-21-eval')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=root/'state'/('pre-primary-link-'+stamp); backup.mkdir(mode=0o700)
authorized=Path.home()/'.ssh/authorized_keys'
assert authorized.is_file()
shutil.copy2(authorized,backup/'authorized_keys'); (backup/'authorized_keys').chmod(0o600)
assert (backup/'authorized_keys').read_bytes()==authorized.read_bytes()
line='restrict,port-forwarding,command="/usr/bin/false",permitopen="127.0.0.1:8191" '+PAYLOAD['public_key']
existing=authorized.read_text()
if PAYLOAD['public_key'].split()[1] not in existing:
    authorized.write_text(existing.rstrip()+'\\n'+line+'\\n')
authorized.chmod(0o600)
env=root/'api.env'
if env.exists(): shutil.copy2(env,backup/'api.env')
env.write_text('QWEN_IMAGE_API_KEY='+PAYLOAD['api_key']+'\\n'); env.chmod(0o600)
print(json.dumps({'backup':str(backup),'restricted_key_installed':True,'upstream_auth_file_mode':'0600'}))
""",material)
    unit=Path('deploy/systemd/qwen-image-star-tunnel.service').read_text(encoding='utf-8')
    tunnel=remote(7723,'root',"""
import json,subprocess
from pathlib import Path
root=Path('/opt/codex-gateway-r760/shared/ssh')
key=' '.join(PAYLOAD['host_key'].split()[:2])
known=root/'qwen-image-known-hosts'; known.write_text('192.168.77.7 '+key+'\\n'); known.chmod(0o600)
unit=Path('/etc/systemd/system/qwen-image-star-tunnel.service')
if unit.exists(): assert unit.read_text()==PAYLOAD['unit'], 'Existing unit differs; review before replacing'
unit.write_text(PAYLOAD['unit']); unit.chmod(0o644)
subprocess.run(['systemd-analyze','verify',str(unit)],check=True,capture_output=True)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now',unit.name],check=True,capture_output=True)
print(json.dumps({'unit':unit.name,'private_bind':'172.18.0.1:18191','encrypted_destination':'star/127.0.0.1:8191'}))
""",{'host_key':star['host_key'],'unit':unit})
    print(json.dumps({'star':receipt,'r760':tunnel}))


if __name__=='__main__':
    main()
