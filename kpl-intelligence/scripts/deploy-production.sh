#!/usr/bin/env bash
# ==============================================================================
# KPL Intelligence 生产环境一键构建与部署脚本
# ==============================================================================
# 用法:
#   ./scripts/deploy-production.sh [--profile https] [--skip-build] [--no-cache]
#
# 参数说明:
#   --profile https   启用 Caddy 自动申请 TLS 证书并监听 80/443 (需配置 SITE_DOMAIN)
#   --skip-build      跳过 Docker 镜像构建，直接启动现有镜像
#   --no-cache        构建镜像时不使用 Docker 构建缓存
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err() { echo -e "${RED}[ERROR]${NC} $1"; }

ENABLE_HTTPS=false
SKIP_BUILD=false
NO_CACHE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ "${2:-}" == "https" ]]; then
        ENABLE_HTTPS=true
        shift 2
      else
        log_err "未知 profile: ${2:-}"
        exit 1
      fi
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --no-cache)
      NO_CACHE=true
      shift
      ;;
    *)
      log_err "未知参数: $1"
      echo "用法: $0 [--profile https] [--skip-build] [--no-cache]"
      exit 1
      ;;
  esac
done

echo "================================================================="
echo "🚀 KPL Intelligence 生产环境自动化部署流程"
echo "   目录: ${PROJECT_ROOT}"
echo "   HTTPS: ${ENABLE_HTTPS}"
echo "   时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "================================================================="

# -------------------------------------------------------------
# 1. 基础环境与必要工具检测
# -------------------------------------------------------------
log_info "检查本地运行环境..."

if ! command -v docker &>/dev/null; then
  log_err "未找到 docker 命令，请先安装 Docker Engine / Desktop。"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  log_err "未找到 docker compose 命令，请确认 Docker Compose v2 已就绪。"
  exit 1
fi

if [[ ! -f ".env" ]]; then
  log_err "未检测到 .env 配置文件！"
  log_info "请先参考 .env.production.example 创建 .env 并填写配置："
  echo "  cp .env.production.example .env"
  exit 1
fi

log_ok "基础环境检测通过。"

# -------------------------------------------------------------
# 2. 部署前环境预检 (Pre-flight Phase: pre-migrate)
# -------------------------------------------------------------
log_info "执行生产环境预检 (Pre-flight: pre-migrate)..."
if command -v node &>/dev/null; then
  node --env-file-if-exists=.env scripts/preflight-production.ts --phase pre-migrate
else
  log_warn "宿主机未检测到 Node.js，跳过宿主机预检，将由 setup 容器完成数据库初始化。"
fi

# -------------------------------------------------------------
# 3. 容器镜像构建
# -------------------------------------------------------------
if [[ "${SKIP_BUILD}" == "true" ]]; then
  log_info "跳过 Docker 镜像构建 (--skip-build 已指定)。"
else
  log_info "正在构建生产 Docker 镜像 (kpl-intelligence-app)..."
  BUILD_ARGS=()
  if [[ "${NO_CACHE}" == "true" ]]; then
    BUILD_ARGS+=(--no-cache)
  fi
  docker compose build "${BUILD_ARGS[@]}"
  log_ok "镜像构建完成。"
fi

# -------------------------------------------------------------
# 4. 数据库迁移与基础数据种子灌入 (Setup 容器)
# -------------------------------------------------------------
log_info "执行数据库迁移与种子数据填充 (setup 容器)..."
docker compose run --rm setup
log_ok "数据库迁移与种子灌入完成。"

# -------------------------------------------------------------
# 5. 迁移后状态复核 (Pre-flight Phase: post-migrate)
# -------------------------------------------------------------
if command -v node &>/dev/null; then
  log_info "执行生产环境预检 (Pre-flight: post-migrate)..."
  node --env-file-if-exists=.env scripts/preflight-production.ts --phase post-migrate
fi

# -------------------------------------------------------------
# 6. 拉起服务容器
# -------------------------------------------------------------
COMPOSE_PROFILES=()
if [[ "${ENABLE_HTTPS}" == "true" ]]; then
  COMPOSE_PROFILES+=(--profile https)
fi

log_info "拉起应用容器 (api, worker, web)..."
docker compose "${COMPOSE_PROFILES[@]}" up -d --remove-orphans

# -------------------------------------------------------------
# 7. 容器健康状态检查与等待
# -------------------------------------------------------------
log_info "等待核心服务容器就绪与健康检查通过..."

MAX_WAIT=60
WAITED=0
SERVICES=("api" "web")

for svc in "${SERVICES[@]}"; do
  log_info "检查服务 [${svc}] 健康状态..."
  while true; do
    CONTAINER_ID=$(docker compose ps -q "${svc}" 2>/dev/null || true)
    if [[ -z "${CONTAINER_ID}" ]]; then
      log_err "未能获取服务 ${svc} 的容器 ID"
      exit 1
    fi

    STATUS=$(docker inspect --format='{{json .State.Health.Status}}' "${CONTAINER_ID}" 2>/dev/null || echo '"unknown"')
    STATUS=$(echo "${STATUS}" | tr -d '"')

    if [[ "${STATUS}" == "healthy" ]]; then
      log_ok "服务 [${svc}] 健康检查通过 (healthy)！"
      break
    fi

    if [[ "${STATUS}" == "unhealthy" ]]; then
      log_err "服务 [${svc}] 健康检查失败 (unhealthy)！容器日志如下："
      docker compose logs --tail=40 "${svc}"
      exit 1
    fi

    if [[ ${WAITED} -ge ${MAX_WAIT} ]]; then
      log_err "等待服务 [${svc}] 健康超时 (${MAX_WAIT}s)！当前状态: ${STATUS}"
      docker compose logs --tail=40 "${svc}"
      exit 1
    fi

    sleep 3
    WAITED=$((WAITED + 3))
  done
done

# -------------------------------------------------------------
# 8. 部署成功结果汇总
# -------------------------------------------------------------
echo ""
echo "================================================================="
echo "🎉 KPL Intelligence 生产环境部署成功！"
echo "================================================================="
echo "  服务状态:"
docker compose ps
echo ""
echo "  常用运维命令:"
echo "    查看所有实时日志:    docker compose logs -f"
echo "    查看 Web 日志:       docker compose logs -f web"
echo "    查看 Worker 任务日志: docker compose logs -f worker"
echo "    查看 API 状态:       docker compose logs -f api"
echo "    停止所有服务:        docker compose down"
echo "    优雅关机与重启:      docker compose restart"
echo "================================================================="
