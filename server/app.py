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
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
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
    return (req.headers.get("x-forwarded-for", "").split(",")[0].strip() or (req.client.host if req.client else ""))


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
        if u and u["bloqueado_ate"] and u["bloqueado_ate"] > datetime.now(timezone.utc):
            registra(cur, "LOGIN_BLOQUEADO", request, u)
            c.commit()
            raise HTTPException(423, "Usuário bloqueado temporariamente por tentativas inválidas — aguarde ou peça desbloqueio ao administrador")
        if not u or not u["ativo"] or not confere_senha(body.senha, u["senha_hash"]):
            q.append(agora)
            if u:
                cur.execute("""update whouse.usuarios set falhas = falhas + 1,
                               bloqueado_ate = case when falhas + 1 >= 5 then now() + interval '15 minutes' else bloqueado_ate end
                               where id = %s""", (u["id"],))
            registra(cur, "LOGIN_FALHA", request, u, login=lg)
            c.commit()
            time.sleep(0.4)
            raise HTTPException(401, "Login ou senha inválidos")
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
class IAReq(BaseModel):
    system: str = Field(max_length=20000)
    messages: list[dict]
    tools: list[dict] | None = None
    max_tokens: int = 1500


@app.post("/api/ia/mensagens")
async def ia(body: IAReq, u: dict = Depends(usuario_atual)):
    if not IA_KEY:
        raise HTTPException(503, "IA não configurada no servidor (ANTHROPIC_API_KEY)")
    if len(json.dumps(body.messages)) > 400_000:
        raise HTTPException(413, "Conversa longa demais — limpe o histórico")
    payload = {"model": IA_MODELO, "max_tokens": min(max(body.max_tokens, 100), 4000), "system": body.system,
               "messages": body.messages[-40:]}
    if body.tools:
        payload["tools"] = body.tools[:20]
    async with httpx.AsyncClient(timeout=120) as cli:
        r = await cli.post("https://api.anthropic.com/v1/messages", json=payload,
                           headers={"x-api-key": IA_KEY, "anthropic-version": "2023-06-01"})
    if r.status_code >= 400:
        raise HTTPException(502, f"IA respondeu {r.status_code}: {r.text[:300]}")
    return r.json()


# ---------------------------------------------------------------- webhook (conector REST genérico)
class EnvioWebhook(BaseModel):
    url: str = Field(max_length=500)
    idem: str = Field(max_length=200)
    payload: dict


def destino_publico(url: str) -> None:
    p = urlparse(url)
    if p.scheme != "https" or not p.hostname:
        raise HTTPException(422, "O webhook exige URL https://")
    try:
        ips = {ai[4][0] for ai in socket.getaddrinfo(p.hostname, p.port or 443)}
    except socket.gaierror:
        raise HTTPException(422, f"Host {p.hostname} não resolve")
    for ip in ips:
        a = ipaddress.ip_address(ip)
        if a.is_private or a.is_loopback or a.is_link_local or a.is_reserved or a.is_multicast:
            raise HTTPException(422, "Destino em rede interna não é permitido")


@app.post("/api/integracao/webhook")
async def webhook(body: EnvioWebhook, u: dict = Depends(exige_escrita)):
    if u["papel"] not in ("ADMIN", "GESTOR"):
        raise HTTPException(403, "Envio de integração exige GESTOR ou ADMIN")
    if not WEBHOOK_SEGREDO:
        raise HTTPException(503, "Segredo HMAC do webhook não configurado no servidor (WHOUSE_WEBHOOK_SEGREDO)")
    destino_publico(body.url)
    dado = json.dumps(body.payload, ensure_ascii=False, separators=(",", ":")).encode()
    ts = str(int(time.time()))
    sig = hmac.new(WEBHOOK_SEGREDO.encode(), ts.encode() + b"." + dado, hashlib.sha256).hexdigest()
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as cli:
            r = await cli.post(body.url, content=dado, headers={
                "Content-Type": "application/json", "Idempotency-Key": body.idem,
                "X-WHOUSE-Timestamp": ts, "X-WHOUSE-Signature": "sha256=" + sig, "User-Agent": "GPlanSiS-WHOUSE/1"})
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
