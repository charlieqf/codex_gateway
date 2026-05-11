param(
  [Parameter(Mandatory = $true)]
  [string]$SshTarget,

  [string]$SshKeyPath,

  [string]$OpenAIKeyFile,

  [string]$RemoteRepoPath = '/home/qian/codex-gateway-test',

  [string]$ComposeProject = 'codex_gateway_test',

  [string]$ComposeFile = 'compose.azure.yml',

  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function ConvertTo-ShellSingleQuoted {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + ($Value -replace "'", "'\''") + "'"
}

$remoteRepoLiteral = ConvertTo-ShellSingleQuoted $RemoteRepoPath
$composeProjectLiteral = ConvertTo-ShellSingleQuoted $ComposeProject
$composeFileLiteral = ConvertTo-ShellSingleQuoted $ComposeFile
$skipBuildValue = if ($SkipBuild) { "1" } else { "0" }

function Invoke-RemoteScript {
  param([Parameter(Mandatory = $true)][string]$Script)

  $sshArgs = @()
  if ($SshKeyPath) {
    $sshArgs += @("-i", $SshKeyPath)
  }
  $sshArgs += @("-tt", $SshTarget, "bash -s")
  $Script | & ssh @sshArgs
}

function Invoke-KeyFileInjection {
  param([Parameter(Mandatory = $true)][string]$KeyFile)

  if (!(Test-Path -LiteralPath $KeyFile)) {
    throw "OpenAI key file not found: $KeyFile"
  }
  $keyText = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
  if (!$keyText.StartsWith("sk-") -or $keyText.Length -lt 40) {
    throw "OpenAI key file does not look like a valid key."
  }

  $id = [guid]::NewGuid().ToString("N")
  $remoteKeyFile = "/tmp/gpt-image-2-key-$id.txt"
  $remoteScriptFile = "/tmp/inject-image-key-$id.sh"
  $localScriptFile = Join-Path $env:TEMP "inject-image-key-$id.sh"
  $remoteRepoForScript = ConvertTo-ShellSingleQuoted $RemoteRepoPath
  $composeProjectForScript = ConvertTo-ShellSingleQuoted $ComposeProject
  $composeFileForScript = ConvertTo-ShellSingleQuoted $ComposeFile

  $remoteFileScript = @'
set -euo pipefail
REMOTE_KEY_FILE="__REMOTE_KEY_FILE__"
REMOTE_SCRIPT_FILE="__REMOTE_SCRIPT_FILE__"
REMOTE_REPO=__REMOTE_REPO__
COMPOSE_PROJECT=__COMPOSE_PROJECT__
COMPOSE_FILE=__COMPOSE_FILE__
SKIP_BUILD="__SKIP_BUILD__"
ENV_FILE="config/gateway.container.env"
EXAMPLE_ENV_FILE="config/gateway.container.example.env"

cleanup() {
  rm -f "$REMOTE_KEY_FILE" "$REMOTE_SCRIPT_FILE"
}
trap cleanup EXIT

case "$REMOTE_REPO" in
  '$HOME'/*) REMOTE_REPO="$HOME/${REMOTE_REPO#'$HOME'/}" ;;
  '~'/*) REMOTE_REPO="$HOME/${REMOTE_REPO#'~'/}" ;;
esac

chmod 600 "$REMOTE_KEY_FILE"
cd "$REMOTE_REPO"

if [ ! -f "$ENV_FILE" ]; then
  if [ ! -f "$EXAMPLE_ENV_FILE" ]; then
    echo "error=missing_env_template path=$EXAMPLE_ENV_FILE" >&2
    exit 1
  fi
  umask 077
  cp "$EXAMPLE_ENV_FILE" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

python3 - "$ENV_FILE" "$REMOTE_KEY_FILE" <<'PY'
import stat
import sys
from pathlib import Path

env_file = Path(sys.argv[1])
key_file = Path(sys.argv[2])
openai_key = key_file.read_text(encoding="utf-8").strip()
if not openai_key.startswith("sk-"):
    raise SystemExit("error=invalid_openai_key_prefix expected=sk-")
if len(openai_key) < 40:
    raise SystemExit("error=invalid_openai_key_length")

updates = {
    "MEDCODE_IMAGE_GENERATION_ENABLED": "1",
    "MEDCODE_IMAGE_OPENAI_API_KEY": openai_key,
    "MEDCODE_IMAGE_OPENAI_BASE_URL": "https://api.openai.com",
    "MEDCODE_IMAGE_MODEL_MAP_JSON": '{"medcode-image-default":"gpt-image-2"}',
}

lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []
written = set()
output = []
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        output.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        output.append(f"{key}={updates[key]}")
        written.add(key)
    else:
        output.append(line)

for key, value in updates.items():
    if key not in written:
        output.append(f"{key}={value}")

env_file.write_text("\n".join(output) + "\n", encoding="utf-8")
env_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
print("image_env_updated=ok")
PY

if [ "$SKIP_BUILD" = "1" ]; then
  sudo docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --force-recreate gateway
else
  sudo docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --build --force-recreate gateway
fi

sudo docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
for i in $(seq 1 20); do
  if curl -fsS --max-time 5 http://127.0.0.1:18787/gateway/health >/dev/null; then
    echo "gateway_health=ok"
    break
  fi
  if [ "$i" = "20" ]; then
    echo "error=gateway_health_timeout" >&2
    sudo docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" logs --tail=120 gateway >&2
    exit 1
  fi
  sleep 2
done

sudo docker exec codex_gateway_test-gateway-1 sh -lc 'test "${MEDCODE_IMAGE_GENERATION_ENABLED:-}" = "1" && test -n "${MEDCODE_IMAGE_OPENAI_API_KEY:-}" && echo "image_container_env=ok"'
echo "image_openai_key_injected=ok"
'@

  $remoteFileScript = $remoteFileScript.
    Replace("__REMOTE_KEY_FILE__", $remoteKeyFile).
    Replace("__REMOTE_SCRIPT_FILE__", $remoteScriptFile).
    Replace("__REMOTE_REPO__", $remoteRepoForScript).
    Replace("__COMPOSE_PROJECT__", $composeProjectForScript).
    Replace("__COMPOSE_FILE__", $composeFileForScript).
    Replace("__SKIP_BUILD__", $skipBuildValue)

  [System.IO.File]::WriteAllText(
    $localScriptFile,
    $remoteFileScript.Replace("`r`n", "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )

  $scpArgs = @()
  if ($SshKeyPath) {
    $scpArgs += @("-i", $SshKeyPath)
  }
  $scpArgs += @("-o", "StrictHostKeyChecking=accept-new")

  try {
    & scp @scpArgs $KeyFile "${SshTarget}:$remoteKeyFile"
    & scp @scpArgs $localScriptFile "${SshTarget}:$remoteScriptFile"

    $sshArgs = @()
    if ($SshKeyPath) {
      $sshArgs += @("-i", $SshKeyPath)
    }
    $sshArgs += @("-o", "StrictHostKeyChecking=accept-new", $SshTarget, "bash $remoteScriptFile")
    & ssh @sshArgs
  } finally {
    Remove-Item -LiteralPath $localScriptFile -Force -ErrorAction SilentlyContinue
    $cleanupArgs = @()
    if ($SshKeyPath) {
      $cleanupArgs += @("-i", $SshKeyPath)
    }
    $cleanupArgs += @(
      "-o",
      "StrictHostKeyChecking=accept-new",
      $SshTarget,
      "rm -f $remoteKeyFile $remoteScriptFile"
    )
    & ssh @cleanupArgs | Out-Null
  }
}

if ($OpenAIKeyFile) {
  Invoke-KeyFileInjection -KeyFile $OpenAIKeyFile
  exit $LASTEXITCODE
}

$remoteScript = @"
set -euo pipefail

REMOTE_REPO=$remoteRepoLiteral
COMPOSE_PROJECT=$composeProjectLiteral
COMPOSE_FILE=$composeFileLiteral
SKIP_BUILD="$skipBuildValue"
ENV_FILE="config/gateway.container.env"
EXAMPLE_ENV_FILE="config/gateway.container.example.env"

case "`$REMOTE_REPO" in
  '`$HOME'/*) REMOTE_REPO="`$HOME/`${REMOTE_REPO#'`$HOME'/}" ;;
  '~'/*) REMOTE_REPO="`$HOME/`${REMOTE_REPO#'~'/}" ;;
esac

cd "`$REMOTE_REPO"

if [ ! -f "`$ENV_FILE" ]; then
  if [ ! -f "`$EXAMPLE_ENV_FILE" ]; then
    echo "error=missing_env_template path=`$EXAMPLE_ENV_FILE" >&2
    exit 1
  fi
  umask 077
  cp "`$EXAMPLE_ENV_FILE" "`$ENV_FILE"
fi
chmod 600 "`$ENV_FILE"

printf "Paste ROTATED OpenAI image API key (input hidden): " > /dev/tty
old_stty="`$(stty -g < /dev/tty || true)"
stty -echo < /dev/tty
IFS= read -r OPENAI_KEY < /dev/tty
if [ -n "`$old_stty" ]; then
  stty "`$old_stty" < /dev/tty || true
else
  stty echo < /dev/tty || true
fi
printf "\n" > /dev/tty

case "`$OPENAI_KEY" in
  sk-*) ;;
  *)
    unset OPENAI_KEY
    echo "error=invalid_openai_key_prefix expected=sk-" >&2
    exit 1
    ;;
esac

export OPENAI_KEY
python3 - "`$ENV_FILE" <<'PY'
import os
import stat
import sys
from pathlib import Path

env_file = Path(sys.argv[1])
updates = {
    "MEDCODE_IMAGE_GENERATION_ENABLED": "1",
    "MEDCODE_IMAGE_OPENAI_API_KEY": os.environ["OPENAI_KEY"],
    "MEDCODE_IMAGE_OPENAI_BASE_URL": "https://api.openai.com",
    "MEDCODE_IMAGE_MODEL_MAP_JSON": '{"medcode-image-default":"gpt-image-2"}',
}

lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []
written = set()
output = []
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        output.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        output.append(f"{key}={updates[key]}")
        written.add(key)
    else:
        output.append(line)

for key, value in updates.items():
    if key not in written:
        output.append(f"{key}={value}")

env_file.write_text("\n".join(output) + "\n", encoding="utf-8")
env_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
PY
unset OPENAI_KEY

if [ "`$SKIP_BUILD" = "1" ]; then
  sudo docker compose -p "`$COMPOSE_PROJECT" -f "`$COMPOSE_FILE" up -d --force-recreate gateway
else
  sudo docker compose -p "`$COMPOSE_PROJECT" -f "`$COMPOSE_FILE" up -d --build --force-recreate gateway
fi

sudo docker compose -p "`$COMPOSE_PROJECT" -f "`$COMPOSE_FILE" ps
curl -fsS --max-time 15 http://127.0.0.1:18787/gateway/health >/dev/null
echo "image_openai_key_injected=ok"
"@

Invoke-RemoteScript -Script $remoteScript
