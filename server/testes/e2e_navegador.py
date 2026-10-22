"""Teste ponta a ponta no Chrome (Playwright): app servido pelo uvicorn com a CSP de produção.

Uso: python e2e_navegador.py <url-base> <pasta-saida>
Pré-requisito: usuários admin@teste.local (ADMIN) e op@teste.local (OPERADOR), senha Senha-Teste-123,
sem troca obrigatória, e base vazia (o admin inicia a base de demonstração pela tela).
"""
import json
import sys
import time
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE, SAIDA = sys.argv[1], Path(sys.argv[2])
SAIDA.mkdir(parents=True, exist_ok=True)
falhas = []


def espera(pg, expr, timeout=15000):
    # page.wait_for_function usa eval(), que a CSP (script-src 'self') bloqueia; page.evaluate não.
    fim = time.time() + timeout / 1000
    while time.time() < fim:
        if pg.evaluate(f"(()=>{{try{{return !!({expr})}}catch(e){{return false}}}})()"):
            return
        time.sleep(0.2)
    raise TimeoutError(expr)


def ok(cond, msg):
    print(("OK   " if cond else "FALHA") + " " + msg)
    if not cond:
        falhas.append(msg)


def entra(ctx, login):
    pg = ctx.new_page()
    erros = []
    pg.on("console", lambda m: m.type == "error" and erros.append(m.text))
    pg.on("pageerror", lambda e: erros.append(str(e)))
    pg.goto(BASE + "/app.html")
    pg.fill("#lgLogin", login)
    pg.fill("#lgSenha", "Senha-Teste-123")
    pg.click("#lgBtn")
    return pg, erros


with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    # ---------------- ADMIN: inicia a base demo, exporta e importa XLSX
    ctx = br.new_context(accept_downloads=True)
    pg, erros = entra(ctx, "admin@teste.local")
    pg.get_by_role("button", name="Demonstração").click()
    espera(pg, "typeof API!=='undefined' && BASEV>=1 && !DIRTY", timeout=20000)
    ok(pg.evaluate("XLSX.version") == "0.20.3", "SheetJS carregado sob a CSP: XLSX.version = 0.20.3")
    doc = pg.evaluate("JSON.stringify(S)")
    ok("Aços Horizonte Exemplo Ltda" in doc and "Aços Vale Ltda" not in doc, "seed demo com o fornecedor fictício novo")
    with pg.expect_download() as dl:
        pg.evaluate("exportRows('whouse_materiais_teste', exportData('materiais'), 'xlsx')")
    arq = SAIDA / "materiais.xlsx"
    dl.value.save_as(arq)
    ok(zipfile.is_zipfile(arq) and "xl/workbook.xml" in zipfile.ZipFile(arq).namelist(), f"exportação gerou XLSX válido ({arq.stat().st_size} bytes)")
    with pg.expect_download() as dl:
        pg.evaluate("downloadTemplate(null,true)")
    tpl = SAIDA / "templates.xlsx"
    dl.value.save_as(tpl)
    ok(zipfile.is_zipfile(tpl), "template completo (aoa_to_sheet + várias abas) gerado")
    # importa a planilha exportada, alterando nada: deve atualizar os 18 materiais
    n_antes = pg.evaluate("S.materiais.length")
    pg.evaluate("fileMode='materiais'")
    pg.set_input_files("#fileIn", str(arq))
    pg.get_by_role("button", name="Importar", exact=True).click()
    espera(pg, "[...document.querySelectorAll('.toast')].some(t=>/atualizado/.test(t.textContent))", timeout=10000)
    toast = pg.evaluate("[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ')")
    ok(f"{n_antes} atualizado" in toast, f"importação do XLSX exportado: {toast}")
    # CSV também passa pelo XLSX.read
    csv = SAIDA / "materiais.csv"
    csv.write_text("codigo;descricao;um;grupo\nTESTE-CSV;Material via CSV;UN;TESTE\n", encoding="utf-8")
    pg.evaluate("fileMode='materiais'")
    pg.set_input_files("#fileIn", str(csv))
    pg.get_by_role("button", name="Importar", exact=True).click()
    espera(pg, "S.materiais.some(m=>m.codigo==='TESTE-CSV')", timeout=10000)
    ok(True, "importação de CSV (XLSX.read type string) incluiu o material")
    espera(pg, "!DIRTY && !API.pushing", timeout=15000)
    ok(pg.evaluate("API.lastErr") == "", "admin gravou no servidor sem erro")
    ok(not [e for e in erros if "Content Security Policy" in e], "nenhuma violação de CSP no console (admin)")
    v_admin = pg.evaluate("BASEV")

    # ---------------- OPERADOR: operação normal grava; configuração é recusada pelo servidor
    ctx2 = br.new_context()
    op, erros2 = entra(ctx2, "op@teste.local")
    espera(op, "typeof API!=='undefined' && BASEV>=1 && S && S.materiais.length>0", timeout=20000)
    op.evaluate("""(()=>{const m=S.materiais.find(x=>!x.controlaLote);
        postDoc([{tipo:'ENTRADA',material:m.codigo,lote:'',deposito:'ALM01',endereco:'',qtd:3,custo:m.custo*1.1,obs:'teste e2e'}],{doc:'E2E-1',tipoDoc:'ENTRADA'});
        audit('ENTRADA','MOV','E2E-1');save()})()""")
    espera(op, "!DIRTY && !API.pushing", timeout=15000)
    ok(op.evaluate("API.lastErr") == "" and op.evaluate("BASEV") > v_admin, "operador lançou entrada (movimento + custo médio) e o servidor aceitou")
    op.evaluate("S.cfg.modo=S.cfg.modo==='INDEPENDENTE'?'INTEGRADO':'INDEPENDENTE';save()")
    espera(op, "API.lastErr!==''", timeout=15000)
    ok("Sem permissão" in op.evaluate("API.lastErr"), "servidor recusou mudança de configuração do operador: " + op.evaluate("API.lastErr"))
    # IA sem chave: o cliente cai no motor local; aqui só conferimos que não há erro de script
    ok(not [e for e in erros2 if "Content Security Policy" in e], "nenhuma violação de CSP no console (operador)")
    br.close()

print(json.dumps({"falhas": falhas}))
sys.exit(1 if falhas else 0)
