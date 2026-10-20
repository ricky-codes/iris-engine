#!/usr/bin/env bash
# Atualiza e (re)arranca a IRIS neste servidor.
#
#   ./deploy.sh              atualiza o código, faz backup, reconstrói e verifica
#   ./deploy.sh --no-pull    não atualiza o código (usa o que está no disco)
#   ./deploy.sh --no-backup  não faz o backup da base de dados
#   ./deploy.sh --help
#
# Corre-se no servidor, na pasta onde a IRIS está instalada. Nunca mostra segredos.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PULL=1
BACKUP=1
BACKUPS_DIR="backups"
KEEP_BACKUPS=14
HEALTH_TIMEOUT=90

for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --no-backup) BACKUP=0 ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Opção desconhecida: $arg (ver --help)" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

compose() { docker compose "$@"; }

# ---------- pré-requisitos ----------
step "A verificar o servidor"
command -v docker >/dev/null 2>&1 || fail "O Docker não está instalado."
docker compose version >/dev/null 2>&1 || fail "Falta o Docker Compose (comando 'docker compose')."
[ -f docker-compose.yml ] || fail "Não encontro o docker-compose.yml: corra o script na pasta da IRIS."
[ -f .env ] || fail "Falta o ficheiro .env. Copie o .env.example e preencha-o (ver README)."

if [ -n "$(find .env -perm -o=r 2>/dev/null)" ]; then
  warn ".env legível por todos os utilizadores do servidor. Sugestão: chmod 600 .env"
fi

# ---------- configuração (sem mostrar valores) ----------
env_value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true; }
env_set() { [ -n "$(env_value "$1")" ]; }

NODE_ENV_VALUE="$(env_value NODE_ENV)"
# A imagem define NODE_ENV=production quando o .env não diz outra coisa.
EFFECTIVE_ENV="${NODE_ENV_VALUE:-production}"
BYPASS="$(env_value STEPACCESS_BYPASS)"

step "A verificar a configuração ($EFFECTIVE_ENV)"
MISSING=()
env_set API_SECRET || MISSING+=("API_SECRET")
env_set OPENROUTER_API_KEY || MISSING+=("OPENROUTER_API_KEY")
if [ "$BYPASS" != "true" ]; then
  for key in STEPACCESS_URL STEPACCESS_USER STEPACCESS_PASSWORD STEPACCESS_COMPONENT_UUID; do
    env_set "$key" || MISSING+=("$key")
  done
fi

if [ "$EFFECTIVE_ENV" = "production" ]; then
  [ "$BYPASS" = "true" ] && fail "STEPACCESS_BYPASS=true é proibido em produção: o serviço não arranca. Remova-o do .env."
  if [ "${#MISSING[@]}" -gt 0 ]; then
    fail "Em produção faltam no .env: ${MISSING[*]}. O serviço não arrancaria."
  fi
  ok "Configuração completa para produção"
else
  if [ "${#MISSING[@]}" -gt 0 ]; then
    warn "Faltam no .env: ${MISSING[*]}. O motor ficará desligado (só /healthz e /readyz)."
  else
    ok "Configuração do motor completa"
  fi
  [ "$BYPASS" = "true" ] && warn "STEPACCESS_BYPASS ativo: os pedidos NÃO são verificados no StepAccess."
fi
if env_set ADMIN_API_SECRET; then
  ok "ADMIN_API_SECRET definido"
else
  warn "ADMIN_API_SECRET em falta: a API de administração (/v1/admin) ficará desligada."
fi

# ---------- código ----------
PREVIOUS="$(git rev-parse --short HEAD 2>/dev/null || echo desconhecido)"
if [ "$PULL" -eq 1 ]; then
  step "A atualizar o código"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Há alterações locais nos ficheiros versionados. Guarde-as ou descarte-as, ou use --no-pull."
  fi
  git pull --ff-only || fail "git pull falhou (o ramo local divergiu?). Resolva à mão e volte a correr."
  CURRENT="$(git rev-parse --short HEAD)"
  if [ "$CURRENT" = "$PREVIOUS" ]; then
    ok "Já estava na versão mais recente ($CURRENT)"
  else
    ok "Atualizado: $PREVIOUS → $CURRENT"
  fi
