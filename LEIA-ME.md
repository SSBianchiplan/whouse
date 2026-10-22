# GPlanSiS|WHOUSE — almoxarifado & WMS multiusuário

Publicado em **https://whouse.gplansis.com** (servidor próprio, atrás do Caddy). Notas de operação; a visão geral está no [README](README.md).

## Peças

| Arquivo | Papel |
|---|---|
| `web/index.html`, `web/landing.js` | Página inicial pública (`/`): funcionalidades e CTA para o sistema; reconhece sessão aberta ("Continuar como …") |
| `web/app.html`, `web/app.js` | Aplicação (PWA), em `/app.html`. Servida pelo servidor → modo multiusuário com login. Aberta sozinha (file://) → modo local, como antes |
| `web/sw.js`, `web/manifest.webmanifest`, `web/icons/`, `web/vendor/` | Instalação e operação offline (XLSX local, nada de CDN para scripts) |
| `server/app.py`, `server/schema.sql` | API FastAPI + PostgreSQL: sessões, usuários, estado versionado, histórico, proxy de IA, webhook |
| `deploy/` | `publicar.sh` (roda daqui), `instalar.remoto.sh`, unit systemd, bloco Caddy, CSP |

## Operação

```bash
bash deploy/publicar.sh                 # valida, envia e reinstala no servidor (WHOUSE_HOST, obrigatório; backup do pacote anterior)
ssh $HOST systemctl status whouse        # serviço (uvicorn 127.0.0.1:8980)
ssh $HOST tail -f /var/log/caddy/whouse.log
```

Segredos em `/opt/whouse/.env` (root:whouse 640), preenchidos à mão e seguidos de `systemctl restart whouse`:

- `ANTHROPIC_API_KEY` — liga o Assistente IA pelo servidor (vazio = motor local de regras)
- `WHOUSE_WEBHOOK_SEGREDO` — HMAC do conector REST/Webhook genérico

Recriar/redefinir um administrador pela linha de comando:
`ssh $HOST 'cd /opt/whouse/server && sudo -u whouse env $(grep -E "^WHOUSE_(DSN|MASTER)=" ../.env | xargs) ../.venv/bin/python app.py criar-admin --login EMAIL --nome "NOME"'`

## Usuários e perfis

ADMIN (tudo + usuários, versões, restauração) · GESTOR (operação + aprovações de inventário, requisição e CQ, integrações, configurações) · OPERADOR (recebe, movimenta, separa, conta) · CONSULTA (somente leitura — o servidor recusa gravação). Módulos personalizáveis por usuário.
Master: o login definido em `WHOUSE_MASTER` — não pode ser rebaixado nem desativado.
Senha: scrypt, mínimo 10 caracteres com maiúscula, minúscula e número; temporária com troca obrigatória; bloqueio de 15 min após 5 falhas; sessão em cookie HttpOnly/Secure/SameSite=Strict, 12 h deslizantes; toda mutação exige o cabeçalho `X-WHOUSE` (CSRF).

## Sincronização

O estado operacional é um documento versionado (`whouse.estado`). Cada gravação envia a versão-base; se outro usuário gravou antes, o servidor responde 409 e o cliente faz merge 3-vias por entidade (ledger por id, cadastros por chave, contadores pelo máximo), renumera documentos que colidiram (RC/PK/INV/RQC/ENT…) e reenvia. Saldo negativo gerado por consumo simultâneo é sinalizado e auditado. Offline, as alterações ficam no aparelho e sobem na reconexão. As últimas 300 versões ficam em `whouse.estado_hist` e são restauráveis pela tela Usuários → Versões.

## Integrações

O conector REST/Webhook entrega de verdade (`POST {url}/events`, `Idempotency-Key`, `X-WHOUSE-Signature: sha256=HMAC(ts.corpo)`, só https público). SAP B1, TOTVS, Senior, Sankhya e Odoo dependem do gateway com as credenciais do cliente: a fila **retém** essas mensagens e não as marca como enviadas.

## Limites conhecidos

- Todo o estado é um documento único: cada gravação envia o documento inteiro. Para volumes grandes (dezenas de milhares de movimentos), o próximo passo é levar o ledger para uma tabela append-only com saldo no banco.
- As permissões finas (aprovar, liberar CQ) são aplicadas na interface; o servidor aplica leitura × escrita e administração.
