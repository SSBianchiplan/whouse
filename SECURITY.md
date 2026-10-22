# Política de segurança

## Versões suportadas
| Versão | Suporte |
|---|---|
| `main` (em produção em whouse.gplansis.com) | ✅ |

## Como relatar uma vulnerabilidade
**Não abra issue pública.** Envie um e-mail para **contato@gplansis.com** com o assunto `[SEGURANÇA] GPlanSiS|WHOUSE`, contendo:
- descrição do problema e impacto;
- passos para reproduzir (ou prova de conceito);
- versão, navegador e ambiente usados.

Confirmamos o recebimento assim que possível, mantemos você informado sobre a correção e damos crédito na publicação, se desejar.

## Escopo
Autenticação e sessão, bloqueio por tentativas, CSRF, perfis e permissões, isolamento do estado versionado e do histórico, proxy de IA, conector REST/Webhook (assinatura HMAC e restrição a destinos públicos) e cabeçalhos/CSP. Testes devem ser feitos numa instância local — **não** teste contra whouse.gplansis.com nem acesse dados de outras pessoas.