else
  CURRENT="$PREVIOUS"
  warn "A saltar o git pull (--no-pull). Versão atual: $CURRENT"
fi

# ---------- backup ----------
DB_RUNNING="$(compose ps --status running -q postgres 2>/dev/null || true)"
if [ "$BACKUP" -eq 1 ] && [ -n "$DB_RUNNING" ]; then
  step "A fazer o backup da base de dados"
  mkdir -p "$BACKUPS_DIR"
  chmod 700 "$BACKUPS_DIR" 2>/dev/null || true
  FILE="$BACKUPS_DIR/iris-$(date +%Y%m%d-%H%M%S).sql.gz"
  if compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip >"$FILE" && [ -s "$FILE" ]; then
    ok "Backup guardado em $FILE ($(du -h "$FILE" | cut -f1))"
    # Mantém só os últimos backups.
    # shellcheck disable=SC2012
    ls -1t "$BACKUPS_DIR"/iris-*.sql.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f --
  else
    rm -f "$FILE"
    fail "O backup falhou. Nada foi alterado. Use --no-backup só se tiver a certeza."
  fi
elif [ "$BACKUP" -eq 1 ]; then
  warn "A base de dados ainda não está a correr (primeira instalação?): sem backup."
fi

# ---------- reconstruir e arrancar ----------
step "A reconstruir e a arrancar (as migrações correm antes do serviço)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! compose up -d --build; then
  echo
  warn "O arranque falhou. Últimas linhas das migrações:"
  compose logs --no-color --tail 20 migrate 2>/dev/null || true
  fail "Falhou. Versão anterior: $PREVIOUS · backup mais recente em $BACKUPS_DIR/."
fi

# ---------- esperar pelo serviço ----------
step "A esperar que o serviço fique saudável (até ${HEALTH_TIMEOUT}s)"
CID="$(compose ps -q iris-engine)"
[ -n "$CID" ] || fail "O contentor iris-engine não está a correr."
STATUS="starting"
for ((i = 0; i < HEALTH_TIMEOUT; i += 2)); do
  STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || echo desconhecido)"
  case "$STATUS" in
    healthy | running) break ;;
    unhealthy | exited | dead) break ;;
  esac
  sleep 2
done

if [ "$STATUS" != "healthy" ] && [ "$STATUS" != "running" ]; then
  echo
  warn "Estado: $STATUS. Últimas linhas do registo:"
  compose logs --no-color --tail 30 iris-engine || true
  fail "O serviço não ficou saudável. Versão anterior: $PREVIOUS."
fi
ok "Serviço saudável"

# ---------- resumo ----------
step "Resumo"
LOGS="$(compose logs --no-color --since "$STARTED_AT" iris-engine 2>/dev/null || true)"
if grep -q "motor pronto" <<<"$LOGS"; then
  ok "Motor pronto (a receber pedidos do Salesforce)"
else
  warn "Motor desligado: falta configuração (só /healthz e /readyz). Ver: docker compose logs iris-engine"
fi
if grep -q "API de administração ligada" <<<"$LOGS"; then
  ok "API de administração ligada"
else
  warn "API de administração desligada (falta ADMIN_API_SECRET ou DATABASE_URL)"
fi
grep -q "STEPACCESS_BYPASS ativo" <<<"$LOGS" && warn "STEPACCESS_BYPASS ativo: pedidos não verificados no StepAccess."

PORTS="$(compose port iris-engine 8080 2>/dev/null || true)"
case "$PORTS" in
  0.0.0.0:* | "[::]:"*) warn "A porta 8080 está aberta a toda a rede ($PORTS). Em produção, publique-a só em 127.0.0.1." ;;
esac

printf '\n%sConcluído.%s Versão %s. Para ver o registo: docker compose logs -f iris-engine\n' "$GREEN" "$RESET" "$CURRENT"
