## O que muda
<!-- Resumo da mudança e o porquê. Referencie a issue: "Fecha #123". -->

## Tipo
- [ ] Correção de bug
- [ ] Nova funcionalidade
- [ ] Documentação
- [ ] Refatoração / manutenção

## Como testei
<!-- Passos, modo (local no navegador / multiusuário com PostgreSQL), navegadores, coletor. -->

## Capturas
<!-- Se mexeu na interface, antes/depois — só com a base de demonstração. -->

## Checklist
- [ ] Invariantes preservadas (sem saldo negativo, quarentena não sai, estoque da ordem é da ordem, histórico não se apaga)
- [ ] Permissões novas conferidas no servidor (`server/app.py`)
- [ ] Sem segredos, `.env`, bancos ou dados reais no commit
- [ ] `node --check web/app.js` e `python -m py_compile server/app.py` sem erro
