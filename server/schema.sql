-- GPlanSiS|WHOUSE — esquema do servidor (PostgreSQL 16+). Idempotente.
-- Estado operacional: um documento versionado (controle otimista por versão),
-- com histórico para restauração. Usuários, sessões e registro de acessos à parte.
create schema if not exists whouse;
set search_path = whouse;

create table if not exists usuarios (
  id            bigserial primary key,
  login         text not null,
  nome          text not null,
  email         text,
  papel         text not null check (papel in ('ADMIN','GESTOR','OPERADOR','CONSULTA')),
  modulos       text[],                         -- null = padrão do papel
  ativo         boolean not null default true,
  master        boolean not null default false, -- administrador master: não rebaixa, não desativa
  senha_hash    text not null,
  trocar_senha  boolean not null default true,
  falhas        int not null default 0,
  bloqueado_ate timestamptz,
  criado_em     timestamptz not null default now(),
  criado_por    text,
  atualizado_em timestamptz not null default now(),
  ultimo_login  timestamptz,
  constraint master_e_admin check (not master or (papel = 'ADMIN' and ativo))
);
create unique index if not exists usuarios_login_uk on usuarios (lower(login));

create table if not exists sessoes (
  token_hash  text primary key,
  usuario_id  bigint not null references usuarios(id) on delete cascade,
  criado_em   timestamptz not null default now(),
  expira_em   timestamptz not null,
  ultimo_uso  timestamptz not null default now(),
  ip          text,
  ua          text
);
create index if not exists sessoes_usuario_ix on sessoes (usuario_id);

create table if not exists estado (
  id             smallint primary key check (id = 1),
  versao         bigint not null,
  doc            jsonb not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por text
);

create table if not exists estado_hist (
  versao         bigint primary key,
  doc            jsonb not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por text,
  bytes          int
);

create table if not exists acessos (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  usuario_id bigint,
  login      text,
  evento     text not null,
  ip         text,
  ua         text,
  detalhe    text
);
create index if not exists acessos_ts_ix on acessos (ts desc);

-- IA: cota mensal por pessoa (US$) e registro do uso real de tokens. Idempotente.
create table if not exists config (
  chave         text primary key,
  valor         text not null,
  atualizado_em timestamptz not null default now()
);
alter table usuarios add column if not exists ia_cota numeric(10,2);   -- null = cota padrão (config 'ia.cota_usd')

create table if not exists ia_uso (
  id            bigserial primary key,
  ts            timestamptz not null default now(),
  usuario_id    bigint references usuarios(id) on delete set null,
  recurso       text not null,
  modelo        text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cache_read    int not null default 0,
  cache_write   int not null default 0,
  custo_usd     numeric(12,6) not null default 0,
  ok            boolean not null,
  erro          text,
  ms            int
);
create index if not exists ia_uso_usuario_ts_ix on ia_uso (usuario_id, ts);
