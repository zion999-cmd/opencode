#!/usr/bin/env bash
# oc2api.sh — OpenCode 免费模型代理服务管理脚本
# 用法: ./oc2api.sh [start|stop|restart|status]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.oc2api.pid"
LOG_FILE="$SCRIPT_DIR/.oc2api.log"
PORT="${OC2API_PORT:-31498}"
HOST="${OC2API_HOST:-127.0.0.1}"

# 查找 bun 可执行文件
find_bun() {
  if command -v bun &>/dev/null; then
    echo "bun"
    return
  fi
  for candidate in \
    "$HOME/.bun/bin/bun" \
    "$HOME/.nvm/versions/node/"*/bin/bun \
    "/opt/homebrew/bin/bun" \
    "/usr/local/bin/bun"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE")
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "oc2api is already running (PID $(cat "$PID_FILE"), port $PORT)"
    return 0
  fi

  # 检查端口是否被其他进程占用（|| true 防止 set -e 在端口空闲时误退出）
  local occupant
  occupant=$(lsof -ti :"$PORT" 2>/dev/null | head -1 || true)
  if [ -n "$occupant" ]; then
    echo "Port $PORT is occupied by PID $occupant (not managed by this script)."
    echo "Killing it and proceeding..."
    kill "$occupant" 2>/dev/null || true
    sleep 1
  fi

  local bun
  bun=$(find_bun)
  if [ -z "$bun" ]; then
    echo "Error: bun not found. Install it with: npm install -g bun" >&2
    exit 1
  fi

  echo "Starting oc2api on $HOST:$PORT ..."
  cd "$SCRIPT_DIR"
  nohup "$bun" run --conditions=browser ./src/index.ts serve \
    --port "$PORT" --hostname "$HOST" \
    >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # 等待服务就绪（最多 10 秒）
  local i=0
  while [ $i -lt 20 ]; do
    sleep 0.5
    if curl -sf "http://$HOST:$PORT/health" &>/dev/null; then
      echo "oc2api started (PID $pid, port $PORT)"
      return 0
    fi
    i=$((i + 1))
  done

  # 若 /health 不可用，只要进程存在就认为启动成功
  if kill -0 "$pid" 2>/dev/null; then
    echo "oc2api started (PID $pid, port $PORT)"
  else
    echo "Error: oc2api failed to start. Check logs: $LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "oc2api is not running"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  echo "Stopping oc2api (PID $pid) ..."
  kill "$pid" 2>/dev/null
  # 等待进程退出
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do
    sleep 0.3
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "Process did not exit, sending SIGKILL ..."
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "oc2api stopped"
}

cmd_restart() {
  cmd_stop
  sleep 0.5
  cmd_start
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "oc2api is running (PID $pid, port $PORT)"
    echo "Endpoint : http://$HOST:$PORT/v1"
    echo "Log file : $LOG_FILE"
    echo ""
    echo "Available models:"
    curl -sf "http://$HOST:$PORT/v1/models" \
      -H "x-opencode-directory: $SCRIPT_DIR" \
      | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for m in d.get('data', []):
        print('  -', m['id'])
except Exception as e:
    print('  (could not fetch models:', e, ')')
" 2>/dev/null || echo "  (server not yet responding)"
  else
    echo "oc2api is not running"
    if [ -f "$LOG_FILE" ]; then
      echo "Last log lines:"
      tail -5 "$LOG_FILE" | sed 's/^/  /'
    fi
  fi
}

CMD="${1:-}"
case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  *)
    echo "Usage: $(basename "$0") {start|stop|restart|status}"
    echo ""
    echo "  start    启动代理服务（默认端口 $PORT）"
    echo "  stop     停止代理服务"
    echo "  restart  重启代理服务"
    echo "  status   查看运行状态及可用模型"
    echo ""
    echo "环境变量:"
    echo "  OC2API_PORT   监听端口（默认 31498）"
    echo "  OC2API_HOST   监听地址（默认 127.0.0.1）"
    exit 1
    ;;
esac
