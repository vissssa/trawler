#!/usr/bin/env bash
#
# 本地一键启动 API + Worker + Scheduler 三个服务
# 用法: ./scripts/dev.sh  或  npm run dev
# 停止: Ctrl+C（会同时终止所有子进程）
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SERVICE_PIDS=()

cleanup() {
  echo ""
  echo -e "${YELLOW}[dev] 正在关闭所有服务...${NC}"
  for pid in "${SERVICE_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # 等待子进程退出
  for pid in "${SERVICE_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  echo -e "${GREEN}[dev] 所有服务已停止${NC}"
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# ===== 前置检查 =====
echo -e "${CYAN}==============================${NC}"
echo -e "${CYAN}  Trawler 本地开发启动脚本${NC}"
echo -e "${CYAN}==============================${NC}"
echo ""

# 检查 node
if ! command -v node &>/dev/null; then
  echo -e "${RED}[dev] 错误: 未找到 node${NC}"
  exit 1
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}[dev] 安装依赖...${NC}"
  npm install
fi

# 检查 MongoDB
echo -ne "${BLUE}[dev] 检查 MongoDB...${NC} "
if node -e "
  require('dotenv').config();
  const mongoose = require('mongoose');
  mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/trawler', { serverSelectionTimeoutMS: 3000 })
    .then(() => { mongoose.disconnect(); process.exit(0); })
    .catch(() => process.exit(1));
" 2>/dev/null; then
  echo -e "${GREEN}✓${NC}"
else
  echo -e "${RED}✗ 连接失败，请检查 MONGODB_URL${NC}"
  exit 1
fi

# 检查 Redis
echo -ne "${BLUE}[dev] 检查 Redis...  ${NC} "
if node -e "
  require('dotenv').config();
  const Redis = require('ioredis');
  const r = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { retryStrategy: () => null, connectTimeout: 3000 });
  r.ping().then(() => { r.quit(); process.exit(0); }).catch(() => { r.quit(); process.exit(1); });
" 2>/dev/null; then
  echo -e "${GREEN}✓${NC}"
else
  echo -e "${RED}✗ 连接失败，请检查 REDIS_URL${NC}"
  exit 1
fi

echo ""

# ===== 日志目录 =====
mkdir -p logs

# ===== 启动服务 =====
API_PORT="${API_PORT:-3000}"

echo -e "${GREEN}[dev] 启动 API (port $API_PORT)...${NC}"
npx ts-node src/api/server.ts &
SERVICE_PIDS+=($!)

echo -e "${BLUE}[dev] 启动 Worker...${NC}"
npx ts-node src/worker/consumer.ts &
SERVICE_PIDS+=($!)

echo -e "${YELLOW}[dev] 启动 Scheduler...${NC}"
npx ts-node src/scheduler/index.ts &
SERVICE_PIDS+=($!)

# 等待 API 就绪
echo -ne "${BLUE}[dev] 等待 API 就绪"
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
    echo -e " ${GREEN}✓${NC}"
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq 20 ]; then
    echo -e " ${RED}超时${NC}"
  fi
done

echo ""
echo -e "${CYAN}====================================${NC}"
echo -e "${CYAN}  所有服务已启动${NC}"
echo -e "${CYAN}  API:       http://localhost:${API_PORT}${NC}"
echo -e "${CYAN}  Health:    http://localhost:${API_PORT}/health${NC}"
echo -e "${CYAN}  Metrics:   http://localhost:${API_PORT}/metrics${NC}"
echo -e "${CYAN}  按 Ctrl+C 停止所有服务${NC}"
echo -e "${CYAN}====================================${NC}"
echo ""

# 阻塞等待 — 任一服务退出则全部关闭
while true; do
  for i in "${!SERVICE_PIDS[@]}"; do
    pid="${SERVICE_PIDS[$i]}"
    if ! kill -0 "$pid" 2>/dev/null; then
      echo -e "${RED}[dev] 检测到服务进程 $pid 退出${NC}"
      cleanup
    fi
  done
  sleep 2
done
