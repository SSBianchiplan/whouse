#!/usr/bin/env bash
# Publica o GPlanSiS|WHOUSE no servidor (whouse.gplansis.com). Uso: bash deploy/publicar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${WHOUSE_HOST:?defina WHOUSE_HOST=<servidor ssh>}
node --check web/app.js
python3 -c "import ast,sys; ast.parse(open('server/app.py').read())"
STG=$(mktemp -d); mkdir -p "$STG/web" "$STG/server" "$STG/deploy"
cp web/index.html web/app.html web/app.js web/landing.js web/sw.js web/manifest.webmanifest "$STG/web/"; cp -R web/icons web/vendor "$STG/web/"
cp server/app.py server/schema.sql server/requirements.txt "$STG/server/"
cp deploy/whouse.service deploy/whouse.caddy deploy/instalar.remoto.sh "$STG/deploy/"
# versão do cache do service worker muda a cada publicação
sed -i '' "s/const V='whouse-v[^']*'/const V='whouse-$(date +%Y%m%d%H%M%S)'/" "$STG/web/sw.js"
rsync -a --delete "$STG/" "$HOST:/tmp/whouse-pacote/"
ssh "$HOST" 'bash /tmp/whouse-pacote/deploy/instalar.remoto.sh'
rm -rf "$STG"
echo "publicado em $HOST"
