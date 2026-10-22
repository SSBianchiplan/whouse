#!/usr/bin/env bash
# Publica o GPlanSiS|WHOUSE no servidor (whouse.gplansis.com). Uso: bash deploy/publicar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${WHOUSE_HOST:?defina WHOUSE_HOST=<servidor ssh>}
node --check web/app.js
python3 -c "import ast; [ast.parse(open(f).read()) for f in ('server/app.py', 'server/ia_cota.py')]"
STG=$(mktemp -d); mkdir -p "$STG/web" "$STG/server" "$STG/deploy"
cp web/index.html web/app.html web/app.js web/landing.js web/sw.js web/manifest.webmanifest "$STG/web/"; cp -R web/icons web/vendor "$STG/web/"
cp server/app.py server/ia_cota.py server/schema.sql server/requirements.txt "$STG/server/"
cp deploy/whouse.service deploy/whouse.caddy deploy/instalar.remoto.sh "$STG/deploy/"
# versão do cache do service worker muda a cada publicação
sed -i '' "s/const V='whouse-v[^']*'/const V='whouse-$(date +%Y%m%d%H%M%S)'/" "$STG/web/sw.js"
# pacote num diretório exclusivo (mktemp: 0700, dono root) — nunca num caminho fixo do /tmp,
# onde outro usuário do servidor poderia criá-lo antes e plantar o script que roda como root
RDIR=$(ssh "$HOST" 'umask 077; mktemp -d /root/whouse-pacote.XXXXXXXX')
case "$RDIR" in /root/whouse-pacote.*) ;; *) echo "mktemp remoto falhou: $RDIR"; exit 1;; esac
rsync -a --no-owner --no-group "$STG/" "$HOST:$RDIR/"   # dono root no destino; o diretório segue 0700
ssh "$HOST" "SRC='$RDIR' bash '$RDIR/deploy/instalar.remoto.sh'; rc=\$?; rm -rf -- '$RDIR'; exit \$rc"
rm -rf "$STG"
echo "publicado em $HOST"
