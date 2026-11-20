#!/usr/bin/env bash
# Start XMerge Studio: Mastra server (:4111) + React app (:5173). Needs only Node (see .nvmrc).
#
#   ./run.sh           # uses .env; installs what is missing
#   ./run.sh --auth    # run "authenticate --to=$XMS_AUTH_TO" first (fresh Artifactory/AWS tokens)
#
# .env (chmod 600) is parsed, not sourced; only the keys below are read. A non-empty value there wins
# over the shell. Claude runs on Amazon Bedrock with AWS_BEARER_TOKEN_BEDROCK (Bedrock API key).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
YARN=(node "$HERE/.yarn/releases/yarn-4.10.3.cjs")

KEYS=" AWS_BEARER_TOKEN_BEDROCK AWS_REGION XMS_MODEL XMS_AUTH_TO XMS_GUARDRAIL_ID XMS_GUARDRAIL_VERSION XMS_KB_ID ARTIFACTORY_USERNAME ARTIFACTORY_ACCESS_TOKEN ARTIFACTORY_HOSTNAME "
if [ -f .env ]; then
  case "$(stat -f '%Lp' .env 2>/dev/null || stat -c '%a' .env)" in 600|400) ;; *) echo "Refusing .env: other users can read it. Run: chmod 600 .env" >&2; exit 1 ;; esac
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line#export }"
    [[ "$line" == *=* && "$line" != \#* ]] || continue
    k="${line%%=*}" v="${line#*=}"; v="${v%"${v##*[![:space:]]}"}"
    [[ "$v" == \"*\" || "$v" == \'*\' ]] && v="${v:1:${#v}-2}"
    [[ "$KEYS" == *" $k "* && -n "$v" ]] && export "$k=$v"
  done < .env
fi

AUTHED=
authenticate_now() {
  [ -n "$AUTHED" ] && return 0
  # shellcheck disable=SC1090
  source "$HOME/.authenticate/authenticate.sh"
  echo "Running: authenticate --to=${XMS_AUTH_TO:-wealth-dev-au}"
  authenticate --to="${XMS_AUTH_TO:-wealth-dev-au}"
  AUTHED=1
}
[ "${1:-}" = "--auth" ] && authenticate_now

need_tokens() { [ -n "${ARTIFACTORY_USERNAME:-}" ] && [ -n "${ARTIFACTORY_ACCESS_TOKEN:-}" ] || authenticate_now; }

# JavaScript packages (Yarn 4, Iress Artifactory via .yarnrc.yml).
if [ ! -d node_modules/@mastra/core ] || [ ! -d node_modules/vite ]; then
  need_tokens; export ARTIFACTORY_USERNAME ARTIFACTORY_ACCESS_TOKEN
  "${YARN[@]}" install
fi

[ -f server/data/catalog.json ] || { echo "server/data/catalog.json is missing; run: python3 -I engine/export_catalog.py" >&2; exit 1; }

# Bedrock: the model uses the API key when there is one. The knowledge base of sample templates
# (XMS_KB_ID) does not accept API keys, so it needs the AWS keys `authenticate` exports.
if [ -n "${XMS_KB_ID:-}" ] && [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then authenticate_now; fi
if [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ]; then
  [ -n "${XMS_KB_ID:-}" ] || unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
else
  echo "Note: AWS_BEARER_TOKEN_BEDROCK is not set in .env; Bedrock will use the shell's AWS credentials." >&2
fi
export AWS_REGION="${AWS_REGION:-ap-southeast-2}" XMS_MODEL="${XMS_MODEL:-au.anthropic.claude-opus-5-5}"

export XMS_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
export XMS_SERVER_PORT="${XMS_SERVER_PORT:-4111}" XMS_WEB_PORT="${XMS_WEB_PORT:-5173}"

export XMS_ROOT="$HERE"
# Agents + workflows + /studio API only: a plain build has no Mastra Studio UI (that needs --studio).
echo "Building the agent server ..."
(cd server && "${YARN[@]}" mastra build --force >/dev/null) || { echo "mastra build failed; run: cd server && mastra build" >&2; exit 1; }

# A process left over from an earlier run would keep serving old code (and the new one would fail to bind).
for port in "$XMS_SERVER_PORT" "$XMS_WEB_PORT"; do
  if pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)" && [ -n "$pid" ]; then
    echo "Port $port is still in use by an earlier run (pid $pid). Stop it with: kill $pid" >&2
    exit 1
  fi
done

PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null' EXIT INT TERM HUP
(cd server && "${YARN[@]}" mastra start) & PIDS+=($!)
(cd web && "${YARN[@]}" vite) & PIDS+=($!)
echo
echo "XMerge Studio:  http://127.0.0.1:$XMS_WEB_PORT"
wait
