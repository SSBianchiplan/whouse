"""GPlanSiS|WHOUSE — servidor (FastAPI + PostgreSQL).

Papel do servidor:
  * autenticação por sessão (cookie HttpOnly) e gerenciador de usuários com papéis;
  * estado operacional versionado (controle otimista: PUT com a versão-base, 409 se
    outro usuário gravou antes — o cliente faz o merge 3-vias e reenvia);
  * histórico de versões para restauração;
  * proxy do Assistente IA (a chave da Anthropic fica só no servidor);
  * entrega real do conector REST/Webhook genérico (HMAC + Idempotency-Key).

Invariantes no servidor: perfil CONSULTA não grava; só ADMIN gerencia usuários;
o administrador master não pode ser rebaixado, desativado nem perder o acesso.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import socket
import sys
import time
import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

DSN = os.environ.get("WHOUSE_DSN", "postgresql:///whouse")
MASTER = os.environ.get("WHOUSE_MASTER", "").strip().lower()
IA_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
IA_MODELO = os.environ.get("WHOUSE_IA_MODELO", "claude-sonnet-5")
WEBHOOK_SEGREDO = os.environ.get("WHOUSE_WEBHOOK_SEGREDO", "")
SESSAO_H = int(os.environ.get("WHOUSE_SESSAO_HORAS", "12"))
COOKIE = "whouse_s"
COOKIE_SEGURO = os.environ.get("WHOUSE_COOKIE_SEGURO", "1") != "0"
HIST_MAX = 300

# IA: cota e limites por pessoa (modelo do GPlanSiS|Studio). Custos em US$ por milhão de tokens.
IA_COTA_USD = float(os.environ.get("WHOUSE_IA_COTA_USD", "10"))          # por usuário, por mês
IA_COTA_TOTAL_USD = float(os.environ.get("WHOUSE_IA_COTA_TOTAL_USD", "60"))  # todo o sistema, por mês
IA_POR_MIN = 30
IA_SIMULT = 3
IA_MAX_TOKENS = {"chat": 1500, "insights": 900}
IA_PRECOS = {"claude-opus": (5.0, 25.0), "claude-sonnet": (3.0, 15.0), "claude-haiku": (1.0, 5.0)}

MODS = ["dashboard", "recebimento", "estoque", "picking", "inventario", "planejamento", "cadastros",
        "digital", "integracoes", "dados", "auditoria", "config", "usuarios"]
PADRAO = {
    "ADMIN": MODS,
    "GESTOR": [m for m in MODS if m != "usuarios"],
    "OPERADOR": ["dashboard", "recebimento", "estoque", "picking", "inventario", "digital"],
    "CONSULTA": ["dashboard", "estoque", "inventario", "planejamento", "auditoria"],
}
PAPEIS = list(PADRAO)

pool: ConnectionPool | None = None


# ---------------------------------------------------------------- senhas
def hash_senha(s: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(s.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$%s$%s" % (base64.b64encode(salt).decode(), base64.b64encode(h).decode())


def confere_senha(s: str, guardado: str) -> bool:
    try:
        _, n, r, p, salt, h = guardado.split("$")
        calc = hashlib.scrypt(s.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(calc, base64.b64decode(h))
    except Exception:
        return False


def senha_temporaria() -> str:
    alfa = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "-".join("".join(secrets.choice(alfa) for _ in range(4)) for _ in range(3))


def valida_senha_nova(s: str) -> None:
    if len(s) < 10:
        raise HTTPException(422, "A senha precisa ter ao menos 10 caracteres")
    if s.lower() == s or s.upper() == s or not any(c.isdigit() for c in s):
        raise HTTPException(422, "Use letras maiúsculas, minúsculas e ao menos um número")


def th(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- banco
def db():
    return pool.connection()


def registra(cur, evento: str, req: Request | None, usuario: dict | None = None, login: str | None = None, detalhe: str = ""):
    cur.execute(
        "insert into whouse.acessos(usuario_id, login, evento, ip, ua, detalhe) values (%s,%s,%s,%s,%s,%s)",
        (usuario and usuario["id"], login or (usuario and usuario["login"]), evento,
         ip_de(req) if req else None, (req.headers.get("user-agent", "")[:300] if req else None), detalhe[:500]),
    )


def ip_de(req: Request) -> str:
    # O uvicorn roda com --proxy-headers --forwarded-allow-ips 127.0.0.1: request.client já é o
    # cliente real quando o pedido vem do Caddy. Ler o X-Forwarded-For à mão deixaria o cliente
    # escolher o próprio IP se o proxy um dia repassar o cabeçalho recebido.
    return req.client.host if req.client else ""


def modulos_efetivos(u: dict) -> list[str]:
    base = u["modulos"] if u.get("modulos") is not None else PADRAO[u["papel"]]
    out = [m for m in MODS if m in base]
    if u["papel"] != "ADMIN" and "usuarios" in out:
        out.remove("usuarios")
    if "dashboard" not in out:
        out.insert(0, "dashboard")
    return out


def publico(u: dict) -> dict:
    return {
        "id": u["id"], "login": u["login"], "nome": u["nome"], "email": u.get("email"), "papel": u["papel"],
        "modulos": u.get("modulos"), "modulosEfetivos": modulos_efetivos(u), "ativo": u["ativo"],
        "master": u["master"], "trocarSenha": u["trocar_senha"],
        "ultimoLogin": u["ultimo_login"].isoformat() if u.get("ultimo_login") else None,
        "criadoEm": u["criado_em"].isoformat() if u.get("criado_em") else None,
        "bloqueadoAte": u["bloqueado_ate"].isoformat() if u.get("bloqueado_ate") else None,
        "falhas": u.get("falhas", 0),
    }


@asynccontextmanager
async def vida(app):
    global pool
    pool = ConnectionPool(DSN, min_size=1, max_size=8, kwargs={"row_factory": dict_row, "autocommit": False}, open=True)
    with db() as c:
        c.execute((Path(__file__).parent / "schema.sql").read_text())
        c.execute("insert into whouse.estado(id, versao, doc) values (1, 0, '{}'::jsonb) on conflict do nothing")
        if MASTER:
            c.execute("update whouse.usuarios set master = (lower(login) = %s), papel = case when lower(login) = %s then 'ADMIN' else papel end,"
                      " ativo = case when lower(login) = %s then true else ativo end", (MASTER, MASTER, MASTER))
        c.execute("delete from whouse.sessoes where expira_em < now()")
    yield
    pool.close()


app = FastAPI(title="GPlanSiS|WHOUSE", lifespan=vida, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def csrf(request: Request, call_next):
    # Mutação só com cabeçalho próprio: formulário de outro site não consegue enviá-lo.
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/"):
        if request.headers.get("x-whouse") != "1":
            return JSONResponse({"detail": "Requisição recusada (CSRF)"}, status_code=403)
    resp = await call_next(request)
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ---------------------------------------------------------------- sessão
def usuario_atual(request: Request) -> dict:
    tok = request.cookies.get(COOKIE)
    if not tok:
        raise HTTPException(401, "Não autenticado")
    with db() as c:
        cur = c.cursor()
        cur.execute("""select u.*, s.expira_em from whouse.sessoes s join whouse.usuarios u on u.id = s.usuario_id
                       where s.token_hash = %s and s.expira_em > now()""", (th(tok),))
        u = cur.fetchone()
        if not u or not u["ativo"]:
            raise HTTPException(401, "Sessão expirada")
        # renovação deslizante: estende quando passou da metade
        if u["expira_em"] - datetime.now(timezone.utc) < timedelta(hours=SESSAO_H / 2):
            cur.execute("update whouse.sessoes set expira_em = now() + make_interval(hours => %s), ultimo_uso = now() where token_hash = %s", (SESSAO_H, th(tok)))
        else:
            cur.execute("update whouse.sessoes set ultimo_uso = now() where token_hash = %s and ultimo_uso < now() - interval '1 minute'", (th(tok),))
    return u


def exige_admin(u: dict = Depends(usuario_atual)) -> dict:
    if u["papel"] != "ADMIN":
        raise HTTPException(403, "Somente administradores")
    return u


def exige_escrita(u: dict = Depends(usuario_atual)) -> dict:
    if u["papel"] == "CONSULTA":
        raise HTTPException(403, "Perfil CONSULTA é somente leitura")
    if u["trocar_senha"]:
        raise HTTPException(403, "Troque a senha temporária antes de operar")
    return u


FALHAS_IP: dict[str, deque] = defaultdict(deque)
MSG_LOGIN_FALHA = "Login ou senha inválidos (após 5 erros a conta fica bloqueada por 15 minutos)"
HASH_FICTICIO = hash_senha(secrets.token_urlsafe(16))


class Login(BaseModel):
    login: str = Field(max_length=120)
    senha: str = Field(max_length=200)


@app.get("/api/saude")
def saude():
    with db() as c:
        c.execute("select 1")
    return {"ok": True, "app": "whouse", "ia": bool(IA_KEY)}


@app.post("/api/auth/login")
def login(body: Login, request: Request, response: Response):
    ip = ip_de(request)
    q = FALHAS_IP[ip]
    agora = time.time()
    while q and q[0] < agora - 900:
        q.popleft()
    if len(q) >= 20:
        raise HTTPException(429, "Muitas tentativas deste endereço — aguarde 15 minutos")
    lg = body.login.strip().lower()
    with db() as c:
        cur = c.cursor()
        cur.execute("select * from whouse.usuarios where lower(login) = %s", (lg,))
        u = cur.fetchone()
        # Mesma resposta (401, mesma mensagem) para login inexistente, senha errada, conta inativa
        # ou bloqueada: o status não revela quais logins existem. O bloqueio continua valendo.
        if u and u["bloqueado_ate"] and u["bloqueado_ate"] > datetime.now(timezone.utc):
            q.append(agora)
            registra(cur, "LOGIN_BLOQUEADO", request, u)
            c.commit()
            time.sleep(0.4)
            raise HTTPException(401, MSG_LOGIN_FALHA)
        ok = confere_senha(body.senha, u["senha_hash"] if u else HASH_FICTICIO)  # custo igual sem conta
        if not u or not u["ativo"] or not ok:
            q.append(agora)
            if u:
                # bloqueio vencido zera o contador: sem isso, uma única falha depois dos 15 min
                # bloqueava de novo, para sempre (falhas nunca voltava a 0 sem login certo).
                cur.execute("""update whouse.usuarios set
                                 falhas = case when bloqueado_ate is not null and bloqueado_ate <= now() then 1 else falhas + 1 end,
                                 bloqueado_ate = case when bloqueado_ate is not null and bloqueado_ate <= now() then null
                                                      when falhas + 1 >= 5 then now() + interval '15 minutes'
                                                      else bloqueado_ate end
                               where id = %s""", (u["id"],))
            registra(cur, "LOGIN_FALHA", request, u, login=lg)
            c.commit()
            time.sleep(0.4)
            raise HTTPException(401, MSG_LOGIN_FALHA)
        tok = secrets.token_urlsafe(32)
        cur.execute("insert into whouse.sessoes(token_hash, usuario_id, expira_em, ip, ua) values (%s,%s, now() + make_interval(hours => %s), %s, %s)",
                    (th(tok), u["id"], SESSAO_H, ip, request.headers.get("user-agent", "")[:300]))
        cur.execute("update whouse.usuarios set falhas = 0, bloqueado_ate = null, ultimo_login = now() where id = %s returning *", (u["id"],))
        u = cur.fetchone()
        registra(cur, "LOGIN", request, u)
    response.set_cookie(COOKIE, tok, max_age=SESSAO_H * 3600 * 2, httponly=True, secure=COOKIE_SEGURO, samesite="strict", path="/")
    return me_payload(u)


def me_payload(u: dict) -> dict:
    return {**publico(u), "ia": bool(IA_KEY), "iaModelo": IA_MODELO if IA_KEY else None, "webhook": bool(WEBHOOK_SEGREDO)}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    tok = request.cookies.get(COOKIE)
    if tok:
        with db() as c:
            cur = c.cursor()
            cur.execute("delete from whouse.sessoes where token_hash = %s returning usuario_id", (th(tok),))
            r = cur.fetchone()
            if r:
                registra(cur, "LOGOUT", request, {"id": r["usuario_id"], "login": None})
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(u: dict = Depends(usuario_atual)):
    return me_payload(u)


class TrocaSenha(BaseModel):
    atual: str = Field(max_length=200)
    nova: str = Field(max_length=200)


@app.post("/api/auth/senha")
def troca_senha(body: TrocaSenha, request: Request, u: dict = Depends(usuario_atual)):
    if not confere_senha(body.atual, u["senha_hash"]):
        raise HTTPException(422, "Senha atual incorreta")
    valida_senha_nova(body.nova)
    if body.nova == body.atual:
        raise HTTPException(422, "A nova senha deve ser diferente da atual")
    tok = request.cookies.get(COOKIE)
    with db() as c:
        cur = c.cursor()
        cur.execute("update whouse.usuarios set senha_hash = %s, trocar_senha = false, atualizado_em = now() where id = %s returning *",
                    (hash_senha(body.nova), u["id"]))
        u2 = cur.fetchone()
        cur.execute("delete from whouse.sessoes where usuario_id = %s and token_hash <> %s", (u["id"], th(tok or "")))
        registra(cur, "SENHA_ALTERADA", request, u)
    return me_payload(u2)


# ---------------------------------------------------------------- usuários
class UsuarioIn(BaseModel):
    login: str = Field(min_length=3, max_length=120)
    nome: str = Field(min_length=2, max_length=120)
    email: str | None = Field(default=None, max_length=160)
    papel: str
    modulos: list[str] | None = None
    ativo: bool = True


class UsuarioPatch(BaseModel):
    nome: str | None = Field(default=None, min_length=2, max_length=120)
    email: str | None = Field(default=None, max_length=160)
    papel: str | None = None
    modulos: list[str] | None = None
    usarPadrao: bool = False
    ativo: bool | None = None


def valida_papel_modulos(papel: str | None, modulos: list[str] | None):
    if papel is not None and papel not in PAPEIS:
        raise HTTPException(422, "Papel inválido")
    if modulos is not None:
        ruins = [m for m in modulos if m not in MODS]
        if ruins:
            raise HTTPException(422, f"Módulos inválidos: {', '.join(ruins)}")


@app.get("/api/usuarios")
def lista_usuarios(u: dict = Depends(exige_admin)):
    with db() as c:
        cur = c.cursor()
        cur.execute("""select u.*, (select count(*) from whouse.sessoes s where s.usuario_id = u.id and s.expira_em > now()) as sessoes
                       from whouse.usuarios u order by u.ativo desc, u.nome""")
        rows = cur.fetchall()
    return {"usuarios": [{**publico(r), "sessoes": r["sessoes"]} for r in rows], "papeis": PADRAO, "modulos": MODS}


@app.post("/api/usuarios")
def cria_usuario(body: UsuarioIn, request: Request, adm: dict = Depends(exige_admin)):
    valida_papel_modulos(body.papel, body.modulos)
    temp = senha_temporaria()
    lg = body.login.strip().lower()
    with db() as c:
        cur = c.cursor()
        cur.execute("select 1 from whouse.usuarios where lower(login) = %s", (lg,))
        if cur.fetchone():
            raise HTTPException(409, "Já existe um usuário com este login")
        cur.execute("""insert into whouse.usuarios(login, nome, email, papel, modulos, ativo, master, senha_hash, trocar_senha, criado_por)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,true,%s) returning *""",
                    (lg, body.nome.strip(), (body.email or "").strip() or None, body.papel, body.modulos, body.ativo,
                     lg == MASTER, hash_senha(temp), adm["login"]))
        novo = cur.fetchone()
        registra(cur, "USUARIO_CRIADO", request, adm, detalhe=f"{lg} ({body.papel})")
    return {"usuario": publico(novo), "senhaTemporaria": temp}


@app.patch("/api/usuarios/{uid}")
def altera_usuario(uid: int, body: UsuarioPatch, request: Request, adm: dict = Depends(exige_admin)):
    valida_papel_modulos(body.papel, body.modulos)
    with db() as c:
        cur = c.cursor()
        cur.execute("select * from whouse.usuarios where id = %s for update", (uid,))
        alvo = cur.fetchone()
        if not alvo:
            raise HTTPException(404, "Usuário não encontrado")
        if alvo["master"] and ((body.papel and body.papel != "ADMIN") or body.ativo is False):
            raise HTTPException(409, "O administrador master não pode ser rebaixado nem desativado")
        if uid == adm["id"] and ((body.papel and body.papel != "ADMIN") or body.ativo is False):
            raise HTTPException(409, "Você não pode rebaixar ou desativar a si mesmo")
        papel = body.papel or alvo["papel"]
        ativo = alvo["ativo"] if body.ativo is None else body.ativo
        if alvo["papel"] == "ADMIN" and alvo["ativo"] and (papel != "ADMIN" or not ativo):
            cur.execute("select count(*) n from whouse.usuarios where papel = 'ADMIN' and ativo and id <> %s", (uid,))
            if cur.fetchone()["n"] == 0:
                raise HTTPException(409, "É preciso manter ao menos um administrador ativo")
        modulos = None if body.usarPadrao else (body.modulos if body.modulos is not None else alvo["modulos"])
        cur.execute("""update whouse.usuarios set nome = %s, email = %s, papel = %s, modulos = %s, ativo = %s, atualizado_em = now()
                       where id = %s returning *""",
                    (body.nome or alvo["nome"], alvo["email"] if body.email is None else (body.email.strip() or None),
                     papel, modulos, ativo, uid))
        novo = cur.fetchone()
        if not ativo:
            cur.execute("delete from whouse.sessoes where usuario_id = %s", (uid,))
        mud = [k for k in ("nome", "email", "papel", "modulos", "ativo") if novo[k] != alvo[k]]
        registra(cur, "USUARIO_ALTERADO", request, adm, detalhe=f"{alvo['login']}: {', '.join(mud) or 'sem mudança'}")
    return {"usuario": publico(novo)}


@app.post("/api/usuarios/{uid}/senha")
def redefine_senha(uid: int, request: Request, adm: dict = Depends(exige_admin)):
    temp = senha_temporaria()
    with db() as c:
        cur = c.cursor()
        cur.execute("""update whouse.usuarios set senha_hash = %s, trocar_senha = true, falhas = 0, bloqueado_ate = null, atualizado_em = now()
                       where id = %s returning *""", (hash_senha(temp), uid))
        alvo = cur.fetchone()
        if not alvo:
            raise HTTPException(404, "Usuário não encontrado")
        cur.execute("delete from whouse.sessoes where usuario_id = %s", (uid,))
        registra(cur, "SENHA_REDEFINIDA", request, adm, detalhe=alvo["login"])
    return {"senhaTemporaria": temp}


@app.post("/api/usuarios/{uid}/desbloquear")
def desbloqueia(uid: int, request: Request, adm: dict = Depends(exige_admin)):
    with db() as c:
        cur = c.cursor()
        cur.execute("update whouse.usuarios set falhas = 0, bloqueado_ate = null where id = %s returning login", (uid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Usuário não encontrado")
        registra(cur, "USUARIO_DESBLOQUEADO", request, adm, detalhe=r["login"])
    return {"ok": True}


@app.delete("/api/usuarios/{uid}/sessoes")
def encerra_sessoes(uid: int, request: Request, adm: dict = Depends(exige_admin)):
    with db() as c:
        cur = c.cursor()
        cur.execute("delete from whouse.sessoes where usuario_id = %s", (uid,))
        n = cur.rowcount
        registra(cur, "SESSOES_ENCERRADAS", request, adm, detalhe=f"usuário {uid}: {n}")
    return {"encerradas": n}


@app.get("/api/acessos")
def acessos(limite: int = 300, adm: dict = Depends(exige_admin)):
    with db() as c:
        cur = c.cursor()
        cur.execute("select * from whouse.acessos order by ts desc limit %s", (min(max(limite, 1), 2000),))
        rows = cur.fetchall()
    return [{**r, "ts": r["ts"].isoformat()} for r in rows]


# ---------------------------------------------------------------- estado: permissões no servidor
# O cliente esconde telas e botões por papel e módulo; aqui a mesma regra vale para o que chega
# no PUT. Compara o documento recebido com o atual (mesma versão-base, então a diferença é só do
# autor) e recusa mudança em parte do estado que o papel/módulos do usuário não alcança.
CFG_PADRAO = {"empresa": "Minha Empresa Ltda", "estrategia": "FEFO", "inspecaoPadrao": True, "contagemCega": True,
              "toleranciaInv": 0.02, "diasVencAlerta": 45, "modo": "INDEPENDENTE", "tema": ""}
CHAVES_COL = {"materiais": lambda m: m.get("codigo"), "depositos": lambda d: d.get("codigo"),
              "enderecos": lambda e: f"{e.get('deposito')}|{e.get('codigo')}", "recebimentos": lambda r: r.get("numero"),
              "pickings": lambda p: p.get("numero"), "inventarios": lambda i: i.get("numero"),
              "requisicoes": lambda r: r.get("numero"), "integracoes": lambda i: i.get("id"), "movs": lambda m: m.get("id")}
# quem pode mudar cada coleção (qualquer um dos módulos basta); ver as telas que gravam em web/app.js
MOD_COL = {
    "depositos": {"cadastros", "dados"},
    "enderecos": {"cadastros", "dados", "estoque", "digital"},
    "materiais": {"cadastros", "dados", "planejamento", "estoque", "digital"},
    "recebimentos": {"recebimento", "digital"},
    "pickings": {"picking", "digital"},
    "inventarios": {"inventario", "digital"},
}
# campos de material recalculados por movimentos (custo médio na entrada): não exigem o módulo
MAT_CALCULADOS = {"custo"}
RANK = {"CONSULTA": 0, "OPERADOR": 1, "GESTOR": 2, "ADMIN": 3}


def _por_chave(lista, col: str) -> dict:
    out = {}
    if isinstance(lista, list):
        f = CHAVES_COL[col]
        for x in lista:
            if isinstance(x, dict):
                out[f(x)] = x
    return out


def _alteradas(antes: dict, depois: dict) -> tuple[set, set, set]:
    """(incluídas, removidas, alteradas) entre dois mapas chave→item."""
    inc = set(depois) - set(antes)
    rem = set(antes) - set(depois)
    alt = {k for k in set(antes) & set(depois) if antes[k] != depois[k]}
    return inc, rem, alt


def _sem(d: dict, campos: set) -> dict:
    return {k: v for k, v in d.items() if k not in campos}


def verifica_permissoes(u: dict, antigo: dict, novo: dict) -> None:
    if u["papel"] == "ADMIN":
        return
    mods = set(modulos_efetivos(u))
    gestor = RANK.get(u["papel"], 0) >= RANK["GESTOR"]

    def nega(msg: str):
        raise HTTPException(403, f"Sem permissão: {msg}")

    # base ainda não iniciada, reinício e restauração: só ADMIN (o cliente também só oferece ao ADMIN)
    if not isinstance(antigo.get("movs"), list) or not isinstance(antigo.get("materiais"), list):
        nega("só o administrador inicia a base")
    # razão de movimentos: só acrescenta (o cliente nunca altera nem apaga movimento)
    m_old, m_new = _por_chave(antigo.get("movs"), "movs"), _por_chave(novo.get("movs"), "movs")
    _, rem, alt = _alteradas(m_old, m_new)
    if rem or alt:
        nega("movimentos lançados não podem ser apagados nem alterados (reinício e restauração são do administrador)")

    # configurações: GESTOR/ADMIN com o módulo Configurações
    c_old = antigo.get("cfg") if isinstance(antigo.get("cfg"), dict) else {}
    c_new = novo.get("cfg") if isinstance(novo.get("cfg"), dict) else {}
    mud_cfg = {k for k in set(c_old) | set(c_new) if c_old.get(k) != c_new.get(k)
               and not (k not in c_old and k in CFG_PADRAO and c_new.get(k) == CFG_PADRAO[k])  # padrão preenchido pelo cliente
               and not (k == "usuario" and k not in c_old)}
    if mud_cfg and not (gestor and "config" in mods):
        nega("configurações exigem GESTOR com o módulo Configurações")

    # integrações: GESTOR; mudar o cadastro do conector exige também o módulo Integrações
    i_old, i_new = _por_chave(antigo.get("integracoes"), "integracoes"), _por_chave(novo.get("integracoes"), "integracoes")
    inc, rem, alt = _alteradas(i_old, i_new)
    if inc or rem or alt:
        if not gestor:
            nega("integrações exigem GESTOR")
        so_sync = not inc and not rem and all(_sem(i_old[k], {"ultimoSync"}) == _sem(i_new[k], {"ultimoSync"}) for k in alt)
        if not so_sync and "integracoes" not in mods:
            nega("configurar conectores exige o módulo Integrações")

    # coleções por módulo
    for col, permitidos in MOD_COL.items():
        a, d = _por_chave(antigo.get(col), col), _por_chave(novo.get(col), col)
        inc, rem, alt = _alteradas(a, d)
        if col == "materiais":
            alt = {k for k in alt if _sem(a[k], MAT_CALCULADOS) != _sem(d[k], MAT_CALCULADOS)}
        if (inc or rem or alt) and not (mods & permitidos):
            nega(f"{col} exige um dos módulos: {', '.join(sorted(permitidos))}")

    if gestor:
        return
    # aprovações (GESTOR/ADMIN): inventário aprovado, requisição aprovada/rejeitada/enviada, liberação/rejeição de CQ
    inv_o, inv_n = _por_chave(antigo.get("inventarios"), "inventarios"), _por_chave(novo.get("inventarios"), "inventarios")
    for k, i in inv_n.items():
        if i.get("status") == "APROVADO" and (inv_o.get(k) or {}).get("status") != "APROVADO":
            nega("aprovar inventário exige GESTOR")
    rq_o, rq_n = _por_chave(antigo.get("requisicoes"), "requisicoes"), _por_chave(novo.get("requisicoes"), "requisicoes")
    for k, r in rq_n.items():
        st_old = (rq_o.get(k) or {}).get("status", "PROPOSTA")
        if r.get("status") != st_old:
            nega("aprovar, rejeitar ou enviar requisição exige GESTOR")
    rc_o, rc_n = _por_chave(antigo.get("recebimentos"), "recebimentos"), _por_chave(novo.get("recebimentos"), "recebimentos")
    for k, r in rc_n.items():
        velho = rc_o.get(k)
        if not velho:
            continue
        itens_v = velho.get("itens") if isinstance(velho.get("itens"), list) else []
        itens_n = r.get("itens") if isinstance(r.get("itens"), list) else []
        for iv, inn in zip(itens_v, itens_n):
            if isinstance(iv, dict) and isinstance(inn, dict) and iv.get("cq") == "PENDENTE" and inn.get("cq") != "PENDENTE":
                nega("liberar ou rejeitar na qualidade (CQ) exige GESTOR")


# ---------------------------------------------------------------- estado
@app.get("/api/estado/versao")
def estado_versao(u: dict = Depends(usuario_atual)):
    with db() as c:
        cur = c.cursor()
        cur.execute("select versao, atualizado_em, atualizado_por from whouse.estado where id = 1")
        r = cur.fetchone()
    return {"versao": r["versao"], "atualizadoEm": r["atualizado_em"].isoformat(), "atualizadoPor": r["atualizado_por"]}


@app.get("/api/estado")
def estado(u: dict = Depends(usuario_atual)):
    with db() as c:
        cur = c.cursor()
        cur.execute("select versao, doc::text as doc, atualizado_em, atualizado_por from whouse.estado where id = 1")
        r = cur.fetchone()
    corpo = '{"versao":%d,"atualizadoPor":%s,"atualizadoEm":"%s","doc":%s}' % (
        r["versao"], json.dumps(r["atualizado_por"]), r["atualizado_em"].isoformat(), r["doc"])
    return Response(corpo, media_type="application/json")


@app.put("/api/estado")
async def grava_estado(request: Request, u: dict = Depends(exige_escrita)):
    bruto = await request.body()
    if len(bruto) > 40 * 1024 * 1024:
        raise HTTPException(413, "Documento grande demais")
    try:
        corpo = json.loads(bruto)
        base = int(corpo["base"])
        doc = corpo["doc"]
        assert isinstance(doc, dict) and isinstance(doc.get("movs"), list) and isinstance(doc.get("materiais"), list)
    except Exception:
        raise HTTPException(422, "Documento inválido")
    quem = f"{u['nome']} <{u['login']}>"
    texto = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    with db() as c:
        cur = c.cursor()
        cur.execute("select versao, doc::text as doc from whouse.estado where id = 1 for update")
        atual = cur.fetchone()
        if atual["versao"] != base:
            c.rollback()
            corpo = '{"versao":%d,"doc":%s}' % (atual["versao"], atual["doc"])
            return Response(corpo, status_code=409, media_type="application/json")
        try:
            verifica_permissoes(u, json.loads(atual["doc"]), doc)
        except HTTPException as e:
            c.rollback()
            with db() as c2:
                registra(c2.cursor(), "ESTADO_NEGADO", request, u, detalhe=str(e.detail))
            raise
        nova = base + 1
        cur.execute("update whouse.estado set versao = %s, doc = %s::jsonb, atualizado_em = now(), atualizado_por = %s where id = 1",
                    (nova, texto, quem))
        cur.execute("insert into whouse.estado_hist(versao, doc, atualizado_por, bytes) values (%s, %s::jsonb, %s, %s)",
                    (nova, texto, quem, len(texto)))
        cur.execute("delete from whouse.estado_hist where versao <= %s", (nova - HIST_MAX,))
    return {"versao": nova}


@app.get("/api/estado/historico")
def historico(adm: dict = Depends(exige_admin)):
    with db() as c:
        cur = c.cursor()
        cur.execute("""select versao, atualizado_em, atualizado_por, bytes,
                              jsonb_array_length(coalesce(doc->'movs','[]'::jsonb)) movs,
                              jsonb_array_length(coalesce(doc->'materiais','[]'::jsonb)) materiais
                       from whouse.estado_hist order by versao desc limit 200""")
        rows = cur.fetchall()
    return [{**r, "atualizado_em": r["atualizado_em"].isoformat()} for r in rows]


@app.post("/api/estado/restaurar/{versao}")
def restaura(versao: int, request: Request, adm: dict = Depends(exige_admin)):
    quem = f"{adm['nome']} <{adm['login']}>"
    with db() as c:
        cur = c.cursor()
        cur.execute("select doc from whouse.estado_hist where versao = %s", (versao,))
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Versão não encontrada no histórico")
        cur.execute("select versao from whouse.estado where id = 1 for update")
        nova = cur.fetchone()["versao"] + 1
        cur.execute("update whouse.estado set versao = %s, doc = %s, atualizado_em = now(), atualizado_por = %s where id = 1",
                    (nova, Jsonb(h["doc"]), quem + f" (restauração da v{versao})"))
        cur.execute("insert into whouse.estado_hist(versao, doc, atualizado_por, bytes) values (%s,%s,%s,%s)",
                    (nova, Jsonb(h["doc"]), quem + f" (restauração da v{versao})", 0))
        registra(cur, "ESTADO_RESTAURADO", request, adm, detalhe=f"v{versao} → v{nova}")
    return {"versao": nova}


# ---------------------------------------------------------------- IA
# O servidor monta o prompt de sistema e a lista de ferramentas: o cliente só manda a conversa.
# As ferramentas rodam no navegador sobre os dados que o usuário já vê (o servidor só repassa o
# pedido de uso). CONSULTA conversa, mas não recebe a ferramenta que cria proposta de requisição.
_SCHEMA_VAZIO = {"type": "object", "properties": {}}
IA_TOOLS = [
    {"name": "buscar_material", "description": "Busca materiais por código, descrição ou grupo. Retorna até 10.",
     "input_schema": {"type": "object", "properties": {"termo": {"type": "string"}}, "required": ["termo"]}},
    {"name": "consultar_saldo", "description": "Saldo detalhado de um material por depósito, endereço, lote e tipo de estoque (NORMAL ou ORDEM), com disponível e reservado.",
     "input_schema": {"type": "object", "properties": {"material": {"type": "string"}}, "required": ["material"]}},
    {"name": "listar_reposicao", "description": "Itens em ruptura ou ponto de pedido com cobertura, consumo, necessidade das ordens e sugestão de compra.",
     "input_schema": _SCHEMA_VAZIO},
    {"name": "lotes_vencendo", "description": "Lotes com saldo que vencem em até N dias (negativo = vencido).",
     "input_schema": {"type": "object", "properties": {"dias": {"type": "number"}}, "required": ["dias"]}},
    {"name": "status_ordem", "description": "Cobertura de materiais de uma ordem (OP/OS/Projeto/OV): necessário, segregado, consumido e falta.",
     "input_schema": {"type": "object", "properties": {"ordem": {"type": "string"}}, "required": ["ordem"]}},
    {"name": "resumo_kpis", "description": "KPIs gerais do almoxarifado.", "input_schema": _SCHEMA_VAZIO},
    {"name": "propor_requisicao", "description": "Cria uma PROPOSTA de requisição de compra que o usuário precisa aprovar. Não compra nada.",
     "input_schema": {"type": "object", "properties": {"material": {"type": "string"}, "qtd": {"type": "number"},
                                                       "justificativa": {"type": "string"}}, "required": ["material", "qtd", "justificativa"]}},
]
ESTRATEGIAS = {"FEFO", "FIFO", "LIFO"}


def ia_sistema(papel: str) -> str:
    estrategia = "FEFO"
    try:
        with db() as c:
            r = c.execute("select doc->'cfg'->>'estrategia' e from whouse.estado where id = 1").fetchone()
        if r and r["e"] in ESTRATEGIAS:
            estrategia = r["e"]
    except Exception:
        pass
    hoje = datetime.now(ZoneInfo("America/Sao_Paulo")).strftime("%d/%m/%Y")
    gov = ("Regra de governança: a IA propõe, o humano decide — você pode criar apenas PROPOSTAS de requisição com "
           "propor_requisicao e deve dizer que exigem aprovação." if papel != "CONSULTA" else
           "Regra de governança: este usuário tem perfil somente leitura — não crie nem proponha registros; apenas consulte e explique.")
    return ("Você é o assistente de gestão de materiais do GPlanSiS|WHOUSE (almoxarifado/WMS industrial). Responda em "
            "português do Brasil, direto e técnico, com números e códigos exatos obtidos pelas ferramentas — nunca invente "
            f"saldo, lote ou data. Hoje é {hoje}. Estratégia de saída: {estrategia}. Conceitos: estoque NORMAL (livre) e "
            "ORDEM (stock by order, segregado e só consumível pela ordem dona); lotes em QUARENTENA/BLOQUEADO não saem. "
            f"{gov} Formate em texto simples com listas curtas; sem markdown pesado.")


def ia_tools(papel: str) -> list[dict]:
    return [t for t in IA_TOOLS if not (papel == "CONSULTA" and t["name"] == "propor_requisicao")]


class IAReq(BaseModel):
    # system, tools e max_tokens enviados por clientes antigos são ignorados (o servidor decide)
    modo: str | None = Field(default=None, max_length=20)
    messages: list[dict] = Field(max_length=60)
    tools: list | None = None


IA_TIPOS_OK = {"text", "tool_use", "tool_result"}


def valida_mensagens(msgs: list[dict]) -> list[dict]:
    out = []
    for m in msgs[-40:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            raise HTTPException(422, "Mensagem inválida")
        ct = m.get("content")
        if isinstance(ct, str):
            pass
        elif isinstance(ct, list):
            for b in ct:
                if not isinstance(b, dict) or b.get("type") not in IA_TIPOS_OK:
                    raise HTTPException(422, "Conteúdo de mensagem não permitido")
        else:
            raise HTTPException(422, "Mensagem inválida")
        out.append({"role": m["role"], "content": ct})
    return out


def ia_preco(modelo: str) -> tuple[float, float]:
    for pre, v in IA_PRECOS.items():
        if modelo.startswith(pre):
            return v
    return 5.0, 25.0  # conservador


def ia_gasto_mes(usuario_id: int | None = None) -> float:
    with db() as c:
        if usuario_id is None:
            r = c.execute("select coalesce(sum(custo_usd),0) s from whouse.ia_uso where ts >= date_trunc('month', now())").fetchone()
        else:
            r = c.execute("select coalesce(sum(custo_usd),0) s from whouse.ia_uso where usuario_id = %s and ts >= date_trunc('month', now())",
                          (usuario_id,)).fetchone()
    return float(r["s"])


_IA_RECENTES: dict[int, list[float]] = defaultdict(list)
_IA_EM_CURSO: dict[int, int] = defaultdict(int)


@app.post("/api/ia/mensagens")
async def ia(body: IAReq, u: dict = Depends(usuario_atual)):
    if not IA_KEY:
        raise HTTPException(503, "IA não configurada no servidor (ANTHROPIC_API_KEY)")
    if u["trocar_senha"]:
        raise HTTPException(403, "Troque a senha temporária antes de usar a IA")
    modo = body.modo if body.modo in IA_MAX_TOKENS else ("chat" if body.tools else "insights")
    msgs = valida_mensagens(body.messages)
    if not msgs:
        raise HTTPException(422, "Conversa vazia")
    if len(json.dumps(msgs)) > 200_000:
        raise HTTPException(413, "Conversa longa demais — limpe o histórico")
    gasto, gasto_total = ia_gasto_mes(u["id"]), ia_gasto_mes()
    if gasto >= IA_COTA_USD:
        raise HTTPException(402, f"Cota de IA do mês atingida (US$ {gasto:.2f} de US$ {IA_COTA_USD:.2f}). Fale com um administrador.")
    if gasto_total >= IA_COTA_TOTAL_USD:
        raise HTTPException(402, "Cota de IA do sistema atingida neste mês. Fale com um administrador.")
    agora = time.time()
    rec = _IA_RECENTES[u["id"]] = [t for t in _IA_RECENTES[u["id"]] if agora - t < 60]
    if len(rec) >= IA_POR_MIN or _IA_EM_CURSO[u["id"]] >= IA_SIMULT:
        raise HTTPException(429, "Muitas chamadas de IA seguidas. Aguarde alguns segundos.")
    rec.append(agora)
    payload = {"model": IA_MODELO, "max_tokens": IA_MAX_TOKENS[modo], "system": ia_sistema(u["papel"]), "messages": msgs}
    if modo == "chat":
        payload["tools"] = ia_tools(u["papel"])
    _IA_EM_CURSO[u["id"]] += 1
    try:
        async with httpx.AsyncClient(timeout=120) as cli:
            r = await cli.post("https://api.anthropic.com/v1/messages", json=payload,
                               headers={"x-api-key": IA_KEY, "anthropic-version": "2023-06-01"})
    finally:
        _IA_EM_CURSO[u["id"]] -= 1
    if r.status_code >= 400:
        raise HTTPException(502, f"IA respondeu {r.status_code}: {r.text[:300]}")
    j = r.json()
    uso = j.get("usage") or {}
    pin, pout = ia_preco(IA_MODELO)
    tin = int(uso.get("input_tokens") or 0) + int(uso.get("cache_creation_input_tokens") or 0) + int(uso.get("cache_read_input_tokens") or 0)
    tout = int(uso.get("output_tokens") or 0)
    custo = (tin * pin + tout * pout) / 1e6
    with db() as c:
        c.execute("insert into whouse.ia_uso(usuario_id, modo, modelo, tokens_in, tokens_out, custo_usd) values (%s,%s,%s,%s,%s,%s)",
                  (u["id"], modo, IA_MODELO, tin, tout, custo))
    return j


# ---------------------------------------------------------------- webhook (conector REST genérico)
class EnvioWebhook(BaseModel):
    url: str = Field(max_length=500)
    idem: str = Field(max_length=200)
    payload: dict


def _ip_permitido(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%")[0])
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    # is_global já exclui privado, loopback, link-local (169.254/16, metadados), 100.64/10 (CGNAT),
    # 0.0.0.0/8, reservados e documentação; multicast é recusado à parte.
    return a.is_global and not a.is_multicast


def destino_publico(url: str) -> tuple[str, str, int]:
    """Valida o destino e devolve (host, ip, porta). A conexão usa ESTE ip (fixado), então o DNS
    não pode trocar o endereço entre a checagem e o envio (DNS rebinding)."""
    p = urlparse(url)
    if p.scheme != "https" or not p.hostname or p.username or p.password:
        raise HTTPException(422, "O webhook exige URL https:// sem credenciais")
    try:
        porta = p.port or 443
    except ValueError:
        raise HTTPException(422, "Porta inválida")
    try:
        ips = [ai[4][0] for ai in socket.getaddrinfo(p.hostname, porta, type=socket.SOCK_STREAM)]
    except socket.gaierror:
        raise HTTPException(422, f"Host {p.hostname} não resolve")
    if not ips:
        raise HTTPException(422, f"Host {p.hostname} não resolve")
    for ip in ips:
        if not _ip_permitido(ip):
            raise HTTPException(422, "Destino em rede interna não é permitido")
    return p.hostname, ips[0].split("%")[0], porta


def url_fixada(url: str, ip: str) -> str:
    p = urlparse(url)
    h = f"[{ip}]" if ":" in ip else ip
    return p._replace(netloc=f"{h}:{p.port or 443}").geturl()


@app.post("/api/integracao/webhook")
async def webhook(body: EnvioWebhook, u: dict = Depends(exige_escrita)):
    if u["papel"] not in ("ADMIN", "GESTOR"):
        raise HTTPException(403, "Envio de integração exige GESTOR ou ADMIN")
    if not WEBHOOK_SEGREDO:
        raise HTTPException(503, "Segredo HMAC do webhook não configurado no servidor (WHOUSE_WEBHOOK_SEGREDO)")
    host, ip, porta = await asyncio.to_thread(destino_publico, body.url)
    dado = json.dumps(body.payload, ensure_ascii=False, separators=(",", ":")).encode()
    ts = str(int(time.time()))
    sig = hmac.new(WEBHOOK_SEGREDO.encode(), ts.encode() + b"." + dado, hashlib.sha256).hexdigest()
    host_hdr = host if porta == 443 else f"{host}:{porta}"
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False) as cli:
            # conecta no IP validado; Host e SNI (e a verificação do certificado) usam o nome original
            r = await cli.post(url_fixada(body.url, ip), content=dado, headers={
                "Host": host_hdr, "Content-Type": "application/json", "Idempotency-Key": body.idem,
                "X-WHOUSE-Timestamp": ts, "X-WHOUSE-Signature": "sha256=" + sig, "User-Agent": "GPlanSiS-WHOUSE/1"},
                extensions={"sni_hostname": host})
    except httpx.HTTPError as e:
        return {"ok": False, "status": 0, "msg": f"Falha de conexão: {e.__class__.__name__}"}
    return {"ok": 200 <= r.status_code < 300, "status": r.status_code, "msg": r.text[:300]}


if os.environ.get("WHOUSE_WEB"):  # desenvolvimento; em produção o Caddy serve os estáticos
    from fastapi.staticfiles import StaticFiles
    CSP = (Path(__file__).parent.parent / "deploy" / "csp.txt").read_text().strip()

    @app.middleware("http")
    async def csp_dev(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["Content-Security-Policy"] = CSP
        return resp

    app.mount("/", StaticFiles(directory=os.environ["WHOUSE_WEB"], html=True), name="web")


# ---------------------------------------------------------------- CLI
def cli():
    import argparse
    ap = argparse.ArgumentParser(prog="whouse")
    sp = ap.add_subparsers(dest="cmd", required=True)
    a = sp.add_parser("criar-admin", help="cria (ou redefine) um administrador e imprime a senha temporária")
    a.add_argument("--login", required=True)
    a.add_argument("--nome", required=True)
    args = ap.parse_args()
    from psycopg import connect
    with connect(DSN, row_factory=dict_row) as c:
        c.execute((Path(__file__).parent / "schema.sql").read_text())
        temp = senha_temporaria()
        lg = args.login.strip().lower()
        c.execute("""insert into whouse.usuarios(login, nome, email, papel, master, senha_hash, trocar_senha, criado_por)
                     values (%s,%s,%s,'ADMIN',%s,%s,true,'cli')
                     on conflict (lower(login)) do update set papel = 'ADMIN', ativo = true, senha_hash = excluded.senha_hash,
                       trocar_senha = true, falhas = 0, bloqueado_ate = null, master = excluded.master""",
                  (lg, args.nome, lg if "@" in lg else None, lg == MASTER, hash_senha(temp)))
        c.execute("delete from whouse.sessoes where usuario_id = (select id from whouse.usuarios where lower(login) = %s)", (lg,))
    print(f"login: {lg}\nsenha temporária: {temp}\n(troca obrigatória no primeiro acesso)")


if __name__ == "__main__":
    cli()
