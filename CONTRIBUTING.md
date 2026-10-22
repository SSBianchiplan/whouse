# Como contribuir com o GPlanSiS|WHOUSE

Obrigado pelo interesse! Este guia explica como propor mudanças de forma que a revisão seja rápida.

## Antes de começar
- Leia o [código de conduta](CODE_OF_CONDUCT.md).
- Para mudanças maiores que uma correção pontual, **abra uma issue primeiro** (modelos "Ideia" ou "Bug") e combine a abordagem.
- Falhas de segurança **não** vão em issue pública: siga a [política de segurança](SECURITY.md).

## Ambiente de desenvolvimento
O jeito mais rápido é abrir `web/app.html` no navegador (modo local, sem servidor, com base de demonstração).

Para o modo multiusuário (PostgreSQL 16+):
```bash
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
export WHOUSE_DSN="postgresql:///whouse" WHOUSE_MASTER=admin@exemplo.com WHOUSE_COOKIE_SEGURO=0 WHOUSE_WEB="$PWD/web"
(cd server && ../.venv/bin/python app.py criar-admin --login admin@exemplo.com --nome "Admin Exemplo")
.venv/bin/uvicorn app:app --app-dir server --port 8980 --reload
```
Abra <http://localhost:8980/app.html>. O frontend não tem etapa de build: edite e recarregue (em `http://localhost` o service worker não é registrado).

## Organização do código
- `web/app.js` — toda a aplicação: estado, regras (invariantes), módulos M1–M5, plataforma, sincronização com o servidor e merge 3-vias.
- `web/app.html` — estrutura e estilos da aplicação; `web/index.html` + `landing.js` — página pública.
- `server/app.py` — API FastAPI: sessões, usuários, estado versionado, histórico, proxy de IA e webhook. `server/schema.sql` — esquema PostgreSQL idempotente.
- `deploy/` — publicação, unit systemd, bloco do Caddy e CSP.

## Regras do projeto
- **Interface em português do Brasil**, textos curtos e diretos.
- **Sem dependências de build no frontend** e sem script de CDN: a CSP só permite scripts do próprio domínio.
- **Invariantes primeiro**: nenhum lançamento pode gerar saldo negativo, tirar lote da quarentena sem liberação, consumir saldo de outra ordem ou apagar movimento. Mudança que toque em movimentos precisa preservar isso.
- **Permissão no servidor**: o que for novo e sensível deve ser validado em `server/app.py`, não só escondido na interface.
- **IA propõe, humano decide**: nenhuma ação de IA grava sem aprovação explícita.
- Nunca inclua segredos, `.env`, bancos, exportações ou **dados reais** (materiais, fornecedores, clientes, estoques) em commits ou capturas — use a base de demonstração.
- Antes de enviar: `node --check web/app.js` e `python -m py_compile server/app.py`.

## Pull requests
1. Faça um fork e crie uma branch a partir de `main` (`feat/…`, `fix/…`, `docs/…`).
2. Commits pequenos, com mensagem no imperativo explicando o porquê.
3. Preencha o modelo do PR: o que mudou, como testou, capturas se mexer na interface.

## Dúvidas
Abra uma issue com o modelo "Pergunta" ou escreva para contato@gplansis.com.
