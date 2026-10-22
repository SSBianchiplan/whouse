#!/usr/bin/env bash
# Roda NA servidor como root (chamado por deploy/publicar.sh). Idempotente.
set -euo pipefail
APP=/opt/whouse; SRC=/tmp/whouse-pacote
id whouse >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin whouse
mkdir -p "$APP/web" "$APP/server"
CARIMBO=$(date +%Y%m%d-%H%M%S)
[ -d "$APP/web" ] && [ "$(ls -A $APP/web 2>/dev/null)" ] && cp -a "$APP/web" "$APP/web.bak-$CARIMBO" && cp -a "$APP/server" "$APP/server.bak-$CARIMBO"
rsync -a --delete "$SRC/web/" "$APP/web/"
rsync -a --delete "$SRC/server/" "$APP/server/"
# banco: papel e base próprios, autenticação peer pelo socket (sem senha em arquivo)
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='whouse'" | grep -q 1 || sudo -u postgres psql -qc "create role whouse login"
sudo -u postgres psql -tAc "select 1 from pg_database where datname='whouse'" | grep -q 1 || sudo -u postgres psql -qc "create database whouse owner whouse"
# venv
[ -x "$APP/.venv/bin/python" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" -q install --upgrade pip >/dev/null
"$APP/.venv/bin/pip" -q install -r "$APP/server/requirements.txt"
# .env (preserva o existente; segredos são preenchidos à mão)
if [ ! -f "$APP/.env" ]; then
  cat > "$APP/.env" <<ENV
WHOUSE_DSN=postgresql:///whouse?host=/var/run/postgresql
WHOUSE_MASTER=${WHOUSE_MASTER:-contato@gplansis.com}
WHOUSE_SESSAO_HORAS=12
# IA: cole a chave da Anthropic para ligar o Assistente no servidor e reinicie o serviço
ANTHROPIC_API_KEY=
WHOUSE_IA_MODELO=claude-sonnet-5
# Conector REST/Webhook genérico: segredo HMAC compartilhado com o destino
WHOUSE_WEBHOOK_SEGREDO=
ENV
fi
chown -R root:whouse "$APP"; chmod 751 "$APP"; chmod 640 "$APP/.env"; chmod -R a+rX "$APP/web"
install -m 644 "$SRC/deploy/whouse.service" /etc/systemd/system/whouse.service
systemctl daemon-reload
systemctl enable whouse >/dev/null 2>&1
systemctl restart whouse
# Caddy: bloco próprio + import único no Caddyfile, validado antes do reload
cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-whouse-$CARIMBO"
[ -f /etc/caddy/whouse.caddy ] && cp -a /etc/caddy/whouse.caddy "/etc/caddy/whouse.caddy.bak-$CARIMBO"
install -m 644 "$SRC/deploy/whouse.caddy" /etc/caddy/whouse.caddy
# log do site com o dono do Caddy (o validate como root criaria o arquivo como root)
touch /var/log/caddy/whouse.log; chown caddy:caddy /var/log/caddy/whouse.log
grep -q 'import /etc/caddy/whouse.caddy' /etc/caddy/Caddyfile || printf '\n# GPlanSiS|WHOUSE (deploy separado — ver /etc/caddy/whouse.caddy)\nimport /etc/caddy/whouse.caddy\n' >> /etc/caddy/Caddyfile
if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then systemctl reload caddy; echo "caddy recarregado"
else echo "CADDY INVALIDO — restaurando"; cp -a "/etc/caddy/Caddyfile.bak-whouse-$CARIMBO" /etc/caddy/Caddyfile; rm -f /etc/caddy/whouse.caddy; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -3; exit 1; fi
sleep 2
systemctl is-active whouse
curl -fsS http://127.0.0.1:8980/api/saude; echo
# mantém só os 5 backups mais recentes do pacote
ls -dt $APP/web.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -rf; ls -dt $APP/server.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -rf
