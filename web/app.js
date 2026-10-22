'use strict';
/* =====================================================================
   GPlanSiS|WHOUSE — Almoxarifado, Depósitos, Picking, Lotes, Stock by Order
   Arquitetura: ledger de movimentos append-only (saldo = Σ movimentos),
   reservas derivadas de pickings abertos, outbox idempotente p/ ERPs.
   Invariantes: sem saldo negativo; lote em quarentena/bloqueado não sai;
   estoque de ordem só é consumido pela ordem dona; IA propõe, humano decide.
   ===================================================================== */
const KEY='gplansis_whouse_v1';
const $=(s,el=document)=>el.querySelector(s);
const $$=(s,el=document)=>[...el.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=3)=>Number(n||0).toLocaleString('pt-BR',{maximumFractionDigits:d});
const brl=n=>Number(n||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const pct=n=>(isFinite(n)?(n*100).toLocaleString('pt-BR',{maximumFractionDigits:1}):'—')+'%';
const r3=n=>Math.round((+n+Number.EPSILON)*1000)/1000;
const todayISO=()=>new Date().toISOString().slice(0,10);
const addDays=(iso,d)=>{const x=new Date(iso+'T12:00:00');x.setDate(x.getDate()+d);return x.toISOString().slice(0,10)};
const daysTo=iso=>iso?Math.round((new Date(iso+'T12:00:00')-new Date(todayISO()+'T12:00:00'))/864e5):null;
const dtBR=iso=>iso?iso.slice(0,10).split('-').reverse().join('/'):'—';
const tsBR=ts=>ts?new Date(ts).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const uid=p=>p+'-'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,5).toUpperCase();
/* parser numérico pt-BR que falha em ambiguidade */
function parseNum(v){
  if(typeof v==='number')return v;
  let s=String(v??'').trim().replace(/\s/g,'');
  if(s==='')return NaN;
  const hasC=s.includes(','),hasD=s.includes('.');
  if(hasC&&hasD){ if(s.lastIndexOf(',')>s.lastIndexOf('.')) s=s.replace(/\./g,'').replace(',','.'); else s=s.replace(/,/g,''); }
  else if(hasC){ s=s.replace(',','.'); }
  else if(hasD){ const p=s.split('.'); if(p.length>2) s=s.replace(/\./g,''); }
  const n=Number(s); return isFinite(n)?n:NaN;
}
function parseDate(v){
  if(!v)return '';
  if(v instanceof Date)return v.toISOString().slice(0,10);
  if(typeof v==='number'){const d=new Date(Math.round((v-25569)*864e5));return d.toISOString().slice(0,10)}
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(m)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return 'INVALID';
}

/* ---------- ÍCONES ---------- */
const I={
 dash:'<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
 rec:'<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M12 11v6M9 14l3 3 3-3"/>',
 stock:'<path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-8h10v8M7 17h10"/>',
 pick:'<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
 inv:'<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 13h6M9 17h4"/>',
 plan:'<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
 cad:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>',
 int:'<path d="M8 3v4M16 3v4M4 11h16M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
 io:'<path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
 scan:'<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 9v6M10 9v6M13 9v6M16 9v6"/>',
 audit:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 cfg:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
 ai:'<path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z"/>',
 plus:'<path d="M12 5v14M5 12h14"/>', x:'<path d="M18 6 6 18M6 6l12 12"/>',
 transfer:'<path d="M7 7h13l-3-3M17 17H4l3 3"/>', tag:'<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
 dl:'<path d="M12 3v12M8 11l4 4 4-4M4 19h16"/>', ul:'<path d="M12 21V9M8 13l4-4 4 4M4 5h16"/>',
 print:'<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/>',
 mob:'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
 lock:'<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
 play:'<path d="M6 4l14 8-14 8z"/>', users:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>', ref:'<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'
};
const ic=(k,sz)=>`<svg class="ico" viewBox="0 0 24 24" width="${sz||16}" height="${sz||16}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${sz?` style="width:${sz}px;height:${sz}px"`:''}>${I[k]||''}</svg>`;
const LOGO=(s=38)=>`<svg width="${s}" height="${s}" viewBox="0 0 64 64" role="img" aria-label="GPlanSiS|WHOUSE">
<path d="M32 2 58 17v30L32 62 6 47V17z" fill="#2D3336" stroke="#EB6A20" stroke-width="2.5"/>
<path d="M32 12 48 21 32 30 16 21z" fill="#F6A709"/>
<path d="M16 21 32 30v20L16 41z" fill="#EB6A20"/>
<path d="M48 21 32 30v20l16-9z" fill="#B84E12"/>
<path d="M16 27.7 32 36.7M16 34.3 32 43.3M48 27.7 32 36.7M48 34.3 32 43.3" stroke="#2D3336" stroke-width="1.6"/>
<path d="M24 16.5 40 25.5" stroke="#2D3336" stroke-width="1.4" opacity=".55"/>
</svg>`;

/* ---------- STORE ---------- */
let S=null;
const EMPTY=()=>({v:1,cfg:{empresa:'Minha Empresa Ltda',usuario:'Usuário',estrategia:'FEFO',inspecaoPadrao:true,contagemCega:true,toleranciaInv:0.02,diasVencAlerta:45,modo:'INDEPENDENTE',tema:''},
 depositos:[],enderecos:[],materiais:[],lotes:[],movs:[],ordens:[],pickings:[],recebimentos:[],inventarios:[],requisicoes:[],integracoes:[],outbox:[],audit:[],seq:{}});
function save(){if(API.on){srvSave();return}try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){toast('Falha ao persistir localmente: '+e.message,'bad')}}
function load(){try{const raw=localStorage.getItem(KEY);if(raw){S=JSON.parse(raw);return true}}catch(e){}return false}
function nextSeq(p){S.seq[p]=(S.seq[p]||0)+1;return `${p}-${new Date().getFullYear()}-${String(S.seq[p]).padStart(5,'0')}`}
function audit(acao,ent,ref,det){S.audit.unshift({id:uid('AU'),ts:Date.now(),user:userName(),acao,ent,ref,det:det||''});if(S.audit.length>3000)S.audit.length=3000}
const mat=c=>S.materiais.find(m=>m.codigo===c);
const dep=c=>S.depositos.find(d=>d.codigo===c);
const lot=(m,l)=>S.lotes.find(x=>x.material===m&&x.lote===l);
const ord=n=>S.ordens.find(o=>o.numero===n);
const endr=(d,e)=>S.enderecos.find(x=>x.deposito===d&&x.codigo===e);

/* ---------- SEED determinístico ---------- */
function lcg(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296}}
function seed(){
  S=EMPTY(); const R=lcg(20260926);
  S.depositos=[
    {codigo:'ALM01',nome:'Almoxarifado Central',tipo:'ALMOXARIFADO',erp:'01',ativo:true,resp:'Almoxarife A'},
    {codigo:'PRD01',nome:'Supermercado de Produção',tipo:'PRODUCAO',erp:'02',ativo:true,resp:'PCP'},
    {codigo:'QUA01',nome:'Quarentena / CQ',tipo:'QUARENTENA',erp:'98',ativo:true,resp:'Qualidade'},
    {codigo:'EXP01',nome:'Doca de Expedição',tipo:'EXPEDICAO',erp:'03',ativo:true,resp:'Logística'},
    {codigo:'TER01',nome:'Em Poder de Terceiros',tipo:'TERCEIROS',erp:'99',ativo:true,resp:'Suprimentos'}];
  const E=[];
  ['A','B','C'].forEach((rua,ri)=>{for(let p=1;p<=4;p++)for(let n=1;n<=3;n++)E.push({deposito:'ALM01',codigo:`${rua}-${String(p).padStart(2,'0')}-${n}`,tipo:n===1?'PICKING':'PULMAO',capacidade:n===1?200:600,ativo:true})});
  ['S1','S2','S3','S4'].forEach(c=>E.push({deposito:'PRD01',codigo:c,tipo:'PICKING',capacidade:150,ativo:true}));
  ['Q1','Q2'].forEach(c=>E.push({deposito:'QUA01',codigo:c,tipo:'QUARENTENA',capacidade:500,ativo:true}));
  ['DOCA1','DOCA2'].forEach(c=>E.push({deposito:'EXP01',codigo:c,tipo:'DOCA',capacidade:1000,ativo:true}));
  E.push({deposito:'TER01',codigo:'TERC',tipo:'BLOCADO',capacidade:9999,ativo:true});
  S.enderecos=E;
  const M=[
   ['MP-00101','Chapa aço carbono ASTM A36 3/16"','KG','Matéria-prima',0,0,18.9,800,1500,3000,'7208.52.00'],
   ['MP-00102','Tubo aço inox 304 Ø2" SCH10','M','Matéria-prima',1,0,142.5,60,120,300,'7306.40.00'],
   ['MP-00110','Tinta epóxi bicomponente cinza N6.5','L','Matéria-prima',1,1,96.4,40,80,200,'3208.90.10'],
   ['CS-00201','Eletrodo revestido E7018 Ø3,25mm','KG','Consumível',1,1,34.7,50,100,250,'8311.10.00'],
   ['CS-00202','Disco de corte 7" x 1/8"','UN','Consumível',0,0,9.8,100,200,600,'6804.22.19'],
   ['CS-00203','Óleo hidráulico ISO VG 68','L','Consumível',1,1,21.3,200,400,1000,'2710.19.32'],
   ['CS-00204','Graxa de lítio EP2','KG','Consumível',1,1,38.9,20,40,100,'2710.19.91'],
   ['EL-00301','Cabo PP 3x2,5mm² 750V','M','Elétrico',0,0,11.2,300,600,1500,'8544.49.00'],
   ['EL-00302','Contator tripolar 25A 24Vcc','UN','Elétrico',0,0,286.0,10,20,50,'8536.49.00'],
   ['EL-00303','Sensor indutivo M18 PNP NA','UN','Elétrico',0,0,164.9,8,16,40,'8536.50.90'],
   ['EL-00304','Disjuntor motor 6,3-10A','UN','Elétrico',0,0,398.0,5,10,25,'8536.20.00'],
   ['MC-00401','Rolamento rígido de esferas 6205-2RS','UN','Mecânico',0,0,42.6,30,60,150,'8482.10.10'],
   ['MC-00402','Correia em V A-48','UN','Mecânico',0,0,37.5,10,20,60,'4010.32.00'],
   ['MC-00403','Parafuso sext. M12x40 8.8 zincado','UN','Mecânico',0,0,1.35,500,1000,3000,'7318.15.00'],
   ['MC-00404','Elemento filtrante hidráulico 10µm','UN','Mecânico',1,0,215.0,6,12,30,'8421.29.90'],
   ['EP-00501','Luva nitrílica tam. G (par)','PR','EPI',1,1,6.4,100,200,600,'4015.19.00'],
   ['EP-00502','Óculos de segurança incolor','UN','EPI',0,0,12.9,30,60,150,'9004.90.20'],
   ['EP-00503','Protetor auricular plug silicone','PR','EPI',1,1,3.2,100,200,500,'3926.90.90']];
  S.materiais=M.map(r=>({codigo:r[0],descricao:r[1],um:r[2],grupo:r[3],controlaLote:!!r[4],controlaValidade:!!r[5],custo:r[6],minimo:r[7],pontoPedido:r[8],maximo:r[9],ncm:r[10],ean:'789'+String(Math.floor(R()*1e9)).padStart(9,'0'),leadTime:7+Math.floor(R()*14),ativo:true,abc:''}));
  S.ordens=[
   {numero:'OP-2026-0101',tipo:'OP',descricao:'Skid hidráulico HU-450',cliente:'Interno',status:'LIBERADA',entrega:addDays(todayISO(),12),itens:[{material:'MP-00101',qtd:420},{material:'CS-00201',qtd:35},{material:'CS-00203',qtd:180},{material:'MC-00404',qtd:4},{material:'EL-00303',qtd:6}]},
   {numero:'PRJ-2026-017',tipo:'PROJETO',descricao:'Painel CCM — Retrofit Linha 3',cliente:'Cliente Industrial SA',status:'LIBERADA',entrega:addDays(todayISO(),25),itens:[{material:'EL-00301',qtd:350},{material:'EL-00302',qtd:12},{material:'EL-00304',qtd:6},{material:'EL-00303',qtd:10}]},
   {numero:'OS-2026-0344',tipo:'OS',descricao:'Manutenção preventiva prensa P-02',cliente:'Manutenção',status:'LIBERADA',entrega:addDays(todayISO(),3),itens:[{material:'MC-00401',qtd:8},{material:'MC-00402',qtd:4},{material:'CS-00204',qtd:3},{material:'CS-00203',qtd:40}]},
   {numero:'OV-2026-0890',tipo:'OV',descricao:'Venda de peças de reposição',cliente:'Distribuidora Sul',status:'ABERTA',entrega:addDays(todayISO(),6),itens:[{material:'MC-00401',qtd:20},{material:'MC-00403',qtd:400}]}];
  // Lotes e movimentos históricos (90 dias)
  const addLot=(m,l,fab,val,forn,st)=>S.lotes.push({material:m,lote:l,fabricacao:fab,validade:val,fornecedor:forn,status:st||'LIBERADO',certificado:''});
  const fornec=['Aços Vale Ltda','Metalúrgica Norte','Distribuidora Técnica','Eletro Sul Com.','Química Industrial','Rolamentos Brasil'];
  const picks=E.filter(e=>e.deposito==='ALM01');
  let li=0;
  S.materiais.forEach((m,mi)=>{
    const base=m.maximo*(0.35+R()*0.5);
    const nLot=m.controlaLote?2+Math.floor(R()*2):1;
    for(let k=0;k<nLot;k++){
      const d0=addDays(todayISO(),-(80-k*25+Math.floor(R()*5)));
      let lote='',val='';
      if(m.controlaLote){lote=`L${d0.slice(2,4)}${d0.slice(5,7)}-${String(++li).padStart(3,'0')}`;val=m.controlaValidade?addDays(d0,k===0?(60+Math.floor(R()*40)):(200+Math.floor(R()*300))):'';addLot(m.codigo,lote,addDays(d0,-10),val,fornec[mi%fornec.length])}
      const e=picks[(mi*2+k)%picks.length];
      const q=r3(Math.round(base/nLot*(m.um==='UN'||m.um==='PR'?1:10))/(m.um==='UN'||m.um==='PR'?1:10));
      rawMov({ts:new Date(d0+'T09:00:00').getTime(),tipo:'ENTRADA',material:m.codigo,lote,deposito:'ALM01',endereco:e.codigo,qtd:q,custo:m.custo*(0.95+R()*0.1),tipoEstoque:'NORMAL',ordem:'',doc:'NF '+(10000+Math.floor(R()*9000)),obs:'Carga histórica'});
    }
  });
  // consumos diários
  for(let d=75;d>=1;d--){
    const day=addDays(todayISO(),-d);
    const n=2+Math.floor(R()*4);
    for(let j=0;j<n;j++){
      const m=S.materiais[Math.floor(R()*S.materiais.length)];
      const bal=balanceRows({material:m.codigo,deposito:'ALM01',tipoEstoque:'NORMAL'}).filter(b=>b.qtd>0);
      if(!bal.length)continue; const b=bal[0];
      const q=r3(Math.max(1,Math.min(b.qtd*0.12,m.maximo*0.03*(0.5+R()))));
      const qq=(m.um==='UN'||m.um==='PR')?Math.max(1,Math.round(q)):Math.round(q*10)/10;
      if(qq>b.qtd)continue;
      rawMov({ts:new Date(day+'T'+String(8+Math.floor(R()*9)).padStart(2,'0')+':15:00').getTime(),tipo:'SAIDA',material:m.codigo,lote:b.lote,deposito:'ALM01',endereco:b.endereco,qtd:-qq,custo:m.custo,tipoEstoque:'NORMAL',ordem:'',doc:'REQ-'+(5000+d*7+j),obs:'Consumo'});
    }
  }
  // stock by order já segregado para a OP e projeto
  const segr=(m,q,o)=>{const b=balanceRows({material:m,deposito:'ALM01',tipoEstoque:'NORMAL'}).filter(x=>x.qtd>=q)[0];if(!b)return;const doc='SEG-'+o;const ts=Date.now()-864e5*2;
    rawMov({ts,tipo:'RESERVA_ORDEM',material:m,lote:b.lote,deposito:'ALM01',endereco:b.endereco,qtd:-q,custo:mat(m).custo,tipoEstoque:'NORMAL',ordem:'',doc,obs:'Segregação p/ '+o});
    rawMov({ts,tipo:'RESERVA_ORDEM',material:m,lote:b.lote,deposito:'ALM01',endereco:b.endereco,qtd:q,custo:mat(m).custo,tipoEstoque:'ORDEM',ordem:o,doc,obs:'Segregação p/ '+o});};
  segr('EL-00301',200,'PRJ-2026-017'); segr('EL-00302',8,'PRJ-2026-017'); segr('MC-00404',4,'OP-2026-0101');
  // um lote em quarentena recém recebido
  const qm='CS-00203', ql='L'+todayISO().slice(2,4)+todayISO().slice(5,7)+'-Q01';
  addLot(qm,ql,addDays(todayISO(),-20),addDays(todayISO(),340),'Química Industrial','QUARENTENA');
  rawMov({ts:Date.now()-864e5,tipo:'ENTRADA',material:qm,lote:ql,deposito:'QUA01',endereco:'Q1',qtd:400,custo:21.9,tipoEstoque:'NORMAL',ordem:'',doc:'NF 23981',obs:'Recebimento aguardando CQ'});
  S.recebimentos=[{numero:'RC-2026-00001',fornecedor:'Química Industrial',nf:'23981',pedido:'PC-4410',data:todayISO(),status:'EM_INSPECAO',itens:[{material:qm,lote:ql,validade:addDays(todayISO(),340),qtdNF:400,qtdConf:400,deposito:'ALM01',endereco:'B-02-2',custo:21.9,cq:'PENDENTE'}]}];
  S.seq={RC:1};
  S.integracoes=CONNECTORS.map(c=>({id:c.id,ativo:c.id==='sapb1',ambiente:'HOMOLOGACAO',url:c.urlEx,empresa:c.id==='sapb1'?'SBO_EMPRESA_HML':'',usuario:'',modo:'OUTBOX',entidades:['MOVIMENTOS','SALDOS','MATERIAIS'],mapa:JSON.parse(JSON.stringify(c.mapa)),ultimoSync:null}));
  calcABC(); audit('SEED','SISTEMA','—','Base de demonstração gerada');
  save();
}

/* ---------- LEDGER / SALDOS ---------- */
let BAL=null; // cache
function rawMov(m){m.id=m.id||uid('MV');m.user=m.user||userName();S.movs.push(m);BAL=null}
function balKey(m){return [m.material,m.lote||'',m.deposito,m.endereco||'',m.tipoEstoque||'NORMAL',m.ordem||''].join('|')}
function balances(){
  if(BAL)return BAL; const map=new Map();
  for(const m of S.movs){const k=balKey(m);map.set(k,r3((map.get(k)||0)+m.qtd))}
  BAL=map; return map;
}
function balanceRows(f={}){
  const out=[];
  for(const [k,q] of balances()){
    if(Math.abs(q)<1e-9)continue;
    const [material,lote,deposito,endereco,tipoEstoque,ordem]=k.split('|');
    if(f.material&&f.material!==material)continue; if(f.deposito&&f.deposito!==deposito)continue;
    if(f.tipoEstoque&&f.tipoEstoque!==tipoEstoque)continue; if(f.lote!==undefined&&f.lote!==lote)continue;
    if(f.ordem!==undefined&&f.ordem!==ordem)continue; if(f.endereco&&f.endereco!==endereco)continue;
    out.push({material,lote,deposito,endereco,tipoEstoque,ordem,qtd:q,key:k});
  }
  return out;
}
/* reservas: alocações de pickings não finalizados */
function reservedMap(){
  const r=new Map();
  S.pickings.filter(p=>['ABERTO','EM_SEPARACAO'].includes(p.status)).forEach(p=>p.linhas.forEach(l=>l.aloc.forEach(a=>{
    const k=[l.material,a.lote||'',a.deposito,a.endereco||'',a.tipoEstoque,a.ordem||''].join('|');
    r.set(k,r3((r.get(k)||0)+(a.qtd-(a.sep||0))));
  })));
  return r;
}
function saldoMat(code,{deposito,tipoEstoque,excluirBloq}={}){
  let t=0; for(const b of balanceRows({material:code,deposito,tipoEstoque})){ if(excluirBloq&&b.lote){const L=lot(code,b.lote);if(L&&L.status!=='LIBERADO')continue} if(excluirBloq&&dep(b.deposito)?.tipo==='QUARENTENA')continue; t+=b.qtd } return r3(t);
}
function disponivel(code){const res=reservedMap();let t=0;for(const b of balanceRows({material:code,tipoEstoque:'NORMAL'})){const L=b.lote?lot(code,b.lote):null;if(L&&L.status!=='LIBERADO')continue;if(['QUARENTENA','EXPEDICAO','TERCEIROS'].includes(dep(b.deposito)?.tipo))continue;t+=b.qtd-(res.get(b.key)||0)}return r3(t)}
function valorEstoque(){let v=0;for(const b of balanceRows()){v+=b.qtd*(mat(b.material)?.custo||0)}return v}

class BizError extends Error{}
/* Posta um documento (lista de movimentos) atomicamente após validar invariantes */
function postDoc(movs,{doc,tipoDoc,obs}={}){
  const res=reservedMap(); const delta=new Map();
  for(const m of movs){
    const M=mat(m.material); if(!M)throw new BizError(`Material ${m.material} inexistente`);
    if(!dep(m.deposito))throw new BizError(`Depósito ${m.deposito} inexistente`);
    if(m.endereco&&!endr(m.deposito,m.endereco))throw new BizError(`Endereço ${m.deposito}/${m.endereco} inexistente`);
    if(!(Math.abs(m.qtd)>0))throw new BizError(`Quantidade inválida para ${m.material}`);
    if(M.controlaLote&&!m.lote)throw new BizError(`${m.material} controla lote — informe o lote`);
    if(m.lote&&!lot(m.material,m.lote))throw new BizError(`Lote ${m.lote} não cadastrado para ${m.material}`);
    if((m.tipoEstoque||'NORMAL')==='ORDEM'&&!m.ordem)throw new BizError(`Estoque por ordem exige número da ordem`);
    if(m.qtd<0&&m.lote&&!m.ignoraStatusLote){const L=lot(m.material,m.lote);if(L.status!=='LIBERADO'&&!['TRANSFERENCIA','LIBERACAO_CQ','AJUSTE','REJEICAO'].includes(m.tipo))throw new BizError(`Lote ${m.lote} está ${L.status} — saída bloqueada`)}
    const k=balKey(m); delta.set(k,r3((delta.get(k)||0)+m.qtd));
  }
  const bal=balances();
  for(const [k,d] of delta){ if(d>=0)continue; const after=r3((bal.get(k)||0)+d); const reserved=res.get(k)||0;
    if(after<-1e-9){const [mm,ll,dd,ee]=k.split('|');throw new BizError(`Saldo insuficiente: ${mm} ${ll?'lote '+ll:''} em ${dd}/${ee||'—'} (saldo ${fmt(bal.get(k)||0)}, pedido ${fmt(-d)}). Saldo negativo é proibido.`)}
    if(after<reserved-1e-9&&!movs.some(m=>m._fromPicking)){const [mm]=k.split('|');throw new BizError(`${mm}: quantidade comprometida em picking (${fmt(reserved)}) — libere o picking antes`)}
  }
  const ts=Date.now(); doc=doc||uid('DOC');
  movs.forEach(m=>{
    // custo médio ponderado em entradas externas
    const M=mat(m.material);
    if(m.tipo==='ENTRADA'&&m.custo>0){const tot=saldoMat(m.material);const nv=(tot*M.custo+m.qtd*m.custo)/Math.max(tot+m.qtd,1e-9);M.custo=Math.round(nv*10000)/10000}
    rawMov({ts,tipo:m.tipo,material:m.material,lote:m.lote||'',deposito:m.deposito,endereco:m.endereco||'',qtd:r3(m.qtd),custo:m.custo??M.custo,tipoEstoque:m.tipoEstoque||'NORMAL',ordem:m.ordem||'',doc,obs:m.obs||obs||''});
  });
  audit('POST',tipoDoc||'MOVIMENTO',doc,`${movs.length} linha(s)`);
  enqueueOutbox(tipoDoc||movs[0].tipo,doc,movs);
  save(); return doc;
}
function transferMovs(o){ // {material,lote,de:{dep,end,tipoEstoque,ordem},para:{...},qtd,tipo}
  return [{tipo:o.tipo||'TRANSFERENCIA',material:o.material,lote:o.lote,deposito:o.de.dep,endereco:o.de.end,tipoEstoque:o.de.tipoEstoque||'NORMAL',ordem:o.de.ordem||'',qtd:-o.qtd,obs:o.obs,_fromPicking:o._fromPicking},
          {tipo:o.tipo||'TRANSFERENCIA',material:o.material,lote:o.lote,deposito:o.para.dep,endereco:o.para.end,tipoEstoque:o.para.tipoEstoque||'NORMAL',ordem:o.para.ordem||'',qtd:o.qtd,obs:o.obs,_fromPicking:o._fromPicking}];
}

/* ---------- ANALYTICS ---------- */
function consumo(code,dias=60){const lim=Date.now()-dias*864e5;let t=0;const byDay={};for(const m of S.movs){if(m.material!==code||m.ts<lim)continue;if(['SAIDA','PICKING'].includes(m.tipo)&&m.qtd<0){t+=-m.qtd;const d=new Date(m.ts).toISOString().slice(0,10);byDay[d]=(byDay[d]||0)-m.qtd}}return{total:t,media:t/dias,byDay}}
function calcABC(){
  const arr=S.materiais.map(m=>({m,v:consumo(m.codigo,90).total*m.custo})).sort((a,b)=>b.v-a.v);
  const tot=arr.reduce((s,x)=>s+x.v,0)||1;let acc=0;
  arr.forEach(x=>{acc+=x.v;const p=acc/tot;x.m.abc=p<=0.8?'A':p<=0.95?'B':'C'});
}
function xyz(code){const c=consumo(code,60);const days=[];for(let i=60;i>=1;i--){days.push(c.byDay[addDays(todayISO(),-i)]||0)}const mu=days.reduce((a,b)=>a+b,0)/days.length;if(mu===0)return{cls:'Z',cv:Infinity};const sd=Math.sqrt(days.reduce((a,b)=>a+(b-mu)**2,0)/days.length);const cv=sd/mu;return{cls:cv<0.5?'X':cv<1?'Y':'Z',cv}}
function reposicao(){
  return S.materiais.filter(m=>m.ativo).map(m=>{
    const saldo=saldoMat(m.codigo,{excluirBloq:true}); const disp=disponivel(m.codigo); const c=consumo(m.codigo,60);
    const cob=c.media>0?disp/c.media:Infinity; const ordNec=S.ordens.filter(o=>!['ENCERRADA','CANCELADA'].includes(o.status)).reduce((s,o)=>s+(o.itens.find(i=>i.material===m.codigo)?.qtd||0),0);
    const ordSeg=saldoMat(m.codigo,{tipoEstoque:'ORDEM'});
    const necLiq=Math.max(0,ordNec-ordSeg);
    const pp=Math.max(m.pontoPedido,Math.ceil(c.media*m.leadTime*1.3));
    const abaixo=disp-necLiq<=pp;
    const sug=abaixo?Math.max(0,Math.ceil(m.maximo-(disp-necLiq))):0;
    const req=S.requisicoes.find(r=>r.material===m.codigo&&['PROPOSTA','APROVADA','ENVIADA'].includes(r.status));
    return{m,saldo,disp,media:c.media,cob,ordNec,ordSeg,necLiq,pp,abaixo,sug,xyz:xyz(m.codigo),req,crit:disp<m.minimo?'RUPTURA':abaixo?'REPOR':'OK'};
  });
}
function lotesVencendo(dias){return S.lotes.filter(l=>l.validade&&daysTo(l.validade)<=dias&&saldoMat(l.material,{})>0&&balanceRows({material:l.material,lote:l.lote}).reduce((s,b)=>s+b.qtd,0)>0).map(l=>({...l,dias:daysTo(l.validade),qtd:balanceRows({material:l.material,lote:l.lote}).reduce((s,b)=>s+b.qtd,0)})).sort((a,b)=>a.dias-b.dias)}
function ocupacao(){const m=new Map();for(const b of balanceRows()){if(!b.endereco)continue;const k=b.deposito+'|'+b.endereco;m.set(k,(m.get(k)||0)+b.qtd)}return m}
function acuracidade(){const f=S.inventarios.filter(i=>i.status==='APROVADO');let tot=0,ok=0;f.forEach(i=>i.linhas.forEach(l=>{if(l.contado==null)return;tot++;const dv=l.sistema?Math.abs(l.contado-l.sistema)/l.sistema:(l.contado?1:0);if(dv<=S.cfg.toleranciaInv)ok++}));return tot?ok/tot:null}

/* ---------- CONECTORES ERP ----------
   O navegador não fala direto com o ERP (CSP + credencial). Arquitetura: WHOUSE → outbox →
   gateway (FastAPI/worker) → ERP. Contratos marcados "a confirmar" são hipótese até validação na instância real. */
const CONNECTORS=[
 {id:'sapb1',nome:'SAP Business One (HANA)',cor:'#0A6ED1',sig:'B1',proto:'Service Layer REST (OData v4)',urlEx:'https://hana-srv:50000/b1s/v2',confirmado:true,
  endpoints:{login:'POST /Login {CompanyDB,UserName,Password}',ENTRADA:'POST /InventoryGenEntries',SAIDA:'POST /InventoryGenExits',TRANSFERENCIA:'POST /StockTransfers',MATERIAIS:'GET /Items?$select=ItemCode,ItemName,InventoryUOM,ManageBatchNumbers',SALDOS:'GET /Items(\'{code}\')?$select=ItemWarehouseInfoCollection'},
  mapa:[['material','ItemCode'],['descricao','ItemName'],['um','InventoryUOM'],['deposito','WarehouseCode'],['qtd','Quantity'],['lote','BatchNumbers[].BatchNumber'],['validade','BatchNumbers[].ExpiryDate'],['doc','Reference2'],['ordem','U_GPS_ORDEM (UDF)']]},
 {id:'totvs',nome:'TOTVS Protheus',cor:'#1B2A4E',sig:'TP',proto:'REST TLPP / API customizada (SD3)',urlEx:'https://protheus-srv:8181/rest',confirmado:false,
  endpoints:{ENTRADA:'POST /api/estoque/v1/movimentos (MATA240 · TM entrada) — a confirmar',SAIDA:'POST /api/estoque/v1/movimentos (MATA240 · TM saída) — a confirmar',TRANSFERENCIA:'POST /api/estoque/v1/transferencias (MATA261) — a confirmar',MATERIAIS:'GET /api/estoque/v1/produtos (SB1) — a confirmar',SALDOS:'GET /api/estoque/v1/saldos (SB2/SB8) — a confirmar'},
  mapa:[['material','D3_COD / B1_COD'],['descricao','B1_DESC'],['um','D3_UM'],['deposito','D3_LOCAL'],['qtd','D3_QUANT'],['lote','D3_LOTECTL'],['validade','D3_DTVALID'],['doc','D3_DOC'],['ordem','D3_OP']]},
 {id:'senior',nome:'Senior Sistemas (ERP / X)',cor:'#00A650',sig:'SR',proto:'Web Services Senior (SOAP/REST) — módulo Estoques',urlEx:'https://senior-srv/g5-senior-services',confirmado:false,
  endpoints:{ENTRADA:'WS de movimentação de estoque (entrada) — contrato a confirmar',SAIDA:'WS de movimentação de estoque (saída) — a confirmar',TRANSFERENCIA:'WS de transferência entre depósitos — a confirmar',MATERIAIS:'Consulta de produtos — a confirmar',SALDOS:'Consulta de saldos por depósito — a confirmar'},
  mapa:[['material','codPro'],['descricao','desPro'],['um','uniMed'],['deposito','codDep'],['qtd','qtdMov'],['lote','codLot'],['validade','datVlt'],['doc','numDoc'],['ordem','numOrp']]},
 {id:'sankhya',nome:'Sankhya',cor:'#E30613',sig:'SK',proto:'Sankhya-W Service API (JSON)',urlEx:'https://sankhya-srv/mge/service.sbr',confirmado:false,
  endpoints:{ENTRADA:'CACSP.incluirNota (TOP de entrada) — a confirmar',SAIDA:'CACSP.incluirNota (TOP de requisição) — a confirmar',TRANSFERENCIA:'CACSP.incluirNota (TOP de transferência) — a confirmar',MATERIAIS:'CRUDServiceProvider.loadRecords (Produto) — a confirmar',SALDOS:'CRUDServiceProvider.loadRecords (Estoque) — a confirmar'},
  mapa:[['material','CODPROD'],['descricao','DESCRPROD'],['um','CODVOL'],['deposito','CODLOCAL'],['qtd','QTDNEG'],['lote','CONTROLE'],['validade','DTVAL'],['doc','NUMNOTA'],['ordem','AD_ORDEM']]},
 {id:'odoo',nome:'Odoo',cor:'#714B67',sig:'OD',proto:'JSON-RPC / XML-RPC (stock.picking, stock.quant)',urlEx:'https://odoo-srv/jsonrpc',confirmado:true,
  endpoints:{ENTRADA:'stock.picking (incoming) create + button_validate',SAIDA:'stock.picking (outgoing) create + button_validate',TRANSFERENCIA:'stock.picking (internal)',MATERIAIS:'product.product search_read',SALDOS:'stock.quant search_read'},
  mapa:[['material','default_code'],['descricao','name'],['um','uom_id'],['deposito','location_id'],['qtd','quantity'],['lote','lot_id.name'],['validade','lot_id.expiration_date'],['doc','origin'],['ordem','origin']]},
 {id:'rest',nome:'REST / Webhook genérico',cor:'#2D3336',sig:'{ }',proto:'JSON sobre HTTPS com HMAC',urlEx:'https://api.suaempresa.com/whouse',confirmado:true,
  endpoints:{ENTRADA:'POST /events (type=stock.entry)',SAIDA:'POST /events (type=stock.exit)',TRANSFERENCIA:'POST /events (type=stock.transfer)',MATERIAIS:'GET /items',SALDOS:'GET /balances'},
  mapa:[['material','sku'],['descricao','name'],['um','uom'],['deposito','warehouse'],['qtd','quantity'],['lote','batch'],['validade','expiry'],['doc','document'],['ordem','orderRef']]},
 {id:'file',nome:'Arquivo (CSV/XLSX · SFTP)',cor:'#7D8286',sig:'CSV',proto:'Troca por arquivo — layout WHOUSE',urlEx:'sftp://ftp.suaempresa.com/whouse',confirmado:true,
  endpoints:{ENTRADA:'Arquivo MOV_*.csv',SAIDA:'Arquivo MOV_*.csv',TRANSFERENCIA:'Arquivo MOV_*.csv',MATERIAIS:'Arquivo MAT_*.csv',SALDOS:'Arquivo SLD_*.csv'},
  mapa:[['material','material'],['descricao','descricao'],['um','um'],['deposito','deposito'],['qtd','qtd'],['lote','lote'],['validade','validade'],['doc','doc'],['ordem','ordem']]}
];
const conn=id=>CONNECTORS.find(c=>c.id===id);
function kindOf(tipo){return /ENTRADA|RECEB/.test(tipo)?'ENTRADA':/TRANSF|LIBERACAO|RESERVA|PICKING_TR/.test(tipo)?'TRANSFERENCIA':'SAIDA'}
function payloadFor(cid,kind,doc,movs){
  const depE=d=>dep(d)?.erp||d; const pos=movs.filter(m=>m.qtd>0), neg=movs.filter(m=>m.qtd<0);
  const lines=kind==='SAIDA'?neg:kind==='ENTRADA'?pos:pos;
  if(cid==='sapb1'){
    if(kind==='TRANSFERENCIA'){const from=neg[0];return{DocDate:todayISO(),FromWarehouse:depE(from?.deposito),ToWarehouse:depE(pos[0]?.deposito),Comments:`WHOUSE ${doc}`,StockTransferLines:pos.map((m,i)=>({ItemCode:m.material,Quantity:m.qtd,FromWarehouseCode:depE(neg[i]?.deposito),WarehouseCode:depE(m.deposito),...(m.lote?{BatchNumbers:[{BatchNumber:m.lote,Quantity:m.qtd}]}:{})}))}}
    return{DocDate:todayISO(),Reference2:doc,Comments:`WHOUSE ${doc}`,DocumentLines:lines.map(m=>({ItemCode:m.material,Quantity:Math.abs(m.qtd),WarehouseCode:depE(m.deposito),...(m.ordem?{U_GPS_ORDEM:m.ordem}:{}),...(m.lote?{BatchNumbers:[{BatchNumber:m.lote,Quantity:Math.abs(m.qtd),...(lot(m.material,m.lote)?.validade?{ExpiryDate:lot(m.material,m.lote).validade}:{})}]}:{})}))};
  }
  if(cid==='totvs'){return{operacao:kind,documento:doc,itens:lines.map(m=>({D3_TM:kind==='ENTRADA'?'001':kind==='SAIDA'?'501':'999',D3_COD:m.material,D3_QUANT:Math.abs(m.qtd),D3_LOCAL:depE(m.deposito),D3_LOTECTL:m.lote||'',D3_DTVALID:(lot(m.material,m.lote)?.validade||'').replace(/-/g,''),D3_EMISSAO:todayISO().replace(/-/g,''),D3_DOC:doc.slice(-9),D3_OP:m.ordem||''})),_aviso:'Layout hipotético — confirmar TMs e endpoint REST na instância do cliente'}}
  if(cid==='senior'){return{tipo:kind,numDoc:doc,movimentos:lines.map(m=>({codPro:m.material,codDep:depE(m.deposito),qtdMov:Math.abs(m.qtd),codLot:m.lote||'',datVlt:lot(m.material,m.lote)?.validade||'',numOrp:m.ordem||''})),_aviso:'Contrato a confirmar'}}
  if(cid==='sankhya'){return{serviceName:'CACSP.incluirNota',requestBody:{nota:{cabecalho:{TIPMOV:kind==='ENTRADA'?'C':kind==='SAIDA'?'Q':'T',NUMNOTA:doc},itens:{item:lines.map(m=>({CODPROD:m.material,QTDNEG:Math.abs(m.qtd),CODLOCALORIG:depE(m.deposito),CONTROLE:m.lote||' '}))}}},_aviso:'Contrato a confirmar'}}
  if(cid==='odoo'){return{model:'stock.picking',method:'create',args:[{origin:doc,picking_type_code:kind==='ENTRADA'?'incoming':kind==='SAIDA'?'outgoing':'internal',move_ids:lines.map(m=>({product:m.material,product_uom_qty:Math.abs(m.qtd),location:m.deposito,lot:m.lote||false}))}]}}
  return{event:`stock.${kind.toLowerCase()}`,document:doc,occurredAt:new Date().toISOString(),lines:lines.map(m=>({sku:m.material,warehouse:m.deposito,location:m.endereco,quantity:Math.abs(m.qtd),batch:m.lote||null,stockType:m.tipoEstoque,orderRef:m.ordem||null}))};
}
function enqueueOutbox(tipo,doc,movs){
  const kind=kindOf(tipo);
  S.integracoes.filter(i=>i.ativo&&i.entidades.includes('MOVIMENTOS')).forEach(i=>{
    const idem=`${i.id}:${kind}:${doc}`; // chave idempotente escopada por destino + tipo de mensagem
    if(S.outbox.some(o=>o.idem===idem))return;
    S.outbox.unshift({id:uid('OB'),idem,destino:i.id,kind,doc,ts:Date.now(),status:'PENDENTE',tentativas:0,payload:payloadFor(i.id,kind,doc,movs),log:[]});
  });
  if(S.outbox.length>2000)S.outbox.length=2000;
}
/* Worker simulado: no ambiente real, este papel é do gateway. Aqui processa a fila de forma determinística. */
async function processOutbox(ids){if(API.on)return processOutboxSrv(ids);
  let ok=0,fail=0;
  S.outbox.filter(o=>(ids?ids.includes(o.id):['PENDENTE','ERRO'].includes(o.status))).forEach(o=>{
    const i=S.integracoes.find(x=>x.id===o.destino); o.tentativas++;
    const problem=!i?.ativo?'Conector desativado':!i.url?'URL não configurada':(conn(o.destino).confirmado?null:'Contrato não confirmado na instância — mensagem retida para homologação');
    if(problem){o.status=o.tentativas>=3?'DLQ':'ERRO';o.log.push({ts:Date.now(),msg:problem});fail++;}
    else{o.status='ENVIADO';o.log.push({ts:Date.now(),msg:`SIMULAÇÃO (modo arquivo local, nada foi enviado): ${conn(o.destino).endpoints[o.kind]||(o.destino==='sapb1'?'POST /PurchaseRequests':'endpoint de requisição')} → 201 (modo ${i.ambiente})`});i.ultimoSync=Date.now();ok++;}
  });
  save(); return{ok,fail};
}

/* ---------- UI INFRA ---------- */
function toast(msg,type=''){const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;$('#toasts').appendChild(t);setTimeout(()=>t.remove(),type==='bad'?6500:3500)}
let drawerOnClose=null;
function openDrawer(title,body,foot='',{wide=false,onClose=null}={}){
  $('#dTitle').textContent=title;$('#dBody').innerHTML=body;$('#dFoot').innerHTML=foot;$('#dFoot').classList.toggle('hide',!foot);
  $('#drawer').classList.toggle('wide',wide);$('#drawer').classList.add('on');$('#scrim').classList.add('on');drawerOnClose=onClose;
  setTimeout(()=>{const f=$('#dBody input:not([type=hidden]):not([readonly]),#dBody select');f&&window.innerWidth>860&&f.focus()},220);
}
function closeDrawer(){$('#drawer').classList.remove('on');$('#scrim').classList.remove('on');setTimeout(srvFlushPending,50);if(drawerOnClose){const f=drawerOnClose;drawerOnClose=null;f()}}
let modalResolve=null;
function openModal(title,body,buttons=[{t:'Fechar',v:false}],{wide=false}={}){
  return new Promise(res=>{modalResolve=res;$('#mTitle').textContent=title;$('#mBody').innerHTML=body;
   $('#mFoot').innerHTML=buttons.map((b,i)=>`<button class="btn ${b.cls||''}" data-mv="${i}">${esc(b.t)}</button>`).join('');
   $$('#mFoot [data-mv]').forEach(btn=>btn.onclick=()=>{const b=buttons[+btn.dataset.mv];if(b.before&&b.before()===false)return;closeModal(b.v)});
   $('#modal').classList.toggle('wide',wide);$('#modal').classList.add('on');$('#mscrim').classList.add('on');});
}
function closeModal(v){$('#modal').classList.remove('on');$('#mscrim').classList.remove('on');setTimeout(srvFlushPending,50);stopCamera();if(modalResolve){const r=modalResolve;modalResolve=null;r(v)}}
$('#mscrim').onclick=()=>closeModal(false);
const confirmBox=(title,consequencia,okTxt='Confirmar',dan=false)=>openModal(title,`<p style="margin:0">${consequencia}</p>`,[{t:'Cancelar',v:false},{t:okTxt,v:true,cls:dan?'dan':'pri'}]);

function F(label,name,{type='text',value='',opts=null,req=false,full=false,ph='',step,readonly=false,help='',list=''}={}){
  let inp;
  if(opts){inp=`<select name="${name}" ${req?'required':''} ${readonly?'disabled':''}>${opts.map(o=>{const [v,t]=Array.isArray(o)?o:[o,o];return`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(t)}</option>`}).join('')}</select>`}
  else if(type==='textarea'){inp=`<textarea name="${name}" placeholder="${esc(ph)}">${esc(value)}</textarea>`}
  else if(type==='checkbox'){return`<div class="f ${full?'full':''}"><label class="chk" style="text-transform:none;font-size:13.5px;color:var(--ink)"><input type="checkbox" name="${name}" ${value?'checked':''} style="width:auto;min-height:0"> ${esc(label)}</label></div>`}
  else inp=`<input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" ${req?'required':''} ${step?`step="${step}"`:''} ${readonly?'readonly':''} ${list?`list="${list}"`:''} ${type==='number'?'inputmode="decimal"':''}>`;
  return`<div class="f ${full?'full':''}" data-f="${name}"><label>${esc(label)}${req?' *':''}</label>${inp}${help?`<div class="xs muted">${help}</div>`:''}<div class="err"></div></div>`;
}
function readForm(el){const o={};$$('[name]',el).forEach(i=>{if(i.type==='checkbox')o[i.name]=i.checked;else o[i.name]=i.value.trim()});return o}
function fieldErr(el,name,msg){const f=$(`[data-f="${name}"]`,el);if(f){f.classList.add('invalid');$('.err',f).textContent=msg}}
function clearErr(el){$$('.f.invalid',el).forEach(f=>{f.classList.remove('invalid');$('.err',f).textContent=''})}
const matOpts=(blank=true)=>[...(blank?[['','— selecione —']]:[]),...S.materiais.filter(m=>m.ativo).map(m=>[m.codigo,`${m.codigo} · ${m.descricao}`])];
const depOpts=(blank=true,filter)=>[...(blank?[['','— depósito —']]:[]),...S.depositos.filter(d=>d.ativo&&(!filter||filter(d))).map(d=>[d.codigo,`${d.codigo} · ${d.nome}`])];
const endOpts=d=>[['','— endereço —'],...S.enderecos.filter(e=>e.deposito===d&&e.ativo).map(e=>[e.codigo,`${e.codigo} (${e.tipo})`])];
const ordOpts=()=>[['','— ordem —'],...S.ordens.filter(o=>!['ENCERRADA','CANCELADA'].includes(o.status)).map(o=>[o.numero,`${o.numero} · ${o.descricao}`])];

/* Tabela genérica com ordenação, busca, paginação incremental */
const TST={};
function tbl(id,cols,rows,{onRow,search=true,foot,empty='Nenhum registro',limit=300,tools=''}={}){
  const st=TST[id]=TST[id]||{q:'',sort:null,dir:1,limit};
  st.cols=cols;st.rows=rows;st.onRow=onRow;st.foot=foot;st.empty=empty;
  return`<div class="toolbar">${search?`<input class="flt" data-tsearch="${id}" placeholder="Filtrar…" value="${esc(st.q)}">`:''}${tools}<span class="muted sm" id="tc-${id}" style="margin-left:auto"></span></div><div class="tw" id="tw-${id}">${tblBody(id)}</div>`;
}
function tblBody(id){
  const st=TST[id];let rows=st.rows;
  if(st.q){const q=st.q.toLowerCase();rows=rows.filter(r=>st.cols.some(c=>String(c.v?c.v(r):r[c.k]??'').toLowerCase().includes(q)))}
  if(st.sort!=null){const c=st.cols[st.sort];const g=r=>c.s?c.s(r):c.v?c.v(r):r[c.k];rows=[...rows].sort((a,b)=>{const x=g(a),y=g(b);return(typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??''),'pt-BR',{numeric:true}))*st.dir})}
  st.filtered=rows;
  setTimeout(()=>{const e=$('#tc-'+id);if(e)e.textContent=`${rows.length} registro(s)`},0);
  if(!rows.length)return`<div class="empty"><b>${esc(st.empty)}</b>Ajuste os filtros ou cadastre/importe dados.</div>`;
  const show=rows.slice(0,st.limit);
  return`<table class="t"><thead><tr>${st.cols.map((c,i)=>`<th class="${c.num?'num':''}" data-tsort="${id}:${i}">${esc(c.t)}${st.sort===i?(st.dir>0?' ▲':' ▼'):''}</th>`).join('')}</tr></thead><tbody>${show.map((r,ri)=>`<tr class="${st.onRow?'clk':''}" data-trow="${id}:${ri}">${st.cols.map(c=>`<td class="${c.num?'num':''} ${c.cls||''}">${c.h?c.h(r):esc(c.v?c.v(r):r[c.k]??'')}</td>`).join('')}</tr>`).join('')}</tbody>${st.foot?`<tfoot><tr>${st.foot(rows)}</tr></tfoot>`:''}</table>${rows.length>st.limit?`<div class="empty" style="padding:12px"><button class="btn sm" data-tmore="${id}">Mostrar mais ${Math.min(300,rows.length-st.limit)} de ${rows.length-st.limit}</button></div>`:''}`;
}
document.addEventListener('input',e=>{const id=e.target.dataset.tsearch;if(id){TST[id].q=e.target.value;TST[id].limit=300;$('#tw-'+id).innerHTML=tblBody(id)}});
document.addEventListener('click',e=>{
  const th=e.target.closest('[data-tsort]');if(th){const[id,i]=th.dataset.tsort.split(':');const st=TST[id];if(st.sort===+i)st.dir*=-1;else{st.sort=+i;st.dir=1}$('#tw-'+id).innerHTML=tblBody(id);return}
  const mo=e.target.closest('[data-tmore]');if(mo){const id=mo.dataset.tmore;TST[id].limit+=300;$('#tw-'+id).innerHTML=tblBody(id);return}
  const tr=e.target.closest('[data-trow]');if(tr&&!e.target.closest('button,a,input,select')){const[id,ri]=tr.dataset.trow.split(':');const st=TST[id];st.onRow&&st.onRow(st.filtered[+ri]);return}
});
const P=(t,c)=>`<span class="pill p-${c}">${esc(t)}</span>`;
const stPill=s=>P(s.replace(/_/g,' '),({LIBERADO:'ok',ENVIADO:'ok',SEPARADO:'info',EXPEDIDO:'ok',APROVADO:'ok',LANCADO:'ok',CONCLUIDO:'ok',ENCERRADA:'mut',LIBERADA:'ok',ABERTA:'info',ABERTO:'info',EM_SEPARACAO:'warn',EM_INSPECAO:'warn',EM_CONTAGEM:'warn',QUARENTENA:'warn',PENDENTE:'warn',PROPOSTA:'br',APROVADA:'info',CONFERIDO:'info',RASCUNHO:'mut',ERRO:'bad',DLQ:'bad',BLOQUEADO:'bad',REJEITADO:'bad',CANCELADO:'mut',CANCELADA:'mut',RUPTURA:'bad',REPOR:'warn',OK:'ok',EM_REVISAO:'warn'})[s]||'mut');
const tePill=(t,o)=>t==='ORDEM'?P('ORDEM '+(o||''),'ord'):P('NORMAL','mut');
const matLabel=c=>{const m=mat(c);return m?`<span class="ml" title="${esc(m.descricao)}"><span class="c">${esc(c)}</span><span class="d">${esc(m.descricao)}</span></span>`:`<span class="mono">${esc(c)}</span>`};

/* ---------- NAV / ROUTER ---------- */
const ROUTES=[
 {g:'Visão'},{id:'dashboard',t:'Painel',i:'dash'},
 {g:'Módulos'},
 {id:'recebimento',t:'Recebimento & CQ',i:'rec',md:'M1'},
 {id:'estoque',t:'Estoque & Endereços',i:'stock',md:'M2'},
 {id:'picking',t:'Picking & Expedição',i:'pick',md:'M3'},
 {id:'inventario',t:'Inventário & Kardex',i:'inv',md:'M4'},
 {id:'planejamento',t:'Planejamento & IA',i:'plan',md:'M5'},
 {g:'Plataforma'},
 {id:'cadastros',t:'Cadastros',i:'cad'},
 {id:'digital',t:'Digitalização',i:'scan'},
 {id:'integracoes',t:'Integrações ERP',i:'int'},
 {id:'dados',t:'Importar / Exportar',i:'io'},
 {id:'auditoria',t:'Auditoria',i:'audit'},
 {id:'config',t:'Configurações',i:'cfg'},
 {id:'usuarios',t:'Usuários & Acessos',i:'users'}];
let route='dashboard', sub={};
function renderNav(){
  const badge={recebimento:S.recebimentos.filter(r=>['RASCUNHO','CONFERIDO','EM_INSPECAO'].includes(r.status)).length,picking:S.pickings.filter(p=>['ABERTO','EM_SEPARACAO'].includes(p.status)).length,integracoes:S.outbox.filter(o=>['PENDENTE','ERRO','DLQ'].includes(o.status)).length};
  $('#nav').innerHTML=navRoutes().map(r=>r.g?`<div class="grp">${r.g}</div>`:`<a href="#/${r.id}" class="${route===r.id?'on':''}">${ic(r.i)}<span>${r.t}</span>${badge[r.id]?`<span class="mk">${badge[r.id]}</span>`:r.md?`<span class="md">${r.md}</span>`:''}</a>`).join('');
  $('#bottomnav').innerHTML=[['dashboard','Painel','dash'],['estoque','Estoque','stock'],['digital','Coletor','scan'],['picking','Picking','pick'],['planejamento','IA','plan']].filter(([id])=>allowed(id)).map(([id,t,i])=>`<a href="#/${id}" class="${route===id?'on':''}">${ic(i)}<span>${t}</span></a>`).join('');
  const pend=S.outbox.filter(o=>o.status==='PENDENTE').length, err=S.outbox.filter(o=>['ERRO','DLQ'].includes(o.status)).length;
  $('#syncState').innerHTML=`<span class="dot" style="background:${err?'#F06A5E':pend?'#F6A709':'#4CC37E'}"></span> ${err?err+' falha(s) sync':pend?pend+' na fila':'Sincronizado'}`;
  $('#modeState').innerHTML=S.cfg.modo==='INDEPENDENTE'?'Modo: <b style="color:#F6A709">Independente</b> (WHOUSE é o mestre)':'Modo: <b style="color:#7DB3F0">Integrado</b> (ERP é o mestre)';
}
function go(){const h=location.hash.replace(/^#\/?/,'')||'dashboard';const[r,...rest]=h.split('/');route=ROUTES.find(x=>x.id===r)&&allowed(r)?r:'dashboard';render();$('#side').classList.remove('on')}
window.addEventListener('hashchange',go);
function render(){
  const R=ROUTES.find(x=>x.id===route);$('#title').textContent=R.t;$('#crumb').textContent=R.md?`Módulo ${R.md.slice(1)} de 5`:'GPlanSiS|WHOUSE';
  renderNav();
  try{$('#view').innerHTML=(VIEWS[route]||VIEWS.dashboard)();VIEWS['after_'+route]&&VIEWS['after_'+route]()}catch(e){console.error(e);$('#view').innerHTML=`<div class="card"><div class="bd"><b>Erro ao renderizar:</b> ${esc(e.message)}</div></div>`}
}
const tabs=(key,list)=>{const cur=sub[key]||list[0][0];return`<div class="tabs">${list.map(([k,t])=>`<button class="${cur===k?'on':''}" data-act="tab" data-k="${key}" data-v="${k}">${t}</button>`).join('')}</div>`};
const curTab=(key,def)=>sub[key]||def;

const VIEWS={};
/* ---------- DASHBOARD ---------- */
VIEWS.dashboard=()=>{
  const rep=reposicao(); const rupt=rep.filter(r=>r.crit==='RUPTURA'), repor=rep.filter(r=>r.crit==='REPOR');
  const venc=lotesVencendo(S.cfg.diasVencAlerta); const vencidos=venc.filter(l=>l.dias<0);
  const pk=S.pickings.filter(p=>['ABERTO','EM_SEPARACAO'].includes(p.status));
  const ocup=ocupacao(); const ends=S.enderecos.filter(e=>e.ativo); const usados=ends.filter(e=>(ocup.get(e.deposito+'|'+e.codigo)||0)>0).length;
  const acc=acuracidade(); const vOrd=balanceRows({tipoEstoque:'ORDEM'}).reduce((s,b)=>s+b.qtd*(mat(b.material)?.custo||0),0);
  const quar=balanceRows().filter(b=>dep(b.deposito)?.tipo==='QUARENTENA').length;
  // movimentações 30 dias
  const days=[];for(let i=29;i>=0;i--)days.push(addDays(todayISO(),-i));
  const agg=Object.fromEntries(days.map(d=>[d,{e:0,s:0}]));const lim=new Date(days[0]+'T00:00:00').getTime();
  S.movs.forEach(m=>{if(m.ts<lim)return;const d=new Date(m.ts).toISOString().slice(0,10);if(!agg[d])return;const v=Math.abs(m.qtd*(m.custo||0));if(m.tipo==='ENTRADA')agg[d].e+=v;else if(['SAIDA','PICKING'].includes(m.tipo))agg[d].s+=v});
  const mx=Math.max(1,...days.map(d=>Math.max(agg[d].e,agg[d].s)));
  const grp={};balanceRows().forEach(b=>{const g=mat(b.material)?.grupo||'—';grp[g]=(grp[g]||0)+b.qtd*(mat(b.material)?.custo||0)});const gT=Object.values(grp).reduce((a,b)=>a+b,0)||1;
  return`
  <div class="grid g6" style="margin-bottom:12px">
    <div class="kpi lead"><div class="l">Valor em estoque</div><div class="v">${brl(valorEstoque())}</div><div class="s">${S.materiais.length} SKUs · custo médio</div></div>
    <div class="kpi ${rupt.length?'alert':''}"><div class="l">Ruptura (&lt; mínimo)</div><div class="v">${rupt.length}</div><div class="s">${repor.length} em ponto de pedido</div></div>
    <div class="kpi ${vencidos.length?'alert':venc.length?'warn':''}"><div class="l">Lotes a vencer ≤${S.cfg.diasVencAlerta}d</div><div class="v">${venc.length}</div><div class="s">${vencidos.length} vencido(s) com saldo</div></div>
    <div class="kpi"><div class="l">Pickings abertos</div><div class="v">${pk.length}</div><div class="s">${pk.reduce((s,p)=>s+p.linhas.length,0)} linhas a separar</div></div>
    <div class="kpi"><div class="l">Stock by order</div><div class="v">${brl(vOrd)}</div><div class="s">segregado para ${new Set(balanceRows({tipoEstoque:'ORDEM'}).map(b=>b.ordem)).size} ordem(ns)</div></div>
    <div class="kpi"><div class="l">Acuracidade inventário</div><div class="v">${acc==null?'—':pct(acc)}</div><div class="s">ocupação ${pct(usados/ends.length)} · ${quar} saldo(s) em CQ</div></div>
  </div>
  <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);margin-bottom:12px" id="dashRow">
    <div class="card"><div class="hd"><h3>Movimentação 30 dias (R$)</h3><div class="legend" style="margin-left:auto"><span><i style="background:var(--brand)"></i>Entradas</span><span><i style="background:var(--steel)"></i>Saídas</span></div></div>
      <div class="bd"><div class="bars">${days.map(d=>`<div class="b" title="${dtBR(d)} · Entradas ${brl(agg[d].e)} · Saídas ${brl(agg[d].s)}"><div style="display:flex;gap:1px;align-items:flex-end;height:100%"><i style="flex:1;height:${agg[d].e/mx*100}%;background:var(--brand)"></i><i style="flex:1;height:${agg[d].s/mx*100}%;background:var(--steel)"></i></div></div>`).join('')}</div>
      <div class="row sp xs muted" style="margin-top:4px"><span>${dtBR(days[0])}</span><span>${dtBR(days[29])}</span></div></div></div>
    <div class="card ai-box"><div class="hd">${ic('ai')}<h3>Insights da IA</h3><button class="btn sm" style="margin-left:auto" data-act="aiInsights">${ic('ref')} Gerar</button></div><div class="bd sm" id="aiInsights">${localInsights().map(t=>`<div style="padding:4px 0;border-bottom:1px solid var(--line2)">${t}</div>`).join('')}<div class="xs muted" style="margin-top:6px">Análise local por regras. "Gerar" consulta o Claude com os dados atuais. A IA propõe — a decisão é sua.</div></div></div>
  </div>
  <div class="grid g3">
    <div class="card"><div class="hd"><h3>Alertas de reposição</h3><a class="btn sm gh" style="margin-left:auto" href="#/planejamento">Ver MRP →</a></div><div class="bd alertlist">${[...rupt,...repor].slice(0,8).map(r=>`<div class="it">${stPill(r.crit)}<span class="grow">${matLabel(r.m.codigo)}</span><span class="num mono">${fmt(r.disp)} ${r.m.um}</span></div>`).join('')||'<div class="muted">Sem alertas.</div>'}</div></div>
    <div class="card"><div class="hd"><h3>Validade (FEFO)</h3><a class="btn sm gh" style="margin-left:auto" data-act="tab" data-k="est" data-v="lotes" href="#/estoque">Lotes →</a></div><div class="bd alertlist">${venc.slice(0,8).map(l=>`<div class="it">${P(l.dias<0?'VENCIDO':l.dias+'d',l.dias<0?'bad':l.dias<=15?'warn':'mut')}<span class="grow"><span class="mono">${esc(l.lote)}</span> <span class="muted sm">${esc(mat(l.material)?.descricao||'')}</span></span><span class="num mono">${fmt(l.qtd)}</span></div>`).join('')||'<div class="muted">Nenhum lote próximo do vencimento.</div>'}</div></div>
    <div class="card"><div class="hd"><h3>Valor por grupo</h3></div><div class="bd">${Object.entries(grp).sort((a,b)=>b[1]-a[1]).map(([g,v])=>`<div style="margin-bottom:8px"><div class="row sp sm"><span>${esc(g)}</span><span class="mono">${brl(v)}</span></div><div class="meter"><i style="width:${v/gT*100}%"></i></div></div>`).join('')}</div></div>
  </div>`;
};
VIEWS.after_dashboard=()=>{if(window.innerWidth<=860)$('#dashRow').style.gridTemplateColumns='1fr'};
function localInsights(){
  const out=[];const rep=reposicao();
  const r=rep.filter(x=>x.crit==='RUPTURA').sort((a,b)=>a.cob-b.cob)[0];if(r)out.push(`🔴 <b>${esc(r.m.codigo)}</b> abaixo do mínimo — cobertura de ${isFinite(r.cob)?fmt(r.cob,1)+' dias':'—'} frente a lead time de ${r.m.leadTime}d. Sugestão: ${fmt(r.sug)} ${r.m.um}.`);
  const nec=rep.filter(x=>x.necLiq>0&&x.disp<x.necLiq);nec.slice(0,2).forEach(x=>out.push(`🟣 Ordens abertas exigem ${fmt(x.necLiq)} ${x.m.um} de <b>${esc(x.m.codigo)}</b> sem segregação e o disponível é ${fmt(x.disp)} — risco de parada da ordem.`));
  const v=lotesVencendo(30)[0];if(v)out.push(`🟠 Lote <b>${esc(v.lote)}</b> (${esc(v.material)}) ${v.dias<0?'vencido':'vence em '+v.dias+' dias'} com ${fmt(v.qtd)} em saldo — priorizar consumo/segregar.`);
  const z=rep.filter(x=>x.xyz.cls==='Z'&&x.m.abc==='A');if(z.length)out.push(`📈 ${z.length} item(ns) classe A com demanda errática (Z) — revisar estoque de segurança.`);
  const dlq=S.outbox.filter(o=>o.status==='DLQ').length;if(dlq)out.push(`⚠️ ${dlq} mensagem(ns) na DLQ de integração.`);
  if(!out.length)out.push('✅ Nenhuma anomalia relevante detectada nos dados atuais.');
  return out;
}

/* ---------- M1 · RECEBIMENTO & CQ ---------- */
VIEWS.recebimento=()=>{
  const rows=S.recebimentos;
  const qLots=S.lotes.filter(l=>l.status==='QUARENTENA');
  return`<div class="grid g4" style="margin-bottom:12px">
    <div class="kpi"><div class="l">Rascunho / conferência</div><div class="v">${rows.filter(r=>['RASCUNHO','CONFERIDO'].includes(r.status)).length}</div></div>
    <div class="kpi warn"><div class="l">Em inspeção (CQ)</div><div class="v">${rows.filter(r=>r.status==='EM_INSPECAO').length}</div><div class="s">${qLots.length} lote(s) em quarentena</div></div>
    <div class="kpi"><div class="l">Concluídos (30d)</div><div class="v">${rows.filter(r=>r.status==='CONCLUIDO'&&daysTo(r.data)>=-30).length}</div></div>
    <div class="kpi"><div class="l">Divergências NF × físico</div><div class="v">${rows.reduce((s,r)=>s+r.itens.filter(i=>i.qtdConf!=null&&r3(i.qtdConf)!==r3(i.qtdNF)).length,0)}</div></div></div>
  ${tbl('rec',[
    {t:'Número',k:'numero',cls:'mono'},{t:'Data',v:r=>dtBR(r.data),s:r=>r.data},{t:'Fornecedor',k:'fornecedor'},{t:'NF',k:'nf',cls:'mono'},{t:'Pedido',k:'pedido',cls:'mono'},
    {t:'Itens',v:r=>r.itens.length,num:true},{t:'Valor',v:r=>brl(r.itens.reduce((s,i)=>s+(i.qtdConf??i.qtdNF)*i.custo,0)),num:true,s:r=>r.itens.reduce((s,i)=>s+i.qtdNF*i.custo,0)},{t:'Status',h:r=>stPill(r.status),v:r=>r.status}],
    [...rows].sort((a,b)=>b.numero.localeCompare(a.numero)),{onRow:r=>recDrawer(r.numero),empty:'Nenhum recebimento',tools:`<button class="btn pri" data-act="recNew">${ic('plus')} Novo recebimento</button><button class="btn" data-act="recFromXml">${ic('ul')} Importar NF-e (XML)</button>`})}`;
};
function recDrawer(numero){
  const r=numero?S.recebimentos.find(x=>x.numero===numero):{numero:'',fornecedor:'',nf:'',pedido:'',data:todayISO(),status:'RASCUNHO',inspecao:S.cfg.inspecaoPadrao,itens:[{material:'',lote:'',validade:'',fabricacao:'',qtdNF:'',qtdConf:null,deposito:'ALM01',endereco:'',custo:''}]};
  const edit=['RASCUNHO','CONFERIDO'].includes(r.status);
  const lineRow=(i,ix)=>`<tr data-ln="${ix}"><td style="min-width:190px"><select name="material">${matOpts().map(([v,t])=>`<option value="${v}" ${v===i.material?'selected':''}>${esc(t)}</option>`).join('')}</select></td>
    <td><input name="lote" value="${esc(i.lote)}" placeholder="auto"></td><td><input name="validade" type="date" value="${esc(i.validade||'')}"></td>
    <td><input name="qtdNF" type="number" step="any" value="${i.qtdNF}" style="width:80px"></td><td><input name="qtdConf" type="number" step="any" value="${i.qtdConf??''}" placeholder="contar" style="width:80px"></td>
    <td><input name="custo" type="number" step="any" value="${i.custo}" style="width:80px"></td>
    <td><select name="deposito">${depOpts(false,d=>!['QUARENTENA','EXPEDICAO'].includes(d.tipo)).map(([v,t])=>`<option value="${v}" ${v===i.deposito?'selected':''}>${v}</option>`).join('')}</select></td>
    <td><select name="endereco">${endOpts(i.deposito).map(([v,t])=>`<option value="${v}" ${v===i.endereco?'selected':''}>${v||'—'}</option>`).join('')}</select></td>
    <td>${edit?`<button class="btn ic sm gh" data-act="recDelLine" data-ix="${ix}">✕</button>`:''}</td></tr>`;
  const body=`<form id="recF"><div class="row" style="margin-bottom:10px">${r.numero?`<span class="mono">${r.numero}</span>`:P('NOVO','br')} ${stPill(r.status)}</div>
   <div class="fg">${F('Fornecedor','fornecedor',{value:r.fornecedor,req:true,readonly:!edit})}${F('Nota fiscal','nf',{value:r.nf,req:true,readonly:!edit})}${F('Pedido de compra','pedido',{value:r.pedido,readonly:!edit})}${F('Data','data',{type:'date',value:r.data,readonly:!edit})}
   ${F('Exigir inspeção de qualidade (entra em QUA01 / quarentena)','inspecao',{type:'checkbox',value:r.inspecao??S.cfg.inspecaoPadrao,full:true})}</div>
   <div class="sect">Itens · conferência cega × NF</div><div style="overflow-x:auto"><table class="lines" id="recLines"><thead><tr><th>Material</th><th>Lote</th><th>Validade</th><th>Qtd NF</th><th>Qtd conferida</th><th>Custo un.</th><th>Dep. destino</th><th>Endereço</th><th></th></tr></thead><tbody>${r.itens.map(lineRow).join('')}</tbody></table></div>
   ${edit?`<button type="button" class="btn sm" data-act="recAddLine" style="margin-top:6px">${ic('plus')} Linha</button>`:''}
   <div class="xs muted" style="margin-top:8px">Lote vazio em item com controle de lote gera código automático. Divergência NF × conferido é registrada e bloqueia o lançamento até decisão explícita.</div>
   ${r.status==='EM_INSPECAO'?`<div class="sect">Inspeção de qualidade</div>${r.itens.map((i,ix)=>{const L=lot(i.material,i.lote);return`<div class="step"><div class="n">${ix+1}</div><div class="grow">${matLabel(i.material)}<div class="sm">Lote <span class="mono">${esc(i.lote||'—')}</span> · ${fmt(i.qtdConf)} ${mat(i.material)?.um} · CQ ${stPill(i.cq||'LIBERADO')}</div></div>${i.cq==='PENDENTE'?`<div class="row"><button type="button" class="btn sm pri" data-act="cqLiberar" data-rc="${r.numero}" data-ix="${ix}">Liberar</button><button type="button" class="btn sm dan" data-act="cqRejeitar" data-rc="${r.numero}" data-ix="${ix}">Rejeitar</button></div>`:''}</div>`}).join('')}`:''}
   </form>`;
  const foot=edit?`${r.numero?`<button class="btn dan" data-act="recCancel" data-rc="${r.numero}">Cancelar</button>`:''}<button class="btn" data-act="recSave" data-rc="${r.numero}">Salvar rascunho</button><button class="btn pri" data-act="recPost" data-rc="${r.numero}">${ic('rec')} Lançar entrada</button>`:`<button class="btn" data-act="printRec" data-rc="${r.numero}">${ic('print')} Etiquetas</button>`;
  openDrawer(numero?`Recebimento ${numero}`:'Novo recebimento',body,foot,{wide:true});
  $('#recLines').addEventListener('change',e=>{if(e.target.name==='deposito'){const tr=e.target.closest('tr');tr.querySelector('[name=endereco]').innerHTML=endOpts(e.target.value).map(([v])=>`<option value="${v}">${v||'—'}</option>`).join('')}
    if(e.target.name==='material'){const m=mat(e.target.value);const tr=e.target.closest('tr');if(m&&!tr.querySelector('[name=custo]').value)tr.querySelector('[name=custo]').value=m.custo}});
  if(!edit)$$('#recF input,#recF select').forEach(x=>x.disabled=true);
}
function readRec(numero){
  const f=$('#recF');const h=readForm(f);clearErr(f);let ok=true;
  if(!h.fornecedor){fieldErr(f,'fornecedor','Obrigatório');ok=false} if(!h.nf){fieldErr(f,'nf','Obrigatório');ok=false}
  const itens=$$('#recLines tbody tr').map(tr=>{const o={};$$('[name]',tr).forEach(i=>o[i.name]=i.value.trim());return{material:o.material,lote:o.lote,validade:o.validade,qtdNF:parseNum(o.qtdNF),qtdConf:o.qtdConf===''?null:parseNum(o.qtdConf),custo:parseNum(o.custo)||mat(o.material)?.custo||0,deposito:o.deposito,endereco:o.endereco}}).filter(i=>i.material);
  if(!itens.length){toast('Inclua ao menos um item','bad');ok=false}
  itens.forEach(i=>{if(!(i.qtdNF>0)){toast(`Quantidade NF inválida em ${i.material}`,'bad');ok=false}const m=mat(i.material);if(m?.controlaValidade&&!i.validade){toast(`${i.material} controla validade — informe a data`,'bad');ok=false}});
  const r=numero?S.recebimentos.find(x=>x.numero===numero):null;
  return ok?{...(r||{}),numero:numero||nextSeq('RC'),fornecedor:h.fornecedor,nf:h.nf,pedido:h.pedido,data:h.data||todayISO(),inspecao:h.inspecao,status:r?.status||'RASCUNHO',itens}:null;
}

/* ---------- M2 · ESTOQUE & ENDEREÇAMENTO ---------- */
const EF={dep:'',te:'',grp:'',zero:false,agr:'det'};
VIEWS.estoque=()=>{
  const t=curTab('est','saldos');
  const head=tabs('est',[['saldos','Saldos'],['ordem','Stock by Order'],['lotes','Lotes & Validade'],['mapa','Mapa de endereços'],['movs','Movimentos']]);
  const actions=`<button class="btn pri" data-act="movNew" data-t="TRANSFERENCIA">${ic('transfer')} Transferir</button><button class="btn" data-act="movNew" data-t="ENTRADA">Entrada avulsa</button><button class="btn" data-act="movNew" data-t="SAIDA">Saída / requisição</button><button class="btn" data-act="movNew" data-t="RESERVA_ORDEM">Segregar p/ ordem</button>`;
  if(t==='saldos'){
    const res=reservedMap();
    let rows=balanceRows().filter(b=>(!EF.dep||b.deposito===EF.dep)&&(!EF.te||b.tipoEstoque===EF.te)&&(!EF.grp||mat(b.material)?.grupo===EF.grp));
    if(EF.agr==='mat'){const g={};rows.forEach(b=>{const k=b.material;g[k]=g[k]||{material:k,qtd:0,res:0,pos:0,ord:0};g[k].qtd+=b.qtd;g[k].res+=res.get(b.key)||0;g[k].pos++;if(b.tipoEstoque==='ORDEM')g[k].ord+=b.qtd});
      const list=Object.values(g);return head+`<div class="toolbar">${estFilters()}${actions}</div>`+tbl('salM',[
        {t:'Material',h:r=>matLabel(r.material),v:r=>r.material+' '+(mat(r.material)?.descricao||'')},{t:'UM',v:r=>mat(r.material)?.um},{t:'ABC',v:r=>mat(r.material)?.abc},
        {t:'Saldo',v:r=>fmt(r.qtd),s:r=>r.qtd,num:true},{t:'Em ordem',v:r=>fmt(r.ord),s:r=>r.ord,num:true},{t:'Reservado picking',v:r=>fmt(r.res),s:r=>r.res,num:true},
        {t:'Disponível',h:r=>`<b>${fmt(disponivel(r.material))}</b>`,s:r=>disponivel(r.material),num:true},{t:'Mín.',v:r=>fmt(mat(r.material)?.minimo),num:true},
        {t:'Posições',v:r=>r.pos,num:true},{t:'Valor',v:r=>brl(r.qtd*(mat(r.material)?.custo||0)),s:r=>r.qtd*(mat(r.material)?.custo||0),num:true}],list,{onRow:r=>matDrawer(r.material),foot:rs=>`<td colspan="9">Total</td><td class="num">${brl(rs.reduce((s,r)=>s+r.qtd*(mat(r.material)?.custo||0),0))}</td>`})}
    return head+`<div class="toolbar">${estFilters()}${actions}</div>`+tbl('sal',[
      {t:'Material',h:r=>matLabel(r.material),v:r=>r.material+' '+(mat(r.material)?.descricao||'')},{t:'Lote',h:r=>r.lote?`<span class="mono">${esc(r.lote)}</span> ${lot(r.material,r.lote)?.status!=='LIBERADO'?stPill(lot(r.material,r.lote)?.status):''}`:'<span class="muted">—</span>',v:r=>r.lote},
      {t:'Validade',h:r=>{const v=lot(r.material,r.lote)?.validade;if(!v)return'<span class="muted">—</span>';const d=daysTo(v);return`${dtBR(v)} ${d<0?P('vencido','bad'):d<=S.cfg.diasVencAlerta?P(d+'d','warn'):''}`},s:r=>lot(r.material,r.lote)?.validade||'9999'},
      {t:'Depósito',k:'deposito',cls:'mono'},{t:'Endereço',k:'endereco',cls:'mono'},{t:'Tipo estoque',h:r=>tePill(r.tipoEstoque,r.ordem),v:r=>r.tipoEstoque+' '+r.ordem},
      {t:'Saldo',v:r=>fmt(r.qtd),s:r=>r.qtd,num:true},{t:'Reserv.',v:r=>fmt(res.get(r.key)||0),s:r=>res.get(r.key)||0,num:true},{t:'UM',v:r=>mat(r.material)?.um},
      {t:'Valor',v:r=>brl(r.qtd*(mat(r.material)?.custo||0)),s:r=>r.qtd*(mat(r.material)?.custo||0),num:true},
      {t:'',h:r=>`<button class="btn sm" data-act="movFrom" data-key="${esc(r.key)}">Mover</button>`}],rows,{onRow:r=>matDrawer(r.material),foot:rs=>`<td colspan="9">${rs.length} posições</td><td class="num">${brl(rs.reduce((s,r)=>s+r.qtd*(mat(r.material)?.custo||0),0))}</td><td></td>`});
  }
  if(t==='ordem'){
    const ords=S.ordens.filter(o=>!['CANCELADA'].includes(o.status));
    return head+`<div class="toolbar"><div class="muted sm grow">Stock by order = saldo segregado e reservado para uma ordem (OP, OS, projeto, OV). Só a ordem dona consome; liberação devolve ao estoque normal.</div><button class="btn pri" data-act="ordNew">${ic('plus')} Nova ordem</button><button class="btn" data-act="movNew" data-t="RESERVA_ORDEM">Segregar saldo</button></div>
    <div class="grid g2">${ords.map(o=>{const its=o.itens.map(i=>{const seg=balanceRows({material:i.material,tipoEstoque:'ORDEM',ordem:o.numero}).reduce((s,b)=>s+b.qtd,0);const cons=S.movs.filter(m=>m.ordem===o.numero&&m.material===i.material&&['PICKING','SAIDA'].includes(m.tipo)).reduce((s,m)=>s-m.qtd,0);return{...i,seg:seg||0,cons}});const cov=its.reduce((s,i)=>s+Math.min(1,(i.seg+i.cons)/i.qtd),0)/Math.max(1,its.length);
      return`<div class="card"><div class="hd"><span class="mono">${esc(o.numero)}</span>${P(o.tipo,'ord')}${stPill(o.status)}<span class="grow"></span><button class="btn sm" data-act="ordEdit" data-o="${o.numero}">Editar</button><button class="btn sm" data-act="ordSegAll" data-o="${o.numero}">Segregar tudo</button><button class="btn sm" data-act="pickFromOrd" data-o="${o.numero}">Gerar picking</button></div>
      <div class="bd"><div class="row sp sm"><span><b>${esc(o.descricao)}</b> · ${esc(o.cliente||'')}</span><span class="muted">entrega ${dtBR(o.entrega)} (${daysTo(o.entrega)}d)</span></div>
      <div class="row sm" style="margin:6px 0"><span class="muted">Cobertura segregada+consumida</span><div class="meter grow"><i style="width:${cov*100}%;background:var(--ordem)"></i></div><b>${pct(cov)}</b></div>
      <table class="t"><thead><tr><th>Material</th><th class="num">Necess.</th><th class="num">Segregado</th><th class="num">Consumido</th><th class="num">Falta</th><th></th></tr></thead><tbody>${its.map(i=>{const falta=Math.max(0,i.qtd-i.seg-i.cons);return`<tr><td>${matLabel(i.material)}</td><td class="num">${fmt(i.qtd)}</td><td class="num">${fmt(i.seg)}</td><td class="num">${fmt(i.cons)}</td><td class="num">${falta?`<b style="color:var(--bad)">${fmt(falta)}</b>`:'—'}</td><td>${i.seg>0?`<button class="btn sm gh" data-act="ordRelease" data-o="${o.numero}" data-m="${i.material}">Liberar</button>`:''}</td></tr>`}).join('')}</tbody></table></div></div>`}).join('')||'<div class="empty"><b>Sem ordens</b></div>'}</div>`;
  }
  if(t==='lotes'){
    const rows=S.lotes.map(l=>({...l,qtd:balanceRows({material:l.material,lote:l.lote}).reduce((s,b)=>s+b.qtd,0)}));
    return head+tbl('lot',[{t:'Material',h:r=>matLabel(r.material),v:r=>r.material+' '+(mat(r.material)?.descricao||'')},{t:'Lote',k:'lote',cls:'mono'},{t:'Fabricação',v:r=>dtBR(r.fabricacao),s:r=>r.fabricacao},
      {t:'Validade',h:r=>r.validade?`${dtBR(r.validade)} ${daysTo(r.validade)<0?P('vencido','bad'):daysTo(r.validade)<=S.cfg.diasVencAlerta?P(daysTo(r.validade)+'d','warn'):''}`:'—',s:r=>r.validade||'9999'},
      {t:'Fornecedor',k:'fornecedor'},{t:'Status',h:r=>stPill(r.status),v:r=>r.status},{t:'Saldo',v:r=>fmt(r.qtd),s:r=>r.qtd,num:true}],rows,{onRow:r=>lotDrawer(r.material,r.lote),tools:`<button class="btn pri" data-act="lotNew">${ic('plus')} Novo lote</button>`});
  }
  if(t==='mapa'){
    const d=EF.mapDep||'ALM01';const oc=ocupacao();const ends=S.enderecos.filter(e=>e.deposito===d);
    return head+`<div class="toolbar"><select class="flt" data-act="mapDep">${depOpts(false).map(([v,t])=>`<option value="${v}" ${v===d?'selected':''}>${esc(t)}</option>`).join('')}</select><span class="legend"><span><i style="background:rgba(235,106,32,.35)"></i>ocupação</span><span><i style="background:var(--info)"></i>picking</span><span><i style="border:1px dashed var(--warn)"></i>quarentena</span></span><button class="btn" data-act="endNew" style="margin-left:auto">${ic('plus')} Endereço</button><button class="btn" data-act="printEnds" data-d="${d}">${ic('print')} Etiquetas</button></div>
    <div class="map">${ends.map(e=>{const q=oc.get(d+'|'+e.codigo)||0;const f=Math.min(1,q/(e.capacidade||1));return`<div class="cell ${e.tipo==='QUARENTENA'?'quar':''} ${e.tipo==='PICKING'?'pick':''}" data-act="endView" data-d="${d}" data-e="${esc(e.codigo)}" title="${e.codigo} · ${fmt(q)} / cap ${fmt(e.capacidade)}"><div class="fill" style="height:${f*100}%"></div><span><b>${esc(e.codigo)}</b><br><span class="muted">${pct(f)}</span></span></div>`}).join('')}</div>`;
  }
  if(t==='movs'){
    const rows=[...S.movs].reverse();
    return head+tbl('mov',[{t:'Data/hora',v:r=>tsBR(r.ts),s:r=>r.ts},{t:'Tipo',h:r=>P(r.tipo,r.qtd>0?'ok':'mut'),v:r=>r.tipo},{t:'Documento',k:'doc',cls:'mono'},{t:'Material',h:r=>matLabel(r.material),v:r=>r.material},
      {t:'Lote',k:'lote',cls:'mono'},{t:'Dep/End',v:r=>r.deposito+(r.endereco?'/'+r.endereco:''),cls:'mono'},{t:'Estoque',h:r=>tePill(r.tipoEstoque,r.ordem),v:r=>r.tipoEstoque+r.ordem},
      {t:'Qtd',h:r=>`<span style="color:${r.qtd<0?'var(--bad)':'var(--ok)'}">${r.qtd>0?'+':''}${fmt(r.qtd)}</span>`,s:r=>r.qtd,num:true},{t:'Usuário',k:'user'},{t:'Obs',k:'obs'}],rows,{limit:200});
  }
};
function estFilters(){const grps=[...new Set(S.materiais.map(m=>m.grupo))];
  return`<select class="flt" data-act="ef" data-k="dep"><option value="">Todos depósitos</option>${S.depositos.map(d=>`<option ${EF.dep===d.codigo?'selected':''} value="${d.codigo}">${d.codigo}</option>`).join('')}</select>
  <select class="flt" data-act="ef" data-k="te"><option value="">Normal + Ordem</option><option value="NORMAL" ${EF.te==='NORMAL'?'selected':''}>Só normal</option><option value="ORDEM" ${EF.te==='ORDEM'?'selected':''}>Só stock by order</option></select>
  <select class="flt" data-act="ef" data-k="grp"><option value="">Todos grupos</option>${grps.map(g=>`<option ${EF.grp===g?'selected':''}>${esc(g)}</option>`).join('')}</select>
  <select class="flt" data-act="ef" data-k="agr"><option value="det" ${EF.agr==='det'?'selected':''}>Detalhado (lote/endereço)</option><option value="mat" ${EF.agr==='mat'?'selected':''}>Agrupado por material</option></select>`}

/* Gaveta de movimentação universal */
function movDrawer(tipo,pre={}){
  const T={TRANSFERENCIA:'Transferência entre endereços/depósitos',ENTRADA:'Entrada avulsa',SAIDA:'Saída / requisição de material',RESERVA_ORDEM:'Segregar saldo para ordem (stock by order)',AJUSTE:'Ajuste de estoque'}[tipo];
  const body=`<form id="movF"><input type="hidden" name="tipo" value="${tipo}"><div class="fg">
    ${F('Material','material',{opts:matOpts(),value:pre.material||'',req:true,full:true})}
    ${tipo==='ENTRADA'?F('Lote (se controla)','lote',{value:pre.lote||'',ph:'novo ou existente'})+F('Validade do lote','validade',{type:'date'}):''}
    ${tipo!=='ENTRADA'?`<div class="f full" data-f="origem"><label>Posição de origem *</label><select name="origem" id="movOrig"></select><div class="err"></div></div>`:''}
    ${tipo==='ENTRADA'||tipo==='TRANSFERENCIA'?F('Depósito destino','deposito',{opts:depOpts(),value:pre.deposito||'',req:true})+`<div class="f" data-f="endereco"><label>Endereço destino</label><select name="endereco" id="movEnd">${endOpts(pre.deposito||'').map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')}</select><div class="err"></div></div>`:''}
    ${tipo==='TRANSFERENCIA'?F('Tipo de estoque destino','tipoEstoque',{opts:[['MANTER','Manter o da origem'],['NORMAL','Normal (livre)'],['ORDEM','Ordem (stock by order)']]})+F('Ordem destino','ordem',{opts:ordOpts()}):''}
    ${tipo==='RESERVA_ORDEM'?F('Ordem dona do saldo','ordem',{opts:ordOpts(),req:true,value:pre.ordem||''}):''}
    ${tipo==='SAIDA'?F('Ordem / centro de custo','ordemRef',{opts:ordOpts(),help:'Saída de estoque de ordem exige a mesma ordem'})+F('Solicitante','solicitante',{}):''}
    ${F('Quantidade','qtd',{type:'number',step:'any',req:true,value:pre.qtd||''})}
    ${tipo==='ENTRADA'?F('Custo unitário (R$)','custo',{type:'number',step:'any'}):''}
    ${F('Documento de referência','doc',{ph:'NF, requisição, OS…'})}
    ${F('Observação','obs',{type:'textarea',full:true})}
  </div><div class="xs muted" style="margin-top:8px">O lançamento valida saldo por posição, status do lote, reservas de picking e dono do estoque de ordem. Nenhum saldo pode ficar negativo.</div></form>`;
  openDrawer(T,body,`<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn pri" data-act="movPost">Lançar</button>`);
  const f=$('#movF');
  const fillOrig=()=>{const o=$('#movOrig');if(!o)return;const m=$('[name=material]',f).value;const res=reservedMap();
    let rows=balanceRows({material:m}).filter(b=>b.qtd>0);
    if(tipo==='RESERVA_ORDEM')rows=rows.filter(b=>b.tipoEstoque==='NORMAL');
    const sel=pre.key;
    o.innerHTML=rows.length?rows.map(b=>{const L=b.lote?lot(m,b.lote):null;const av=r3(b.qtd-(res.get(b.key)||0));return`<option value="${esc(b.key)}" ${b.key===sel?'selected':''}>${b.deposito}/${b.endereco||'—'} · ${b.lote||'s/ lote'}${L?.validade?' · val '+dtBR(L.validade):''} · ${b.tipoEstoque}${b.ordem?' '+b.ordem:''} · disp ${fmt(av)}${L&&L.status!=='LIBERADO'?' · '+L.status:''}</option>`}).join(''):'<option value="">Sem saldo</option>'};
  $('[name=material]',f).onchange=()=>{fillOrig();const m=mat($('[name=material]',f).value);if(m&&$('[name=custo]',f)&&!$('[name=custo]',f).value)$('[name=custo]',f).value=m.custo};
  if($('[name=deposito]',f))$('[name=deposito]',f).onchange=()=>{$('#movEnd').innerHTML=endOpts($('[name=deposito]',f).value).map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')};
  fillOrig();
}
function movPost(){
  const f=$('#movF');const o=readForm(f);clearErr(f);const tipo=o.tipo;const q=parseNum(o.qtd);
  if(!o.material)return fieldErr(f,'material','Selecione');
  if(!(q>0))return fieldErr(f,'qtd','Quantidade > 0');
  try{
    let movs=[];let doc=o.doc||nextSeq(tipo==='ENTRADA'?'ENT':tipo==='SAIDA'?'REQ':tipo==='RESERVA_ORDEM'?'SEG':'TRF');
    if(tipo==='ENTRADA'){
      if(!o.deposito)return fieldErr(f,'deposito','Obrigatório');const M=mat(o.material);
      let lote=o.lote;if(M.controlaLote){if(!lote)lote=autoLote(o.material);if(!lot(o.material,lote)){if(M.controlaValidade&&!o.validade)return fieldErr(f,'validade','Material controla validade');S.lotes.push({material:o.material,lote,fabricacao:todayISO(),validade:o.validade||'',fornecedor:'',status:dep(o.deposito).tipo==='QUARENTENA'?'QUARENTENA':'LIBERADO'})}}
      else lote='';
      movs=[{tipo:'ENTRADA',material:o.material,lote,deposito:o.deposito,endereco:o.endereco,qtd:q,custo:parseNum(o.custo)||M.custo,obs:o.obs}];
    }else{
      if(!o.origem)return fieldErr(f,'origem','Sem saldo de origem');
      const [material,lote,d,e,te,od]=o.origem.split('|');
      if(tipo==='SAIDA'){if(te==='ORDEM'&&o.ordemRef!==od)throw new BizError(`Este saldo pertence à ordem ${od} — selecione-a como referência`);movs=[{tipo:'SAIDA',material,lote,deposito:d,endereco:e,tipoEstoque:te,ordem:od,qtd:-q,obs:[o.obs,o.solicitante&&'Solic.: '+o.solicitante,o.ordemRef&&'Ref.: '+o.ordemRef].filter(Boolean).join(' · ')}]}
      if(tipo==='TRANSFERENCIA'){if(!o.deposito)return fieldErr(f,'deposito','Obrigatório');let nte=o.tipoEstoque==='MANTER'?te:o.tipoEstoque;let nod=nte==='ORDEM'?(o.tipoEstoque==='MANTER'?od:o.ordem):'';if(nte==='ORDEM'&&!nod)return fieldErr(f,'ordem','Informe a ordem');
        if(d===o.deposito&&e===(o.endereco||'')&&te===nte&&od===nod)throw new BizError('Origem e destino idênticos');
        movs=transferMovs({material,lote,de:{dep:d,end:e,tipoEstoque:te,ordem:od},para:{dep:o.deposito,end:o.endereco,tipoEstoque:nte,ordem:nod},qtd:q,obs:o.obs});}
      if(tipo==='RESERVA_ORDEM'){if(!o.ordem)return fieldErr(f,'ordem','Obrigatório');movs=transferMovs({tipo:'RESERVA_ORDEM',material,lote,de:{dep:d,end:e,tipoEstoque:'NORMAL'},para:{dep:d,end:e,tipoEstoque:'ORDEM',ordem:o.ordem},qtd:q,obs:o.obs||'Segregação p/ '+o.ordem})}
    }
    postDoc(movs,{doc,tipoDoc:tipo});toast(`${doc} lançado`,'ok');closeDrawer();render();
  }catch(e){if(e instanceof BizError)toast(e.message,'bad');else{console.error(e);toast('Erro: '+e.message,'bad')}}
}
function autoLote(m){const d=todayISO();let i=1,l;do{l=`L${d.slice(2,4)}${d.slice(5,7)}${d.slice(8,10)}-${String(i++).padStart(2,'0')}`}while(lot(m,l));return l}

/* ---------- M3 · PICKING & EXPEDIÇÃO ---------- */
function allocate(material,qtd,{ordem='',estrategia=S.cfg.estrategia,usarNormal=true,excluirPicking=null}={}){
  const res=reservedMap();
  if(excluirPicking){excluirPicking.linhas.forEach(l=>l.aloc.forEach(a=>{const k=[l.material,a.lote||'',a.deposito,a.endereco||'',a.tipoEstoque,a.ordem||''].join('|');res.set(k,(res.get(k)||0)-(a.qtd-(a.sep||0)))}))}
  const firstIn={};S.movs.forEach(m=>{if(m.qtd>0){const k=balKey(m);if(!firstIn[k]||m.ts<firstIn[k])firstIn[k]=m.ts}});
  let c=balanceRows({material}).filter(b=>b.qtd>0&&['ALMOXARIFADO','PRODUCAO'].includes(dep(b.deposito)?.tipo)).map(b=>{const L=b.lote?lot(material,b.lote):null;return{...b,L,av:r3(b.qtd-(res.get(b.key)||0))}})
    .filter(b=>b.av>0&&(!b.L||(b.L.status==='LIBERADO'&&!(b.L.validade&&daysTo(b.L.validade)<0))))
    .filter(b=>b.tipoEstoque==='NORMAL'?usarNormal:(ordem&&b.ordem===ordem));
  const eTipo=b=>endr(b.deposito,b.endereco)?.tipo==='PICKING'?0:1;
  c.sort((a,b)=>(a.tipoEstoque==='ORDEM'?0:1)-(b.tipoEstoque==='ORDEM'?0:1)
    ||(estrategia==='FEFO'?String(a.L?.validade||'9999').localeCompare(String(b.L?.validade||'9999')):0)
    ||((firstIn[a.key]||0)-(firstIn[b.key]||0))||eTipo(a)-eTipo(b)||a.endereco.localeCompare(b.endereco));
  let rest=qtd;const aloc=[];
  for(const b of c){if(rest<=1e-9)break;const q=r3(Math.min(rest,b.av));aloc.push({deposito:b.deposito,endereco:b.endereco,lote:b.lote,tipoEstoque:b.tipoEstoque,ordem:b.ordem,qtd:q,sep:0,validade:b.L?.validade||''});rest=r3(rest-q)}
  return{aloc,falta:Math.max(0,r3(rest))};
}
VIEWS.picking=()=>{
  const t=curTab('pk','abertos');
  const list=t==='abertos'?S.pickings.filter(p=>['ABERTO','EM_SEPARACAO','SEPARADO'].includes(p.status)):S.pickings;
  return tabs('pk',[['abertos','Em aberto'],['todos','Histórico']])+`<div class="grid g4" style="margin-bottom:12px">
   <div class="kpi"><div class="l">Abertos</div><div class="v">${S.pickings.filter(p=>p.status==='ABERTO').length}</div></div>
   <div class="kpi warn"><div class="l">Em separação</div><div class="v">${S.pickings.filter(p=>p.status==='EM_SEPARACAO').length}</div></div>
   <div class="kpi"><div class="l">Aguardando expedição</div><div class="v">${S.pickings.filter(p=>p.status==='SEPARADO').length}</div></div>
   <div class="kpi ${S.pickings.some(p=>['ABERTO','EM_SEPARACAO'].includes(p.status)&&p.linhas.some(l=>l.falta>0))?'alert':''}"><div class="l">Linhas com falta</div><div class="v">${S.pickings.filter(p=>['ABERTO','EM_SEPARACAO'].includes(p.status)).reduce((s,p)=>s+p.linhas.filter(l=>l.falta>0).length,0)}</div></div></div>`+
  tbl('pk',[{t:'',h:p=>['ABERTO','EM_SEPARACAO'].includes(p.status)?`<input type="checkbox" class="pkSel" value="${p.numero}">`:''},{t:'Número',k:'numero',cls:'mono'},{t:'Criado',v:p=>tsBR(p.criado),s:p=>p.criado},{t:'Origem',h:p=>p.ordem?`${P(ord(p.ordem)?.tipo||'ORD','ord')} <span class="mono">${esc(p.ordem)}</span>`:P('AVULSO','mut'),v:p=>p.ordem},
    {t:'Destino',v:p=>`${p.modo==='CONSUMO'?'Consumo':'→ '+p.destino.dep+'/'+(p.destino.end||'')}`},{t:'Estratégia',k:'estrategia'},{t:'Prior.',h:p=>P(p.prioridade,p.prioridade==='URGENTE'?'bad':p.prioridade==='ALTA'?'warn':'mut'),v:p=>p.prioridade},
    {t:'Linhas',v:p=>p.linhas.length,num:true},{t:'Progresso',h:p=>{const t=p.linhas.reduce((s,l)=>s+l.qtd,0),d=p.linhas.reduce((s,l)=>s+l.aloc.reduce((a,x)=>a+(x.sep||0),0),0);return`<div class="row" style="flex-wrap:nowrap"><div class="meter grow"><i style="width:${t?d/t*100:0}%"></i></div><span class="xs mono">${pct(t?d/t:0)}</span></div>`}},
    {t:'Status',h:p=>stPill(p.status)+(p.linhas.some(l=>l.falta>0)&&['ABERTO','EM_SEPARACAO'].includes(p.status)?' '+P('falta','bad'):''),v:p=>p.status}],[...list].sort((a,b)=>b.criado-a.criado),
  {onRow:p=>pickDrawer(p.numero),empty:'Nenhum picking',tools:`<button class="btn pri" data-act="pickNew">${ic('plus')} Novo picking</button><button class="btn" data-act="pickWave">Onda (selecionados)</button>`});
};
function pickNewDrawer(ordem=''){
  const o=ord(ordem);
  const body=`<form id="pkF"><div class="fg">
   ${F('Ordem de origem','ordem',{opts:ordOpts(),value:ordem,help:'Com ordem: itens e estoque segregado da ordem entram automaticamente'})}
   ${F('Modo','modo',{opts:[['TRANSFERENCIA','Transferir p/ área (produção/doca)'],['CONSUMO','Baixa direta (consumo na ordem)']]})}
   ${F('Depósito destino','destDep',{opts:depOpts(false,d=>['PRODUCAO','EXPEDICAO'].includes(d.tipo)),value:'PRD01'})}
   <div class="f" data-f="destEnd"><label>Endereço destino</label><select name="destEnd" id="pkEnd">${endOpts('PRD01').map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')}</select></div>
   ${F('Estratégia de alocação','estrategia',{opts:[['FEFO','FEFO — vence primeiro, sai primeiro'],['FIFO','FIFO — entrou primeiro, sai primeiro']],value:S.cfg.estrategia})}
   ${F('Prioridade','prioridade',{opts:['NORMAL','ALTA','URGENTE']})}
   ${F('Usar estoque normal se o segregado não cobrir','usarNormal',{type:'checkbox',value:true,full:true})}</div>
   <div class="sect">Itens</div><table class="lines" id="pkLines"><thead><tr><th>Material</th><th>Qtd</th><th></th></tr></thead><tbody>
   ${(o?o.itens.map(i=>({material:i.material,qtd:Math.max(0,i.qtd-S.movs.filter(m=>m.ordem===o.numero&&m.material===i.material&&['PICKING','SAIDA'].includes(m.tipo)).reduce((s,m)=>s-m.qtd,0))})).filter(i=>i.qtd>0):[{material:'',qtd:''}]).map(i=>pkLine(i)).join('')}</tbody></table>
   <button type="button" class="btn sm" data-act="pkAddLine" style="margin-top:6px">${ic('plus')} Linha</button></form>`;
  openDrawer('Novo picking',body,`<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn" data-act="pkSim">Simular alocação</button><button class="btn pri" data-act="pkCreate">Criar e alocar</button>`,{wide:true});
  const f=$('#pkF');$('[name=destDep]',f).onchange=()=>{$('#pkEnd').innerHTML=endOpts($('[name=destDep]',f).value).map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')};
  $('[name=ordem]',f).onchange=()=>pickNewDrawer($('[name=ordem]',f).value);
}
const pkLine=i=>`<tr><td style="min-width:260px"><select name="material">${matOpts().map(([v,t])=>`<option value="${v}" ${v===i.material?'selected':''}>${esc(t)}</option>`).join('')}</select></td><td style="width:110px"><input name="qtd" type="number" step="any" value="${i.qtd}"></td><td><button type="button" class="btn ic sm gh" data-act="rmRow">✕</button></td></tr>`;
function readPick(){const f=$('#pkF');const o=readForm(f);const itens=$$('#pkLines tbody tr').map(tr=>({material:$('[name=material]',tr).value,qtd:parseNum($('[name=qtd]',tr).value)})).filter(i=>i.material&&i.qtd>0);return{o,itens}}
function pickCreate(sim){
  const{o,itens}=readPick();if(!itens.length)return toast('Inclua itens com quantidade','bad');
  const tmp={linhas:[]};const linhas=itens.map(i=>{const a=allocate(i.material,i.qtd,{ordem:o.ordem,estrategia:o.estrategia,usarNormal:o.usarNormal});return{material:i.material,qtd:i.qtd,aloc:a.aloc,falta:a.falta}});
  if(sim){openModal('Simulação de alocação',`<table class="t"><thead><tr><th>Material</th><th>Posição</th><th>Lote</th><th>Validade</th><th>Estoque</th><th class="num">Qtd</th></tr></thead><tbody>${linhas.map(l=>l.aloc.map(a=>`<tr><td>${esc(l.material)}</td><td class="mono">${a.deposito}/${a.endereco}</td><td class="mono">${esc(a.lote||'—')}</td><td>${dtBR(a.validade)}</td><td>${tePill(a.tipoEstoque,a.ordem)}</td><td class="num">${fmt(a.qtd)}</td></tr>`).join('')+(l.falta?`<tr><td>${esc(l.material)}</td><td colspan="4" style="color:var(--bad)">FALTA — sem saldo disponível liberado</td><td class="num" style="color:var(--bad)">${fmt(l.falta)}</td></tr>`:'')).join('')}</tbody></table>`,[{t:'Fechar',v:0}],{wide:true});return}
  const p={numero:nextSeq('PK'),criado:Date.now(),ordem:o.ordem,modo:o.modo,destino:{dep:o.destDep,end:o.destEnd},estrategia:o.estrategia,prioridade:o.prioridade,status:'ABERTO',linhas,usarNormal:o.usarNormal};
  S.pickings.push(p);audit('CRIAR','PICKING',p.numero,`${linhas.length} linhas; falta em ${linhas.filter(l=>l.falta).length}`);save();closeDrawer();toast(`${p.numero} criado${linhas.some(l=>l.falta)?' — há faltas':''}`,linhas.some(l=>l.falta)?'':'ok');render();pickDrawer(p.numero);
}
function pickDrawer(n){
  const p=S.pickings.find(x=>x.numero===n);if(!p)return;const act=['ABERTO','EM_SEPARACAO'].includes(p.status);
  let k=0;const steps=[];p.linhas.forEach((l,li)=>l.aloc.forEach((a,ai)=>steps.push({l,a,li,ai,n:++k})));
  steps.sort((x,y)=>(x.a.deposito+x.a.endereco).localeCompare(y.a.deposito+y.a.endereco,'pt-BR',{numeric:true}));
  const body=`<div class="row" style="margin-bottom:8px"><span class="mono">${p.numero}</span>${stPill(p.status)}${p.ordem?P(p.ordem,'ord'):''}${P(p.estrategia,'info')}<span class="muted sm">${p.modo==='CONSUMO'?'Baixa direta na ordem':'Destino '+p.destino.dep+'/'+(p.destino.end||'—')}</span></div>
  ${act?`<div class="card" style="margin-bottom:10px"><div class="bd"><div class="row"><input id="pkScan" class="grow" style="padding:9px;border:1px solid var(--line);border-radius:6px;font-family:var(--fm)" placeholder="Bipe endereço, depois material/lote para confirmar…" autocomplete="off"><button class="btn" data-act="openScanner" data-target="pkScan">${ic('scan')}</button></div><div class="xs muted" style="margin-top:4px" id="pkScanMsg">Rota ordenada por endereço. Leitura do endereço seleciona a tarefa; leitura do material/lote confirma a quantidade alocada.</div></div></div>`:''}
  ${steps.map(s=>{const done=(s.a.sep||0)>=s.a.qtd-1e-9;return`<div class="step ${done?'done':''}" data-step="${s.li}:${s.ai}"><div class="n">${s.n}</div><div class="grow"><div class="row sp"><b class="mono">${s.a.deposito}/${esc(s.a.endereco)}</b>${tePill(s.a.tipoEstoque,s.a.ordem)}</div>${matLabel(s.l.material)}<div class="sm">Lote <span class="mono">${esc(s.a.lote||'—')}</span>${s.a.validade?' · val '+dtBR(s.a.validade):''} · alocado <b>${fmt(s.a.qtd)}</b> ${mat(s.l.material)?.um}</div></div>
    ${act?`<div style="width:110px"><input type="number" step="any" class="sepIn" data-li="${s.li}" data-ai="${s.ai}" value="${s.a.sep||''}" placeholder="separado" style="width:100%;padding:6px;border:1px solid var(--line);border-radius:5px;text-align:right"><button class="btn sm" style="width:100%;margin-top:4px" data-act="sepFull" data-li="${s.li}" data-ai="${s.ai}">✓ ${fmt(s.a.qtd)}</button></div>`:`<div class="num mono">${fmt(s.a.sep||0)}</div>`}</div>`}).join('')}
  ${p.linhas.filter(l=>l.falta>0).map(l=>`<div class="step" style="border-color:var(--bad)"><div class="n" style="background:var(--bad)">!</div><div class="grow">${matLabel(l.material)}<div class="sm" style="color:var(--bad)">Falta ${fmt(l.falta)} ${mat(l.material)?.um} sem saldo liberado</div></div>${act?`<button class="btn sm" data-act="pkRealloc" data-p="${p.numero}">Realocar</button>`:''}</div>`).join('')}`;
  const foot=act?`<button class="btn dan" data-act="pkCancel" data-p="${p.numero}">Cancelar picking</button><button class="btn" data-act="pkPrint" data-p="${p.numero}">${ic('print')} Lista</button><button class="btn" data-act="pkRealloc" data-p="${p.numero}">Realocar</button><button class="btn pri" data-act="pkFinish" data-p="${p.numero}">Finalizar separação</button>`
    :p.status==='SEPARADO'&&p.destino.dep&&dep(p.destino.dep)?.tipo==='EXPEDICAO'?`<button class="btn" data-act="pkPrint" data-p="${p.numero}">${ic('print')} Romaneio</button><button class="btn pri" data-act="pkShip" data-p="${p.numero}">Confirmar expedição</button>`:`<button class="btn" data-act="pkPrint" data-p="${p.numero}">${ic('print')} Imprimir</button>`;
  openDrawer(`Picking ${p.numero}`,body,foot,{wide:true});
  $$('.sepIn').forEach(i=>i.onchange=()=>{const a=p.linhas[+i.dataset.li].aloc[+i.dataset.ai];const v=parseNum(i.value)||0;if(v>a.qtd){toast('Separado não pode exceder o alocado','bad');i.value=a.sep||'';return}a.sep=v;if(p.status==='ABERTO')p.status='EM_SEPARACAO';save()});
  const sc=$('#pkScan');if(sc){let cur=null;sc.onkeydown=e=>{if(e.key!=='Enter')return;const v=sc.value.trim().toUpperCase();sc.value='';
    const byEnd=steps.find(s=>(s.a.endereco.toUpperCase()===v||(s.a.deposito+'/'+s.a.endereco).toUpperCase()===v)&&(s.a.sep||0)<s.a.qtd);
    if(byEnd){cur=byEnd;$$('.step').forEach(x=>x.style.outline='');const el=$(`[data-step="${byEnd.li}:${byEnd.ai}"]`);el.style.outline='2px solid var(--brand)';el.scrollIntoView({block:'center',behavior:'smooth'});$('#pkScanMsg').textContent=`Endereço ${byEnd.a.endereco} ok — bipe o material ${byEnd.l.material}${byEnd.a.lote?' / lote '+byEnd.a.lote:''}`;return}
    if(cur){const M=mat(cur.l.material);if([cur.l.material,M.ean,cur.a.lote,cur.l.material+'|'+cur.a.lote].map(x=>String(x||'').toUpperCase()).includes(v)){cur.a.sep=cur.a.qtd;if(p.status==='ABERTO')p.status='EM_SEPARACAO';save();toast(`${cur.l.material} confirmado`,'ok');pickDrawer(p.numero);return}
      toast(`Leitura "${v}" não corresponde ao item esperado (${cur.l.material}${cur.a.lote?' / '+cur.a.lote:''})`,'bad');return}
    toast('Bipe primeiro um endereço da rota','bad')};setTimeout(()=>sc.focus(),250)}
}
function pickFinish(n){
  const p=S.pickings.find(x=>x.numero===n);const movs=[];
  p.linhas.forEach(l=>l.aloc.forEach(a=>{const q=r3(a.sep||0);if(q<=0)return;
    if(p.modo==='CONSUMO')movs.push({tipo:'PICKING',material:l.material,lote:a.lote,deposito:a.deposito,endereco:a.endereco,tipoEstoque:a.tipoEstoque,ordem:a.ordem,qtd:-q,obs:`Consumo ${p.ordem||''} ${p.numero}`,_fromPicking:true});
    else movs.push(...transferMovs({tipo:'PICKING_TR',material:l.material,lote:a.lote,de:{dep:a.deposito,end:a.endereco,tipoEstoque:a.tipoEstoque,ordem:a.ordem},para:{dep:p.destino.dep,end:p.destino.end,tipoEstoque:a.tipoEstoque,ordem:a.ordem},qtd:q,obs:p.numero,_fromPicking:true}))}));
  if(!movs.length)return toast('Nada separado — informe as quantidades','bad');
  const tot=p.linhas.reduce((s,l)=>s+l.qtd,0),sep=p.linhas.reduce((s,l)=>s+l.aloc.reduce((a,x)=>a+(x.sep||0),0),0);
  const go=()=>{try{postDoc(movs,{doc:p.numero,tipoDoc:p.modo==='CONSUMO'?'SAIDA':'TRANSFERENCIA'});p.status=p.modo==='CONSUMO'||dep(p.destino.dep)?.tipo!=='EXPEDICAO'?'CONCLUIDO':'SEPARADO';p.fim=Date.now();
    if(p.ordem&&ord(p.ordem))ord(p.ordem).status='EM_ATENDIMENTO';save();closeDrawer();toast(`${p.numero} finalizado`,'ok');render()}catch(e){toast(e.message,'bad')}};
  if(sep<tot-1e-9)confirmBox('Separação parcial',`Foram separados <b>${fmt(sep)}</b> de <b>${fmt(tot)}</b>. O saldo não separado volta a ficar disponível e a diferença fica registrada como corte no picking.`,'Finalizar parcial').then(v=>v&&go());else go();
}

/* ---------- M4 · INVENTÁRIO & KARDEX ---------- */
VIEWS.inventario=()=>{
  const t=curTab('inv','cont');
  const head=tabs('inv',[['cont','Contagens'],['kardex','Kardex'],['acur','Acuracidade']]);
  if(t==='cont')return head+tbl('inv',[{t:'Número',k:'numero',cls:'mono'},{t:'Criado',v:r=>tsBR(r.criado),s:r=>r.criado},{t:'Escopo',k:'escopo'},{t:'Cega',v:r=>r.cega?'Sim':'Não'},{t:'Linhas',v:r=>r.linhas.length,num:true},
    {t:'Contadas',v:r=>r.linhas.filter(l=>l.contado!=null).length,num:true},{t:'Divergentes',v:r=>r.linhas.filter(l=>l.contado!=null&&r3(l.contado)!==r3(l.sistema)).length,num:true},
    {t:'Impacto',v:r=>brl(r.linhas.reduce((s,l)=>s+(l.contado!=null?(l.contado-l.sistema)*(mat(l.material)?.custo||0):0),0)),num:true},{t:'Status',h:r=>stPill(r.status),v:r=>r.status}],
    [...S.inventarios].sort((a,b)=>b.criado-a.criado),{onRow:r=>invDrawer(r.numero),empty:'Nenhuma contagem',tools:`<button class="btn pri" data-act="invNew">${ic('plus')} Nova contagem</button><button class="btn" data-act="invCiclico">Gerar cíclico ABC</button>`});
  if(t==='kardex'){const m=sub.kmat||S.materiais[0]?.codigo;const M=mat(m);let saldo=0;
    const rows=S.movs.filter(x=>x.material===m).sort((a,b)=>a.ts-b.ts).map(x=>{saldo=r3(saldo+x.qtd);return{...x,saldo}}).reverse();
    return head+`<div class="toolbar"><select class="flt" data-act="kmat" style="min-width:320px">${matOpts(false).map(([v,t])=>`<option value="${v}" ${v===m?'selected':''}>${esc(t)}</option>`).join('')}</select><span class="muted sm">Saldo atual <b>${fmt(saldoMat(m))} ${M?.um||''}</b> · custo médio <b>${brl(M?.custo)}</b> · ABC <b>${M?.abc}</b> · XYZ <b>${xyz(m).cls}</b></span><button class="btn" data-act="exportKardex" data-m="${m}" style="margin-left:auto">${ic('dl')} Exportar</button></div>`+
    tbl('kdx',[{t:'Data/hora',v:r=>tsBR(r.ts),s:r=>r.ts},{t:'Tipo',k:'tipo'},{t:'Documento',k:'doc',cls:'mono'},{t:'Lote',k:'lote',cls:'mono'},{t:'Dep/End',v:r=>r.deposito+'/'+(r.endereco||'—'),cls:'mono'},{t:'Estoque',h:r=>tePill(r.tipoEstoque,r.ordem),v:r=>r.tipoEstoque},
      {t:'Entrada',v:r=>r.qtd>0?fmt(r.qtd):'',num:true},{t:'Saída',v:r=>r.qtd<0?fmt(-r.qtd):'',num:true},{t:'Saldo',h:r=>`<b>${fmt(r.saldo)}</b>`,s:r=>r.saldo,num:true},{t:'Custo un.',v:r=>brl(r.custo),num:true},{t:'Usuário',k:'user'}],rows,{search:true,limit:300})}
  if(t==='acur'){const byC={A:{t:0,o:0},B:{t:0,o:0},C:{t:0,o:0}};S.inventarios.filter(i=>i.status==='APROVADO').forEach(i=>i.linhas.forEach(l=>{if(l.contado==null)return;const c=mat(l.material)?.abc||'C';byC[c].t++;const dv=l.sistema?Math.abs(l.contado-l.sistema)/l.sistema:(l.contado?1:0);if(dv<=S.cfg.toleranciaInv)byC[c].o++}));
    return head+`<div class="grid g4">${['A','B','C'].map(c=>`<div class="kpi"><div class="l">Classe ${c}</div><div class="v">${byC[c].t?pct(byC[c].o/byC[c].t):'—'}</div><div class="s">${byC[c].t} contagem(ns) · meta ${c==='A'?'99,5%':c==='B'?'98%':'95%'}</div></div>`).join('')}<div class="kpi lead"><div class="l">Geral</div><div class="v">${acuracidade()==null?'—':pct(acuracidade())}</div><div class="s">tolerância ±${pct(S.cfg.toleranciaInv)}</div></div></div>
    <div class="card" style="margin-top:12px"><div class="bd sm muted">Frequência recomendada do cíclico: A = mensal, B = trimestral, C = semestral. O botão "Gerar cíclico ABC" seleciona os itens A que não foram contados nos últimos 30 dias, B em 90 e C em 180.</div></div>`}
};
function invNewDrawer(){
  const grps=[...new Set(S.materiais.map(m=>m.grupo))];
  openDrawer('Nova contagem de inventário',`<form id="invF"><div class="fg">${F('Depósito','dep',{opts:[['','Todos'],...S.depositos.map(d=>[d.codigo,d.codigo+' · '+d.nome])]})}${F('Classe ABC','abc',{opts:[['','Todas'],'A','B','C']})}
   ${F('Grupo de material','grp',{opts:[['','Todos'],...grps]})}${F('Material específico','material',{opts:[['','Todos'],...matOpts(false)]})}
   ${F('Endereço (prefixo, ex.: A-01)','endp',{ph:'opcional'})}${F('Contagem cega (oculta saldo do sistema)','cega',{type:'checkbox',value:S.cfg.contagemCega})}</div>
   <div class="xs muted" style="margin-top:8px">O saldo do sistema é congelado no momento da criação. Movimentações posteriores na mesma posição são sinalizadas na aprovação.</div></form>`,
   `<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn pri" data-act="invCreate">Criar contagem</button>`);
}
function invCreate(filt,escopo){
  const rows=balanceRows().filter(b=>(!filt.dep||b.deposito===filt.dep)&&(!filt.abc||mat(b.material)?.abc===filt.abc)&&(!filt.grp||mat(b.material)?.grupo===filt.grp)&&(!filt.material||b.material===filt.material)&&(!filt.endp||b.endereco.startsWith(filt.endp))&&(!filt.mats||filt.mats.includes(b.material)));
  if(!rows.length)return toast('Nenhuma posição com saldo no escopo','bad');
  const i={numero:nextSeq('INV'),criado:Date.now(),escopo:escopo||Object.entries(filt).filter(([k,v])=>v&&k!=='cega').map(([k,v])=>`${k}=${Array.isArray(v)?v.length+' itens':v}`).join(' · ')||'Geral',cega:!!filt.cega,status:'EM_CONTAGEM',
    linhas:rows.map(b=>({material:b.material,lote:b.lote,deposito:b.deposito,endereco:b.endereco,tipoEstoque:b.tipoEstoque,ordem:b.ordem,sistema:b.qtd,contado:null,recontagem:null,obs:''}))};
  S.inventarios.push(i);audit('CRIAR','INVENTARIO',i.numero,i.linhas.length+' linhas');save();closeDrawer();render();invDrawer(i.numero);
}
function invDrawer(n){
  const inv=S.inventarios.find(x=>x.numero===n);const ed=inv.status==='EM_CONTAGEM'||inv.status==='EM_REVISAO';const hide=inv.cega&&inv.status==='EM_CONTAGEM';
  const body=`<div class="row" style="margin-bottom:8px"><span class="mono">${inv.numero}</span>${stPill(inv.status)}<span class="muted sm">${esc(inv.escopo)}</span>${inv.cega?P('CEGA','info'):''}</div>
  ${ed?`<div class="row" style="margin-bottom:8px"><input id="invScan" class="grow" style="padding:8px;border:1px solid var(--line);border-radius:6px;font-family:var(--fm)" placeholder="Bipe material/lote para ir até a linha…"><button class="btn sm" data-act="invAddLine" data-n="${n}">+ Item encontrado</button></div>`:''}
  <div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Posição</th><th>Material</th><th>Lote</th>${hide?'':'<th class="num">Sistema</th>'}<th class="num">Contado</th><th class="num">Recontagem</th>${hide?'':'<th class="num">Dif.</th><th class="num">R$</th>'}</tr></thead><tbody>
  ${inv.linhas.map((l,ix)=>{const fin=l.recontagem??l.contado;const d=fin==null?null:r3(fin-l.sistema);const big=d!=null&&l.sistema&&Math.abs(d)/l.sistema>S.cfg.toleranciaInv;return`<tr data-il="${ix}"><td class="mono">${l.deposito}/${esc(l.endereco||'—')}</td><td>${matLabel(l.material)} ${l.tipoEstoque==='ORDEM'?tePill('ORDEM',l.ordem):''}</td><td class="mono">${esc(l.lote||'—')}</td>${hide?'':`<td class="num">${fmt(l.sistema)}</td>`}
   <td class="num">${ed?`<input type="number" step="any" class="invIn" data-ix="${ix}" data-f="contado" value="${l.contado??''}" style="width:90px;text-align:right;padding:5px;border:1px solid var(--line);border-radius:4px">`:fmt(l.contado)}</td>
   <td class="num">${ed&&!hide&&l.contado!=null&&big?`<input type="number" step="any" class="invIn" data-ix="${ix}" data-f="recontagem" value="${l.recontagem??''}" style="width:90px;text-align:right;padding:5px;border:1px solid var(--warn);border-radius:4px">`:l.recontagem!=null?fmt(l.recontagem):'—'}</td>
   ${hide?'':`<td class="num" style="color:${d?(d<0?'var(--bad)':'var(--ok)'):'inherit'}">${d==null?'—':(d>0?'+':'')+fmt(d)}${big?' ⚠':''}</td><td class="num">${d==null?'—':brl(d*(mat(l.material)?.custo||0))}</td>`}</tr>`}).join('')}</tbody></table></div>
  <div class="xs muted" style="margin-top:6px">Divergência acima da tolerância (±${pct(S.cfg.toleranciaInv)}) exige recontagem antes da aprovação. A aprovação gera movimentos de AJUSTE auditáveis.</div>`;
  const foot=inv.status==='EM_CONTAGEM'?`<button class="btn dan" data-act="invCancel" data-n="${n}">Cancelar</button><button class="btn" data-act="invPrint" data-n="${n}">${ic('print')} Folha de contagem</button><button class="btn pri" data-act="invClose" data-n="${n}">Encerrar contagem</button>`
   :inv.status==='EM_REVISAO'?`<button class="btn" data-act="invReopen" data-n="${n}">Reabrir</button><button class="btn pri" data-act="invApprove" data-n="${n}">${ic('lock')} Aprovar e ajustar</button>`:'';
  openDrawer(`Inventário ${n}`,body,foot,{wide:true});
  $$('.invIn').forEach(i=>i.onchange=()=>{const l=inv.linhas[+i.dataset.ix];const v=i.value===''?null:parseNum(i.value);if(v!=null&&(isNaN(v)||v<0)){toast('Valor inválido','bad');return}l[i.dataset.f]=v;save();if(!hide)invDrawer(n)});
  const sc=$('#invScan');if(sc)sc.onkeydown=e=>{if(e.key!=='Enter')return;const v=sc.value.trim().toUpperCase();sc.value='';const ix=inv.linhas.findIndex(l=>[l.material,l.lote,mat(l.material)?.ean,l.endereco].map(x=>String(x||'').toUpperCase()).includes(v));if(ix<0)return toast('Não encontrado nesta contagem — use "+ Item encontrado"','bad');const inp=$(`.invIn[data-ix="${ix}"]`);inp.scrollIntoView({block:'center'});inp.focus();inp.select()};
}
function invApprove(n){
  const inv=S.inventarios.find(x=>x.numero===n);
  const pend=inv.linhas.filter(l=>{const fin=l.recontagem??l.contado;return fin!=null&&l.sistema&&Math.abs(fin-l.sistema)/l.sistema>S.cfg.toleranciaInv&&l.recontagem==null});
  if(pend.length)return toast(`${pend.length} linha(s) acima da tolerância sem recontagem`,'bad');
  const movs=[];inv.linhas.forEach(l=>{const fin=l.recontagem??l.contado;if(fin==null)return;const d=r3(fin-l.sistema);if(!d)return;
    if(l.lote&&!lot(l.material,l.lote))S.lotes.push({material:l.material,lote:l.lote,fabricacao:'',validade:'',fornecedor:'',status:'LIBERADO'});
    movs.push({tipo:'AJUSTE',material:l.material,lote:l.lote,deposito:l.deposito,endereco:l.endereco,tipoEstoque:l.tipoEstoque,ordem:l.ordem,qtd:d,obs:`Inventário ${n}`,ignoraStatusLote:true})});
  const moved=inv.linhas.filter(l=>S.movs.some(m=>m.ts>inv.criado&&balKey(m)===[l.material,l.lote||'',l.deposito,l.endereco||'',l.tipoEstoque,l.ordem||''].join('|'))).length;
  const imp=movs.reduce((s,m)=>s+m.qtd*(mat(m.material)?.custo||0),0);
  confirmBox('Aprovar inventário',`Serão lançados <b>${movs.length}</b> ajuste(s) com impacto de <b>${brl(imp)}</b> no valor do estoque.${moved?`<br><br><b style="color:var(--warn)">${moved} posição(ões) tiveram movimentação após o congelamento</b> — o ajuste aplica a diferença contra o saldo congelado.`:''}`,'Aprovar e lançar').then(ok=>{if(!ok)return;
    try{if(movs.length)postDoc(movs,{doc:n,tipoDoc:'AJUSTE'});inv.status='APROVADO';inv.aprovado=Date.now();audit('APROVAR','INVENTARIO',n,brl(imp));save();closeDrawer();toast('Inventário aprovado','ok');render()}catch(e){toast(e.message,'bad')}});
}

/* ---------- M5 · PLANEJAMENTO & IA ---------- */
VIEWS.planejamento=()=>{
  const t=curTab('pl','rep');
  const head=tabs('pl',[['rep','Reposição (MRP)'],['req','Requisições de compra'],['matriz','Matriz ABC × XYZ'],['ia','Assistente IA']]);
  if(t==='rep'){const rows=reposicao();
    return head+tbl('rep',[{t:'',h:r=>r.sug>0&&!r.req?`<input type="checkbox" class="repSel" value="${r.m.codigo}">`:''},{t:'Material',h:r=>matLabel(r.m.codigo),v:r=>r.m.codigo+' '+r.m.descricao},{t:'ABC',v:r=>r.m.abc},{t:'XYZ',v:r=>r.xyz.cls},
      {t:'Disponível',v:r=>fmt(r.disp),s:r=>r.disp,num:true},{t:'Consumo/dia',v:r=>fmt(r.media,2),s:r=>r.media,num:true},{t:'Cobertura',h:r=>isFinite(r.cob)?`${fmt(r.cob,1)} d`:'∞',s:r=>isFinite(r.cob)?r.cob:1e9,num:true},
      {t:'Lead time',v:r=>r.m.leadTime+' d',s:r=>r.m.leadTime,num:true},{t:'Nec. ordens',h:r=>r.ordNec?`${fmt(r.ordNec)} <span class="muted xs">(seg. ${fmt(r.ordSeg)})</span>`:'—',s:r=>r.ordNec,num:true},
      {t:'Ponto pedido',v:r=>fmt(r.pp),num:true},{t:'Máx.',v:r=>fmt(r.m.maximo),num:true},{t:'Sugestão',h:r=>r.sug?`<b>${fmt(r.sug)}</b> ${r.m.um}`:'—',s:r=>r.sug,num:true},
      {t:'Situação',h:r=>stPill(r.crit)+(r.req?' '+P('REQ '+r.req.status,'br'):''),v:r=>r.crit}],rows.sort((a,b)=>({RUPTURA:0,REPOR:1,OK:2}[a.crit]-{RUPTURA:0,REPOR:1,OK:2}[b.crit])||a.cob-b.cob),
      {onRow:r=>matDrawer(r.m.codigo),tools:`<button class="btn pri" data-act="repGen">Gerar requisições (selecionados)</button><button class="btn" data-act="repAll">Selecionar sugeridos</button><button class="btn" data-act="exportRep">${ic('dl')} Exportar</button>`})+
      `<div class="xs muted" style="margin-top:6px">Ponto de pedido = máx(cadastro; consumo médio 60d × lead time × 1,3). Sugestão = máximo − (disponível − necessidade líquida das ordens). Necessidade líquida desconta o estoque já segregado por ordem.</div>`}
  if(t==='req')return head+tbl('req',[{t:'Número',k:'numero',cls:'mono'},{t:'Criada',v:r=>tsBR(r.criado),s:r=>r.criado},{t:'Origem',h:r=>P(r.origem,r.origem==='IA'?'br':'mut'),v:r=>r.origem},{t:'Material',h:r=>matLabel(r.material),v:r=>r.material},{t:'Qtd',v:r=>fmt(r.qtd),num:true},{t:'Valor est.',v:r=>brl(r.qtd*(mat(r.material)?.custo||0)),num:true},{t:'Necessidade',v:r=>dtBR(r.necessidade)},{t:'Justificativa',k:'justificativa'},{t:'Status',h:r=>stPill(r.status),v:r=>r.status},
    {t:'',h:r=>r.status==='PROPOSTA'?`<button class="btn sm pri" data-act="reqApprove" data-r="${r.numero}">Aprovar</button> <button class="btn sm dan" data-act="reqReject" data-r="${r.numero}">Rejeitar</button>`:r.status==='APROVADA'?`<button class="btn sm" data-act="reqSend" data-r="${r.numero}">Enviar ao ERP</button>`:''}],[...S.requisicoes].sort((a,b)=>b.criado-a.criado),{empty:'Nenhuma requisição'});
  if(t==='matriz'){const rep=reposicao();const cells={};rep.forEach(r=>{const k=r.m.abc+r.xyz.cls;(cells[k]=cells[k]||[]).push(r)});
    const pol={AX:'Reposição automática, estoque de segurança baixo',AY:'Revisão semanal, segurança moderada',AZ:'Sob encomenda/colaborativo — alto risco',BX:'Reposição periódica',BY:'Revisão quinzenal',BZ:'Segurança elevada ou MTO',CX:'Lote econômico, baixa atenção',CY:'Kanban / duas gavetas',CZ:'Avaliar descontinuação'};
    return head+`<div class="grid g3">${['A','B','C'].map(a=>['X','Y','Z'].map(x=>{const L=cells[a+x]||[];return`<div class="card"><div class="hd"><h3>${a}${x}</h3><span class="muted sm">${L.length} itens</span></div><div class="bd sm"><div class="muted" style="margin-bottom:6px">${pol[a+x]}</div>${L.slice(0,6).map(r=>`<div class="mono xs">${esc(r.m.codigo)} <span class="muted">${esc(r.m.descricao.slice(0,34))}</span></div>`).join('')}</div></div>`}).join('')).join('')}</div>
    <div class="xs muted" style="margin-top:6px">ABC por valor de consumo 90 dias (80/15/5). XYZ pelo coeficiente de variação da demanda diária 60 dias (X &lt; 0,5 ≤ Y &lt; 1 ≤ Z). <button class="btn sm" data-act="recalcABC">Recalcular ABC</button></div>`}
  if(t==='ia')return head+`<div class="card ai-box" style="max-width:900px"><div class="bd">${aiPanelHTML()}</div></div>`;
};
VIEWS.after_planejamento=()=>{if(curTab('pl','rep')==='ia')bindAIPanel()};

/* ---------- ASSISTENTE IA ---------- */
let SAMPLE=null; const AIH=[];
(async()=>{try{if(window.claude&&typeof window.claude.use==='function'){SAMPLE=await window.claude.use('sample');renderNav()}}catch(e){SAMPLE=null}})();
const AI_TOOLS=[
 {name:'buscar_material',description:'Busca materiais por código, descrição ou grupo. Retorna até 10.',inputSchema:{type:'object',properties:{termo:{type:'string'}},required:['termo']},
  execute:({termo})=>{const q=String(termo).toLowerCase();return S.materiais.filter(m=>(m.codigo+' '+m.descricao+' '+m.grupo).toLowerCase().includes(q)).slice(0,10).map(m=>({codigo:m.codigo,descricao:m.descricao,um:m.um,abc:m.abc}))}},
 {name:'consultar_saldo',description:'Saldo detalhado de um material por depósito, endereço, lote e tipo de estoque (NORMAL ou ORDEM), com disponível e reservado.',inputSchema:{type:'object',properties:{material:{type:'string'}},required:['material']},
  execute:({material})=>{const m=mat(material);if(!m)throw new Error('material não encontrado');const res=reservedMap();return{material:m.codigo,descricao:m.descricao,um:m.um,custoMedio:m.custo,minimo:m.minimo,disponivel:disponivel(m.codigo),posicoes:balanceRows({material:m.codigo}).map(b=>({deposito:b.deposito,endereco:b.endereco,lote:b.lote,status_lote:lot(m.codigo,b.lote)?.status||null,validade:lot(m.codigo,b.lote)?.validade||null,tipoEstoque:b.tipoEstoque,ordem:b.ordem||null,qtd:b.qtd,reservado:res.get(b.key)||0}))}}},
 {name:'listar_reposicao',description:'Itens em ruptura ou ponto de pedido com cobertura, consumo, necessidade das ordens e sugestão de compra.',inputSchema:{type:'object',properties:{}},
  execute:()=>reposicao().filter(r=>r.crit!=='OK').map(r=>({material:r.m.codigo,descricao:r.m.descricao,situacao:r.crit,disponivel:r.disp,consumo_dia:+r.media.toFixed(2),cobertura_dias:isFinite(r.cob)?+r.cob.toFixed(1):null,lead_time:r.m.leadTime,necessidade_ordens:r.ordNec,segregado_ordens:r.ordSeg,sugestao:r.sug,abc:r.m.abc,xyz:r.xyz.cls,requisicao_existente:r.req?.status||null}))},
 {name:'lotes_vencendo',description:'Lotes com saldo que vencem em até N dias (negativo = vencido).',inputSchema:{type:'object',properties:{dias:{type:'number'}},required:['dias']},execute:({dias})=>lotesVencendo(dias||30).map(l=>({material:l.material,lote:l.lote,validade:l.validade,dias:l.dias,qtd:l.qtd,status:l.status}))},
 {name:'status_ordem',description:'Cobertura de materiais de uma ordem (OP/OS/Projeto/OV): necessário, segregado, consumido e falta.',inputSchema:{type:'object',properties:{ordem:{type:'string'}},required:['ordem']},
  execute:({ordem})=>{const o=ord(ordem)||S.ordens.find(x=>x.numero.includes(ordem));if(!o)throw new Error('ordem não encontrada');return{numero:o.numero,tipo:o.tipo,descricao:o.descricao,status:o.status,entrega:o.entrega,itens:o.itens.map(i=>{const seg=balanceRows({material:i.material,tipoEstoque:'ORDEM',ordem:o.numero}).reduce((s,b)=>s+b.qtd,0);const cons=S.movs.filter(m=>m.ordem===o.numero&&m.material===i.material&&['PICKING','SAIDA'].includes(m.tipo)).reduce((s,m)=>s-m.qtd,0);return{material:i.material,necessario:i.qtd,segregado:seg,consumido:cons,disponivel_normal:disponivel(i.material),falta:Math.max(0,i.qtd-seg-cons)}})}}},
 {name:'resumo_kpis',description:'KPIs gerais do almoxarifado.',inputSchema:{type:'object',properties:{}},execute:()=>{const rep=reposicao();return{valor_estoque:Math.round(valorEstoque()),skus:S.materiais.length,ruptura:rep.filter(r=>r.crit==='RUPTURA').length,ponto_pedido:rep.filter(r=>r.crit==='REPOR').length,lotes_vencer_45d:lotesVencendo(45).length,pickings_abertos:S.pickings.filter(p=>['ABERTO','EM_SEPARACAO'].includes(p.status)).length,acuracidade:acuracidade(),fila_integracao:S.outbox.filter(o=>o.status!=='ENVIADO').length}}},
 {name:'propor_requisicao',description:'Cria uma PROPOSTA de requisição de compra que o usuário precisa aprovar. Não compra nada.',inputSchema:{type:'object',properties:{material:{type:'string'},qtd:{type:'number'},justificativa:{type:'string'}},required:['material','qtd','justificativa']},
  execute:({material,qtd,justificativa})=>{if(ME&&ME.papel==='CONSULTA')throw new Error('perfil CONSULTA não pode propor requisições');if(!mat(material))throw new Error('material inexistente');const r=newReq(material,qtd,'IA',justificativa);return{criada:r.numero,status:'PROPOSTA — aguarda aprovação humana'}}}
];
function newReq(material,qtd,origem,just){const m=mat(material);const r={numero:nextSeq('RQC'),criado:Date.now(),origem,material,qtd:Math.ceil(qtd),necessidade:addDays(todayISO(),m.leadTime),justificativa:just||'',status:'PROPOSTA'};S.requisicoes.push(r);audit('PROPOR','REQUISICAO',r.numero,`${origem}: ${material} ${qtd}`);save();return r}
const AI_SYS=()=>`Você é o assistente de gestão de materiais do GPlanSiS|WHOUSE (almoxarifado/WMS industrial). Responda em português do Brasil, direto e técnico, com números e códigos exatos obtidos pelas ferramentas — nunca invente saldo, lote ou data. Hoje é ${dtBR(todayISO())}. Estratégia de saída: ${S.cfg.estrategia}. Conceitos: estoque NORMAL (livre) e ORDEM (stock by order, segregado e só consumível pela ordem dona); lotes em QUARENTENA/BLOQUEADO não saem. Regra de governança: a IA propõe, o humano decide — você pode criar apenas PROPOSTAS de requisição com propor_requisicao e deve dizer que exigem aprovação. Formate em texto simples com listas curtas; sem markdown pesado.`;
function aiPanelHTML(){return`<div class="chat" id="aiChat" style="min-height:220px;max-height:52vh;overflow:auto;margin-bottom:10px">${AIH.length?AIH.map(m=>`<div class="msg ${m.role==='user'?'u':'a'}">${m.tools?`<span class="tool">${esc(m.tools)}</span>`:''}${esc(m.content)}</div>`).join(''):`<div class="muted sm">Pergunte sobre saldos, rupturas, lotes, ordens ou peça propostas de compra.<br><br><b>Exemplos:</b></div><div class="row">${['O que está em risco de ruptura esta semana?','Status da OP-2026-0101','Quais lotes vencem em 60 dias?','Proponha requisições para os itens classe A em ruptura'].map(q=>`<button class="btn sm" data-act="aiAsk" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}</div>
  <div class="row"><textarea id="aiIn" rows="2" class="grow" style="padding:8px;border:1px solid var(--line);border-radius:6px;resize:vertical;background:var(--panel)" placeholder="Pergunte ao assistente… (Enter envia)"></textarea><button class="btn pri" data-act="aiSend">Enviar</button></div>
  <div class="xs muted" style="margin-top:6px">${API.on?(ME?.ia?`Conectado ao Claude (${esc(ME.iaModelo||'')}) pelo servidor — ferramentas sobre os dados da base.`:'IA não configurada no servidor — respostas pelo motor local de regras.'):SAMPLE?'Conectado ao Claude — consultas usam ferramentas sobre os dados locais.':'Claude indisponível nesta visualização — respostas pelo motor local de regras.'} A IA só cria propostas; aprovação é sempre humana.</div>`}
function bindAIPanel(){const i=$('#aiIn');if(!i)return;i.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();aiSend()}};const c=$('#aiChat');c.scrollTop=c.scrollHeight}
function refreshAI(){const c=$('#aiChat');if(!c)return;const parent=c.parentElement;const val=$('#aiIn')?.value||'';parent.innerHTML=aiPanelHTML();$('#aiIn').value=val;bindAIPanel()}
let aiBusy=false;
async function aiSend(q){
  const inp=$('#aiIn');q=q||inp?.value.trim();if(!q||aiBusy)return;if(inp)inp.value='';
  AIH.push({role:'user',content:q});const ans={role:'assistant',content:'Pensando…',tools:''};AIH.push(ans);refreshAI();aiBusy=true;
  try{
    if(API.on&&ME?.ia){ans.content=await aiServer(ans)}
    else if(SAMPLE){
      const turns=AIH.slice(0,-1).filter(m=>m.content&&m.content!=='Pensando…').slice(-10).map((m,i,a)=>({role:m.role,content:(i===a.length-1?AI_SYS()+'\n\nPergunta: ':'')+m.content}));
      const used=[];const tools=AI_TOOLS.map(t=>({...t,execute:async inp=>{used.push(t.name);ans.tools='ferramentas: '+used.join(', ');refreshAI();return t.execute(inp)}}));
      const r=await SAMPLE(turns,{tools,cache:false,onText:({text})=>{ans.content=text;refreshAI()}});
      ans.content=r.text||ans.content;
    }else{ans.content=localAI(q);ans.tools='motor local'}
  }catch(e){ans.content=(e.text?e.text+'\n\n':'')+(e.code==='not_granted'?'Permissão para a IA negada nesta visualização. Usando motor local:\n\n'+localAI(q):'Falha na IA ('+(e.code||e.message)+'). Resposta local:\n\n'+localAI(q))}
  aiBusy=false;refreshAI();if(route==='planejamento')renderNav();
}
function localAI(q){
  const s=q.toLowerCase();const m=S.materiais.find(x=>s.includes(x.codigo.toLowerCase()));const o=S.ordens.find(x=>s.includes(x.numero.toLowerCase()));
  if(o){const r=AI_TOOLS.find(t=>t.name==='status_ordem').execute({ordem:o.numero});return`${r.numero} · ${r.descricao} (${r.status}) · entrega ${dtBR(r.entrega)}\n`+r.itens.map(i=>`- ${i.material}: nec ${fmt(i.necessario)} | segregado ${fmt(i.segregado)} | consumido ${fmt(i.consumido)} | falta ${fmt(i.falta)} (disponível normal ${fmt(i.disponivel_normal)})`).join('\n')}
  if(m){const r=AI_TOOLS[1].execute({material:m.codigo});return`${r.material} · ${r.descricao}\nDisponível: ${fmt(r.disponivel)} ${r.um} (mínimo ${fmt(r.minimo)})\n`+r.posicoes.map(p=>`- ${p.deposito}/${p.endereco||'—'} ${p.lote||''} ${p.tipoEstoque}${p.ordem?' '+p.ordem:''}: ${fmt(p.qtd)}${p.reservado?' (reserv. '+fmt(p.reservado)+')':''}`).join('\n')}
  if(/venc|validade|fefo/.test(s)){const d=+(s.match(/(\d+)\s*dias?/)||[])[1]||S.cfg.diasVencAlerta;const L=lotesVencendo(d);return L.length?`Lotes com saldo vencendo em até ${d} dias:\n`+L.map(l=>`- ${l.lote} (${l.material}): ${l.dias<0?'VENCIDO':l.dias+' dias'} · ${fmt(l.qtd)}`).join('\n'):`Nenhum lote vence em ${d} dias.`}
  if(/propon|requisi|compr/.test(s)){const R=reposicao().filter(r=>r.sug>0&&!r.req&&(!/classe a/.test(s)||r.m.abc==='A'));if(!R.length)return'Nenhum item elegível para proposta.';R.forEach(r=>newReq(r.m.codigo,r.sug,'IA',`Motor local: ${r.crit}, cobertura ${isFinite(r.cob)?r.cob.toFixed(1)+'d':'—'}`));return`Criei ${R.length} proposta(s) de requisição (status PROPOSTA). Aprove em Planejamento → Requisições:\n`+R.map(r=>`- ${r.m.codigo}: ${fmt(r.sug)} ${r.m.um}`).join('\n')}
  if(/ruptur|repor|risco|falt|m[ií]nimo/.test(s)){const R=reposicao().filter(r=>r.crit!=='OK');return R.length?'Itens em risco:\n'+R.map(r=>`- ${r.m.codigo} ${r.crit}: disp ${fmt(r.disp)} · cobertura ${isFinite(r.cob)?fmt(r.cob,1)+'d':'∞'} · LT ${r.m.leadTime}d · sugestão ${fmt(r.sug)}`).join('\n'):'Nenhum item em ruptura ou ponto de pedido.'}
  const k=AI_TOOLS.find(t=>t.name==='resumo_kpis').execute({});return`Resumo: valor ${brl(k.valor_estoque)} · ${k.skus} SKUs · ruptura ${k.ruptura} · ponto de pedido ${k.ponto_pedido} · lotes a vencer 45d ${k.lotes_vencer_45d} · pickings abertos ${k.pickings_abertos} · fila integração ${k.fila_integracao}.\nPergunte por um código de material, número de ordem, validade ou ruptura.`;
}
async function aiInsights(){
  const box=$('#aiInsights');if(API.on&&ME?.ia)return aiInsightsServer(box);if(!SAMPLE){box.innerHTML=localInsights().map(t=>`<div style="padding:4px 0;border-bottom:1px solid var(--line2)">${t}</div>`).join('')+'<div class="xs muted" style="margin-top:6px">Claude indisponível nesta visualização — motor local.</div>';return}
  box.innerHTML='<div class="muted">Analisando dados…</div>';
  const data={kpis:AI_TOOLS.find(t=>t.name==='resumo_kpis').execute({}),reposicao:AI_TOOLS.find(t=>t.name==='listar_reposicao').execute({}).slice(0,12),lotes:lotesVencendo(60).slice(0,8).map(l=>({lote:l.lote,material:l.material,dias:l.dias,qtd:l.qtd})),ordens:S.ordens.filter(o=>o.status!=='ENCERRADA').map(o=>AI_TOOLS.find(t=>t.name==='status_ordem').execute({ordem:o.numero}))};
  try{const r=await SAMPLE.json(`${AI_SYS()}\nAnalise os dados e devolva APENAS JSON: {"insights":[{"nivel":"critico|atencao|info","texto":"frase curta com códigos e números"}]} com 4 a 6 itens priorizados.\nDADOS:${JSON.stringify(data)}`,{modelTier:'quick'});
    const ico={critico:'🔴',atencao:'🟠',info:'🔵'};box.innerHTML=(r.insights||[]).map(x=>`<div style="padding:4px 0;border-bottom:1px solid var(--line2)">${ico[x.nivel]||'•'} ${esc(x.texto)}</div>`).join('')+'<div class="xs muted" style="margin-top:6px">Gerado pelo Claude sobre os dados atuais. Verifique antes de agir.</div>';
  }catch(e){box.innerHTML=localInsights().map(t=>`<div style="padding:4px 0">${t}</div>`).join('')+`<div class="xs muted">IA indisponível (${esc(e.code||e.message)}) — motor local.</div>`}
}

/* ---------- CADASTROS ---------- */
VIEWS.cadastros=()=>{
  const t=curTab('cad','mat');
  const head=tabs('cad',[['mat','Materiais'],['dep','Depósitos'],['end','Endereços'],['lot','Lotes'],['ord','Ordens (OP/OS/OV/Projeto)']]);
  if(t==='mat')return head+tbl('cmat',[{t:'Código',k:'codigo',cls:'mono'},{t:'Descrição',k:'descricao'},{t:'UM',k:'um'},{t:'Grupo',k:'grupo'},{t:'ABC',k:'abc'},{t:'Lote',v:m=>m.controlaLote?'Sim':'—'},{t:'Validade',v:m=>m.controlaValidade?'Sim':'—'},
    {t:'Mín.',v:m=>fmt(m.minimo),s:m=>m.minimo,num:true},{t:'P. pedido',v:m=>fmt(m.pontoPedido),num:true},{t:'Máx.',v:m=>fmt(m.maximo),num:true},{t:'Custo médio',v:m=>brl(m.custo),s:m=>m.custo,num:true},{t:'Saldo',v:m=>fmt(saldoMat(m.codigo)),s:m=>saldoMat(m.codigo),num:true},{t:'Ativo',h:m=>m.ativo?P('ativo','ok'):P('inativo','mut'),v:m=>m.ativo}],S.materiais,{onRow:m=>matDrawer(m.codigo),tools:`<button class="btn pri" data-act="matNew">${ic('plus')} Material</button>`});
  if(t==='dep')return head+tbl('cdep',[{t:'Código',k:'codigo',cls:'mono'},{t:'Nome',k:'nome'},{t:'Tipo',k:'tipo'},{t:'Cód. ERP',k:'erp',cls:'mono'},{t:'Responsável',k:'resp'},{t:'Endereços',v:d=>S.enderecos.filter(e=>e.deposito===d.codigo).length,num:true},{t:'Valor',v:d=>brl(balanceRows({deposito:d.codigo}).reduce((s,b)=>s+b.qtd*(mat(b.material)?.custo||0),0)),num:true},{t:'Ativo',h:d=>d.ativo?P('ativo','ok'):P('inativo','mut'),v:d=>d.ativo}],S.depositos,{onRow:d=>depDrawer(d.codigo),tools:`<button class="btn pri" data-act="depNew">${ic('plus')} Depósito</button>`});
  if(t==='end')return head+tbl('cend',[{t:'Depósito',k:'deposito',cls:'mono'},{t:'Endereço',k:'codigo',cls:'mono'},{t:'Tipo',k:'tipo'},{t:'Capacidade',v:e=>fmt(e.capacidade),num:true},{t:'Ocupado',v:e=>fmt(ocupacao().get(e.deposito+'|'+e.codigo)||0),num:true},{t:'Ativo',h:e=>e.ativo?P('ativo','ok'):P('inativo','mut'),v:e=>e.ativo}],S.enderecos,{onRow:e=>endDrawer(e.deposito,e.codigo),tools:`<button class="btn pri" data-act="endNew">${ic('plus')} Endereço</button><button class="btn" data-act="endBulk">Gerar em lote</button>`});
  if(t==='lot')return head+tbl('clot',[{t:'Material',k:'material',cls:'mono'},{t:'Lote',k:'lote',cls:'mono'},{t:'Fabricação',v:l=>dtBR(l.fabricacao)},{t:'Validade',v:l=>dtBR(l.validade),s:l=>l.validade},{t:'Fornecedor',k:'fornecedor'},{t:'Status',h:l=>stPill(l.status),v:l=>l.status}],S.lotes,{onRow:l=>lotDrawer(l.material,l.lote),tools:`<button class="btn pri" data-act="lotNew">${ic('plus')} Lote</button>`});
  if(t==='ord')return head+tbl('cord',[{t:'Número',k:'numero',cls:'mono'},{t:'Tipo',h:o=>P(o.tipo,'ord'),v:o=>o.tipo},{t:'Descrição',k:'descricao'},{t:'Cliente/CC',k:'cliente'},{t:'Entrega',v:o=>dtBR(o.entrega),s:o=>o.entrega},{t:'Itens',v:o=>o.itens.length,num:true},{t:'Status',h:o=>stPill(o.status),v:o=>o.status}],S.ordens,{onRow:o=>ordDrawer(o.numero),tools:`<button class="btn pri" data-act="ordNew">${ic('plus')} Ordem</button>`});
};
function matDrawer(code){
  const m=code?mat(code):{codigo:'',descricao:'',um:'UN',grupo:'',controlaLote:false,controlaValidade:false,minimo:0,pontoPedido:0,maximo:0,custo:0,ncm:'',ean:'',leadTime:7,ativo:true};
  const bal=code?balanceRows({material:code}):[];const c=code?consumo(code,60):null;
  const body=`<form id="matF">${code?`<div class="grid g3" style="margin-bottom:10px"><div class="kpi"><div class="l">Saldo</div><div class="v">${fmt(saldoMat(code))}</div><div class="s">${m.um}</div></div><div class="kpi"><div class="l">Disponível</div><div class="v">${fmt(disponivel(code))}</div></div><div class="kpi"><div class="l">Consumo/dia</div><div class="v">${fmt(c.media,2)}</div><div class="s">ABC ${m.abc} · XYZ ${xyz(code).cls}</div></div></div>`:''}
  <div class="fg">${F('Código','codigo',{value:m.codigo,req:true,readonly:!!code})}${F('Unidade de medida','um',{value:m.um,opts:['UN','PC','PR','KG','G','M','M2','M3','L','ML','CX','RL','JG'],req:true})}${F('Descrição','descricao',{value:m.descricao,req:true,full:true})}
  ${F('Grupo','grupo',{value:m.grupo,list:'grpList'})}<datalist id="grpList">${[...new Set(S.materiais.map(x=>x.grupo))].map(g=>`<option value="${esc(g)}">`).join('')}</datalist>${F('NCM','ncm',{value:m.ncm})}${F('EAN / GTIN','ean',{value:m.ean})}${F('Lead time (dias)','leadTime',{type:'number',value:m.leadTime})}
  ${F('Estoque mínimo','minimo',{type:'number',step:'any',value:m.minimo})}${F('Ponto de pedido','pontoPedido',{type:'number',step:'any',value:m.pontoPedido})}${F('Estoque máximo','maximo',{type:'number',step:'any',value:m.maximo})}${F('Custo médio (R$)','custo',{type:'number',step:'any',value:m.custo,readonly:!!code&&saldoMat(code)>0,help:code&&saldoMat(code)>0?'Calculado pelas entradas (média ponderada)':''})}
  ${F('Controla lote','controlaLote',{type:'checkbox',value:m.controlaLote})}${F('Controla validade (FEFO)','controlaValidade',{type:'checkbox',value:m.controlaValidade})}${F('Ativo','ativo',{type:'checkbox',value:m.ativo})}</div>
  ${bal.length?`<div class="sect">Posições</div><table class="t"><thead><tr><th>Dep/End</th><th>Lote</th><th>Estoque</th><th class="num">Qtd</th></tr></thead><tbody>${bal.map(b=>`<tr><td class="mono">${b.deposito}/${esc(b.endereco||'—')}</td><td class="mono">${esc(b.lote||'—')}</td><td>${tePill(b.tipoEstoque,b.ordem)}</td><td class="num">${fmt(b.qtd)}</td></tr>`).join('')}</tbody></table>`:''}
  ${code?`<div class="sect">Etiqueta</div><div class="lbl" style="max-width:300px">${labelHTML(code,m.descricao,m.um)}</div>`:''}</form>`;
  openDrawer(code?`Material ${code}`:'Novo material',body,`${code?`<button class="btn" data-act="goKardex" data-m="${code}">Kardex</button><button class="btn" data-act="movNew" data-t="TRANSFERENCIA" data-m="${code}">Movimentar</button>`:''}<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn pri" data-act="matSave" data-m="${code}">Salvar</button>`);
}
function matSave(code){const f=$('#matF');const o=readForm(f);clearErr(f);
  if(!o.codigo)return fieldErr(f,'codigo','Obrigatório');if(!code&&mat(o.codigo))return fieldErr(f,'codigo','Código já existe');if(!o.descricao)return fieldErr(f,'descricao','Obrigatório');
  const num=k=>{const v=parseNum(o[k]||0);return isNaN(v)?0:v};
  if(num('maximo')&&num('minimo')>num('maximo'))return fieldErr(f,'minimo','Mínimo maior que o máximo');
  if(code){const m=mat(code);if(m.controlaLote&&!o.controlaLote&&balanceRows({material:code}).some(b=>b.lote))return toast('Há saldo com lote — não é possível desligar o controle de lote','bad')}
  const rec={codigo:o.codigo.toUpperCase(),descricao:o.descricao,um:o.um,grupo:o.grupo||'Geral',ncm:o.ncm,ean:o.ean,leadTime:num('leadTime')||7,minimo:num('minimo'),pontoPedido:num('pontoPedido'),maximo:num('maximo'),custo:code&&saldoMat(code)>0?mat(code).custo:num('custo'),controlaLote:o.controlaLote,controlaValidade:o.controlaValidade&&o.controlaLote,ativo:o.ativo};
  if(code)Object.assign(mat(code),rec);else S.materiais.push({...rec,abc:'C'});audit(code?'EDITAR':'CRIAR','MATERIAL',rec.codigo);save();closeDrawer();toast('Material salvo','ok');render()}
function simpleDrawer(title,fields,onSave,extra=''){openDrawer(title,`<form id="sF"><div class="fg">${fields}</div>${extra}</form>`,`<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn pri" id="sSave">Salvar</button>`);$('#sSave').onclick=()=>{const f=$('#sF');clearErr(f);onSave(readForm(f),f)}}
function depDrawer(code){const d=code?dep(code):{codigo:'',nome:'',tipo:'ALMOXARIFADO',erp:'',resp:'',ativo:true};
  simpleDrawer(code?`Depósito ${code}`:'Novo depósito',F('Código','codigo',{value:d.codigo,req:true,readonly:!!code})+F('Nome','nome',{value:d.nome,req:true})+F('Tipo','tipo',{value:d.tipo,opts:['ALMOXARIFADO','PRODUCAO','QUARENTENA','EXPEDICAO','TERCEIROS','CONSIGNADO']})+F('Código no ERP (WarehouseCode / Local)','erp',{value:d.erp})+F('Responsável','resp',{value:d.resp})+F('Ativo','ativo',{type:'checkbox',value:d.ativo}),
  (o,f)=>{if(!o.codigo)return fieldErr(f,'codigo','Obrigatório');if(!code&&dep(o.codigo.toUpperCase()))return fieldErr(f,'codigo','Já existe');if(!o.nome)return fieldErr(f,'nome','Obrigatório');if(code&&!o.ativo&&saldoMat&&balanceRows({deposito:code}).length)return toast('Depósito com saldo não pode ser inativado','bad');
   const r={codigo:o.codigo.toUpperCase(),nome:o.nome,tipo:o.tipo,erp:o.erp,resp:o.resp,ativo:o.ativo};if(code)Object.assign(dep(code),r);else S.depositos.push(r);audit(code?'EDITAR':'CRIAR','DEPOSITO',r.codigo);save();closeDrawer();render()})}
function endDrawer(d,code){const e=code?endr(d,code):{deposito:d||'ALM01',codigo:'',tipo:'PULMAO',capacidade:100,ativo:true};
  const bal=code?balanceRows({deposito:d,endereco:code}):[];
  simpleDrawer(code?`Endereço ${d}/${code}`:'Novo endereço',F('Depósito','deposito',{value:e.deposito,opts:depOpts(false),readonly:!!code})+F('Código (Rua-Prédio-Nível)','codigo',{value:e.codigo,req:true,readonly:!!code,ph:'A-01-1'})+F('Tipo','tipo',{value:e.tipo,opts:['PICKING','PULMAO','BLOCADO','QUARENTENA','DOCA','PRATELEIRA']})+F('Capacidade (unid. referência)','capacidade',{type:'number',value:e.capacidade})+F('Ativo','ativo',{type:'checkbox',value:e.ativo}),
   (o,f)=>{if(!o.codigo)return fieldErr(f,'codigo','Obrigatório');const dd=code?d:o.deposito;if(!code&&endr(dd,o.codigo.toUpperCase()))return fieldErr(f,'codigo','Já existe');if(code&&!o.ativo&&bal.length)return toast('Endereço com saldo não pode ser inativado','bad');
    const r={deposito:dd,codigo:o.codigo.toUpperCase(),tipo:o.tipo,capacidade:parseNum(o.capacidade)||0,ativo:o.ativo};if(code)Object.assign(endr(d,code),r);else S.enderecos.push(r);audit(code?'EDITAR':'CRIAR','ENDERECO',dd+'/'+r.codigo);save();closeDrawer();render()},
   bal.length?`<div class="sect">Conteúdo</div><table class="t"><tbody>${bal.map(b=>`<tr><td>${matLabel(b.material)}</td><td class="mono">${esc(b.lote||'—')}</td><td>${tePill(b.tipoEstoque,b.ordem)}</td><td class="num">${fmt(b.qtd)}</td></tr>`).join('')}</tbody></table>`:'')}
function lotDrawer(m,l){const L=l?lot(m,l):{material:'',lote:'',fabricacao:'',validade:'',fornecedor:'',status:'LIBERADO',certificado:''};
  const bal=l?balanceRows({material:m,lote:l}):[];
  simpleDrawer(l?`Lote ${l}`:'Novo lote',F('Material','material',{value:L.material,opts:matOpts(),readonly:!!l,full:true})+F('Lote','lote',{value:L.lote,req:true,readonly:!!l})+F('Fornecedor','fornecedor',{value:L.fornecedor})+F('Fabricação','fabricacao',{type:'date',value:L.fabricacao})+F('Validade','validade',{type:'date',value:L.validade})+F('Status de qualidade','status',{value:L.status,opts:['LIBERADO','QUARENTENA','BLOQUEADO']})+F('Certificado / laudo','certificado',{value:L.certificado,ph:'nº do certificado'}),
   (o,f)=>{const mm=l?m:o.material;if(!mm)return fieldErr(f,'material','Obrigatório');if(!o.lote)return fieldErr(f,'lote','Obrigatório');if(!l&&lot(mm,o.lote))return fieldErr(f,'lote','Já existe');if(mat(mm)?.controlaValidade&&!o.validade)return fieldErr(f,'validade','Material controla validade');
    const prev=L.status;const r={material:mm,lote:l||o.lote,fornecedor:o.fornecedor,fabricacao:o.fabricacao,validade:o.validade,status:o.status,certificado:o.certificado};if(l)Object.assign(lot(m,l),r);else S.lotes.push(r);audit(l?'EDITAR':'CRIAR','LOTE',mm+'/'+r.lote,prev!==o.status?`status ${prev}→${o.status}`:'');save();closeDrawer();render()},
   bal.length?`<div class="sect">Rastreabilidade — posições atuais</div><table class="t"><tbody>${bal.map(b=>`<tr><td class="mono">${b.deposito}/${esc(b.endereco||'—')}</td><td>${tePill(b.tipoEstoque,b.ordem)}</td><td class="num">${fmt(b.qtd)}</td></tr>`).join('')}</tbody></table><div class="sect">Movimentos do lote</div><table class="t"><tbody>${S.movs.filter(x=>x.material===m&&x.lote===l).slice(-15).reverse().map(x=>`<tr><td>${tsBR(x.ts)}</td><td>${x.tipo}</td><td class="mono">${esc(x.doc)}</td><td class="num">${fmt(x.qtd)}</td></tr>`).join('')}</tbody></table>`:'')}
function ordDrawer(n){const o=n?ord(n):{numero:'',tipo:'OP',descricao:'',cliente:'',status:'ABERTA',entrega:addDays(todayISO(),15),itens:[{material:'',qtd:''}]};
  openDrawer(n?`Ordem ${n}`:'Nova ordem',`<form id="oF"><div class="fg">${F('Número','numero',{value:o.numero,req:true,readonly:!!n,ph:'OP-2026-0102'})}${F('Tipo','tipo',{value:o.tipo,opts:[['OP','OP — Ordem de produção'],['OS','OS — Ordem de serviço/manutenção'],['OV','OV — Ordem de venda'],['PROJETO','Projeto / Obra']]})}${F('Descrição','descricao',{value:o.descricao,req:true,full:true})}${F('Cliente / centro de custo','cliente',{value:o.cliente})}${F('Entrega','entrega',{type:'date',value:o.entrega})}${F('Status','status',{value:o.status,opts:['ABERTA','LIBERADA','EM_ATENDIMENTO','ENCERRADA','CANCELADA']})}</div>
   <div class="sect">Lista de materiais</div><table class="lines" id="pkLines"><thead><tr><th>Material</th><th>Qtd</th><th></th></tr></thead><tbody>${o.itens.map(pkLine).join('')}</tbody></table><button type="button" class="btn sm" data-act="pkAddLine" style="margin-top:6px">${ic('plus')} Linha</button></form>`,
   `<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn pri" data-act="ordSave" data-o="${n}">Salvar</button>`,{wide:true})}
function ordSave(n){const f=$('#oF');const o=readForm(f);clearErr(f);if(!o.numero)return fieldErr(f,'numero','Obrigatório');if(!n&&ord(o.numero.toUpperCase()))return fieldErr(f,'numero','Já existe');if(!o.descricao)return fieldErr(f,'descricao','Obrigatório');
  const itens=$$('#pkLines tbody tr').map(tr=>({material:$('[name=material]',tr).value,qtd:parseNum($('[name=qtd]',tr).value)})).filter(i=>i.material&&i.qtd>0);
  if(n&&['ENCERRADA','CANCELADA'].includes(o.status)&&balanceRows({tipoEstoque:'ORDEM',ordem:n}).length)return toast('A ordem ainda possui estoque segregado — libere para o estoque normal antes de encerrar','bad');
  const r={numero:(n||o.numero).toUpperCase(),tipo:o.tipo,descricao:o.descricao,cliente:o.cliente,entrega:o.entrega,status:o.status,itens};if(n)Object.assign(ord(n),r);else S.ordens.push(r);audit(n?'EDITAR':'CRIAR','ORDEM',r.numero);save();closeDrawer();render()}

/* ---------- DIGITALIZAÇÃO: Code128, etiquetas, scanner, coletor ---------- */
const C128=["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"];
function code128(text,h=46){
  const s=String(text).replace(/[^\x20-\x7E]/g,'');const vals=[104,...[...s].map(c=>c.charCodeAt(0)-32)];let sum=104;vals.slice(1).forEach((v,i)=>sum+=v*(i+1));vals.push(sum%103,106);
  let x=10,bars='';vals.forEach(v=>{const p=C128[v];for(let i=0;i<p.length;i++){const w=+p[i];if(i%2===0)bars+=`<rect x="${x}" y="0" width="${w}" height="${h}"/>`;x+=w}});
  return`<svg viewBox="0 0 ${x+10} ${h}" width="100%" height="${h}" preserveAspectRatio="none" fill="#000">${bars}</svg>`;
}
const labelHTML=(code,t2,t3)=>`<div class="t1">${esc(code)}</div><div class="t2">${esc(t2||'')}</div>${code128(code)}<div class="row sp t2"><span>${esc(t3||'')}</span><span>GPlanSiS|WHOUSE</span></div>`;
function printLabels(items,title){
  $('#printArea').innerHTML=`<div class="lbls" style="padding:10px">${items.map(i=>`<div class="lbl">${labelHTML(i.code,i.t2,i.t3)}</div>`).join('')}</div>`;
  openModal(title||'Etiquetas',`<div style="max-height:55vh;overflow:auto"><div class="lbls">${items.slice(0,60).map(i=>`<div class="lbl">${labelHTML(i.code,i.t2,i.t3)}</div>`).join('')}</div>${items.length>60?`<div class="muted sm">+${items.length-60} na impressão</div>`:''}</div>`,[{t:'Fechar',v:0},{t:'Exportar HTML',v:'html',cls:''},{t:'Imprimir',v:'p',cls:'pri'}],{wide:true})
   .then(v=>{if(v==='p')setTimeout(()=>window.print(),200);if(v==='html')saveFile('etiquetas_whouse.html',`<!doctype html><meta charset="utf-8"><title>Etiquetas</title><style>body{font-family:Arial;margin:8mm}.lbls{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}.lbl{border:1px dashed #888;padding:3mm;page-break-inside:avoid}.t1{font-weight:700;font-size:13px}.t2{font:11px monospace}.row{display:flex;justify-content:space-between}</style>${$('#printArea').innerHTML}`)})}
let camStream=null,camTimer=null;
function stopCamera(){if(camTimer){clearInterval(camTimer);camTimer=null}if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null}}
async function openScanner(target){
  const hasBD='BarcodeDetector' in window;
  openModal('Leitura de código',`<div class="muted sm" style="margin-bottom:8px">${hasBD?'Aponte a câmera para o código de barras / QR. ':'Leitura por câmera indisponível neste navegador — use leitor USB/Bluetooth (modo teclado) ou digite.'}</div>
   ${hasBD?'<video class="scan" id="camV" playsinline muted></video>':''}<div class="f" style="margin-top:8px"><label>Código</label><input id="scanIn" placeholder="Material, EAN, lote, endereço ou documento" style="font-family:var(--fm)"></div><div id="scanRes" style="margin-top:10px"></div>`,[{t:'Fechar',v:null},{t:'Consultar',v:'go',cls:'pri',before:()=>{scanLookup($('#scanIn').value,target);return false}}]);
  const inp=$('#scanIn');inp.focus();inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();scanLookup(inp.value,target)}};
  if(hasBD){try{camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});const v=$('#camV');v.srcObject=camStream;await v.play();const bd=new BarcodeDetector({formats:['code_128','ean_13','ean_8','qr_code','code_39','data_matrix']});
    camTimer=setInterval(async()=>{try{const r=await bd.detect(v);if(r[0]){inp.value=r[0].rawValue;stopCamera();scanLookup(r[0].rawValue,target)}}catch(e){}},350)}catch(e){$('#scanRes').innerHTML=`<div class="muted sm">Câmera não autorizada ou indisponível (${esc(e.name||e.message)}). Use a digitação/leitor.</div>`}}
}
function scanLookup(v,target){
  v=String(v||'').trim();if(!v)return;
  if(target&&$('#'+target)){closeModal(null);const el=$('#'+target);el.value=v;el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));return}
  const V=v.toUpperCase();const hits=[];
  S.materiais.filter(m=>m.codigo===V||m.ean===v).forEach(m=>hits.push({t:'Material',h:`${matLabel(m.codigo)} · saldo ${fmt(saldoMat(m.codigo))} ${m.um}`,go:()=>matDrawer(m.codigo)}));
  S.lotes.filter(l=>l.lote.toUpperCase()===V).forEach(l=>hits.push({t:'Lote',h:`${esc(l.lote)} · ${esc(l.material)} · ${l.status}`,go:()=>lotDrawer(l.material,l.lote)}));
  S.enderecos.filter(e=>e.codigo===V||(e.deposito+'/'+e.codigo)===V).forEach(e=>hits.push({t:'Endereço',h:`${e.deposito}/${esc(e.codigo)} · ${e.tipo}`,go:()=>endDrawer(e.deposito,e.codigo)}));
  S.pickings.filter(p=>p.numero===V).forEach(p=>hits.push({t:'Picking',h:p.numero,go:()=>pickDrawer(p.numero)}));
  S.recebimentos.filter(r=>r.numero===V||r.nf===v).forEach(r=>hits.push({t:'Recebimento',h:r.numero+' NF '+r.nf,go:()=>recDrawer(r.numero)}));
  S.ordens.filter(o=>o.numero===V).forEach(o=>hits.push({t:'Ordem',h:o.numero,go:()=>ordDrawer(o.numero)}));
  window._scanHits=hits;
  $('#scanRes').innerHTML=hits.length?hits.map((h,i)=>`<div class="step" style="cursor:pointer" data-act="scanGo" data-i="${i}"><div class="n">${i+1}</div><div class="grow"><div class="xs muted">${h.t}</div>${h.h}</div></div>`).join(''):`<div class="muted">Nada encontrado para <b>${esc(v)}</b>.</div>`;
  if(hits.length===1){setTimeout(()=>{closeModal(null);hits[0].go()},350)}
}
VIEWS.digital=()=>{
  const t=curTab('dg','col');
  const head=tabs('dg',[['col','Coletor móvel'],['etq','Etiquetas'],['disp','Dispositivos & PWA']]);
  if(t==='col')return head+`<div style="max-width:560px"><div class="coletor">
    <button data-act="colRec">${ic('rec')}Receber</button><button data-act="colPick">${ic('pick')}Separar</button>
    <button data-act="movNew" data-t="TRANSFERENCIA">${ic('transfer')}Transferir</button><button data-act="colCount">${ic('inv')}Contar</button>
    <button data-act="movNew" data-t="SAIDA">${ic('dl')}Requisitar</button><button data-act="openScanner">${ic('scan')}Consultar</button></div>
    <div class="card" style="margin-top:12px"><div class="bd sm muted">Modo coletor: alvos de 92 px para uso com luva, leitura por câmera (BarcodeDetector) ou leitor Bluetooth em modo teclado. Todas as operações validam as mesmas invariantes do desktop e funcionam offline — a fila de integração é enviada quando houver conexão.</div></div></div>`;
  if(t==='etq')return head+`<div class="grid g3">
    <div class="card"><div class="hd"><h3>Endereços</h3></div><div class="bd"><select class="flt" id="etqDep" style="width:100%;margin-bottom:8px">${depOpts(false).map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')}</select><button class="btn pri" data-act="printEnds">${ic('print')} Gerar</button></div></div>
    <div class="card"><div class="hd"><h3>Materiais</h3></div><div class="bd"><select class="flt" id="etqGrp" style="width:100%;margin-bottom:8px"><option value="">Todos os grupos</option>${[...new Set(S.materiais.map(m=>m.grupo))].map(g=>`<option>${esc(g)}</option>`).join('')}</select><button class="btn pri" data-act="printMats">${ic('print')} Gerar</button></div></div>
    <div class="card"><div class="hd"><h3>Lotes com saldo</h3></div><div class="bd"><div class="muted sm" style="margin-bottom:8px">Etiqueta Code128 do lote com validade — use na identificação física de volumes.</div><button class="btn pri" data-act="printLots">${ic('print')} Gerar</button></div></div></div>`;
  if(t==='disp')return head+`<div class="grid g2"><div class="card"><div class="hd"><h3>Aplicativo (PWA)</h3></div><div class="bd sm">
    <p style="margin-top:0">O WHOUSE é um único arquivo HTML, responsivo e operável offline. Para instalação como aplicativo (ícone na tela inicial, tela cheia, cache offline via service worker) publique o pacote PWA em um domínio HTTPS próprio — ex.: <span class="mono">whouse.gplansis.com</span>.</p>
    <div id="pwaState" class="muted"></div><div class="row" style="margin-top:8px"><button class="btn pri" data-act="pwaInstall" id="pwaBtn">Instalar aplicativo</button><button class="btn" data-act="exportPWA">${ic('dl')} Baixar este HTML</button></div></div></div>
    <div class="card"><div class="hd"><h3>Leitores e impressoras</h3></div><div class="bd sm"><div class="alertlist">
    <div class="it"><span class="dot" style="background:${'BarcodeDetector' in window?'var(--ok)':'var(--steel)'}"></span><span class="grow">Câmera / BarcodeDetector</span><b>${'BarcodeDetector' in window?'disponível':'indisponível'}</b></div>
    <div class="it"><span class="dot" style="background:var(--ok)"></span><span class="grow">Leitor USB/Bluetooth (HID teclado)</span><b>suportado</b></div>
    <div class="it"><span class="dot" style="background:var(--ok)"></span><span class="grow">Impressão de etiquetas (navegador / PDF)</span><b>suportado</b></div>
    <div class="it"><span class="dot" style="background:var(--steel)"></span><span class="grow">Impressora térmica ZPL (Zebra) via gateway</span><b>exportar HTML/ZPL no backend</b></div></div></div></div></div>`;
};
let deferredPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e});
VIEWS.after_digital=()=>{const s=$('#pwaState');if(s)s.textContent=window.matchMedia?.('(display-mode: standalone)').matches?'Executando como aplicativo instalado.':deferredPrompt?'Instalação disponível neste navegador.':'Instalação indisponível neste contexto (exige o pacote PWA hospedado em HTTPS).'};

/* ---------- INTEGRAÇÕES ---------- */
VIEWS.integracoes=()=>{
  const t=curTab('it','con');
  const head=tabs('it',[['con','Conectores'],['fila','Fila (outbox)'],['arq','Arquitetura']]);
  if(t==='con')return head+`<div class="toolbar"><div class="muted sm grow">Modo atual: <b>${S.cfg.modo==='INDEPENDENTE'?'Independente — WHOUSE é o sistema mestre de estoque; ERPs recebem espelho':'Integrado — ERP mestre de cadastros e fiscal; WHOUSE executa e devolve movimentos'}</b></div><button class="btn" data-act="cfgMode">Alternar modo</button><button class="btn pri" data-act="obProcess">${ic('play')} Processar fila</button></div>
   <div class="grid g3">${S.integracoes.map(i=>{const c=conn(i.id);const q=S.outbox.filter(o=>o.destino===i.id);return`<div class="conn"><div class="row"><div class="lg" style="background:${c.cor}">${esc(c.sig)}</div><div class="grow"><b>${esc(c.nome)}</b><div class="xs muted">${esc(c.proto)}</div></div>${i.ativo?P('ATIVO','ok'):P('INATIVO','mut')}</div>
    <div class="xs">${c.confirmado?P('contrato público','info'):P('contrato a confirmar','warn')} ${P(i.ambiente,'mut')} ${P(i.modo,'mut')}</div>
    <div class="row xs muted"><span>Fila: ${q.filter(o=>o.status==='PENDENTE').length} pend · ${q.filter(o=>o.status==='ENVIADO').length} env · <span style="color:var(--bad)">${q.filter(o=>['ERRO','DLQ'].includes(o.status)).length} erro</span></span><span style="margin-left:auto">últ. sync ${i.ultimoSync?tsBR(i.ultimoSync):'—'}</span></div>
    <div class="row"><button class="btn sm" data-act="intCfg" data-i="${i.id}">Configurar</button><button class="btn sm" data-act="intToggle" data-i="${i.id}">${i.ativo?'Desativar':'Ativar'}</button><button class="btn sm" data-act="intTest" data-i="${i.id}">Testar</button><button class="btn sm" data-act="intLayout" data-i="${i.id}">${ic('dl')} Layout</button></div></div>`}).join('')}</div>`;
  if(t==='fila')return head+tbl('ob',[{t:'Criado',v:o=>tsBR(o.ts),s:o=>o.ts},{t:'Destino',h:o=>`<b>${esc(conn(o.destino)?.sig)}</b> ${esc(conn(o.destino)?.nome)}`,v:o=>o.destino},{t:'Tipo',k:'kind'},{t:'Documento',k:'doc',cls:'mono'},{t:'Chave idempotente',k:'idem',cls:'mono xs'},{t:'Tent.',v:o=>o.tentativas,num:true},{t:'Status',h:o=>stPill(o.status),v:o=>o.status},
    {t:'',h:o=>`<button class="btn sm" data-act="obView" data-o="${o.id}">Payload</button>${o.status!=='ENVIADO'?` <button class="btn sm" data-act="obRetry" data-o="${o.id}">Reprocessar</button>`:''}`}],S.outbox,{empty:'Fila vazia',tools:`<button class="btn pri" data-act="obProcess">${ic('play')} Processar pendentes</button><button class="btn" data-act="obExport">${ic('dl')} Exportar fila (JSON)</button><button class="btn dan" data-act="obPurge">Limpar enviados</button>`});
  if(t==='arq')return head+`<div class="card"><div class="bd"><pre class="code">┌──────────────────────┐   postDoc()   ┌────────────┐   worker/gateway   ┌──────────────────┐
│  WHOUSE (PWA/offline)│ ────────────▶ │  OUTBOX    │ ─────────────────▶ │ ERP (SAP B1 SL,  │
│  ledger append-only  │   atômico     │ idem-key   │  retry + backoff   │ TOTVS, Senior,   │
│  saldo = Σ movimentos│               │ destino:   │  3× → DLQ          │ Sankhya, Odoo…)  │
└──────────┬───────────┘               │ tipo:doc   │                    └────────┬─────────┘
           │ import/export CSV·XLSX·JSON└────────────┘  ◀── cadastros/saldos (inbox) ─┘
           ▼
  Templates + layouts ERP (DTW, SB1, genérico) → operação 100% independente sem ERP</pre>
  <div class="sm" style="margin-top:10px"><b>Por que gateway:</b> o navegador não deve guardar credencial de ERP nem abrir conexão direta (CSP, CORS, segurança). Em produção, o gateway (FastAPI + worker) consome a outbox, faz login no Service Layer/REST, aplica o mapa de campos e grava o retorno (DocEntry/nº do documento) na mensagem. Chave idempotente = <span class="mono">destino:tipo:documento</span>, impedindo lançamento duplicado em reenvio.</div>
  <div class="sm" style="margin-top:8px"><b>Contratos:</b> SAP B1 Service Layer e Odoo são contratos públicos. TOTVS, Senior e Sankhya variam por versão e customização do cliente — os payloads aqui são <b>hipótese marcada</b> e a fila retém essas mensagens até a homologação na instância real.</div></div></div>`;
};
function intCfgDrawer(id){const i=S.integracoes.find(x=>x.id===id),c=conn(id);
  openDrawer(`Conector · ${c.nome}`,`<form id="iF"><div class="fg">${F('Ambiente','ambiente',{value:i.ambiente,opts:['HOMOLOGACAO','PRODUCAO']})}${F('Modo de envio','modo',{value:i.modo,opts:[['OUTBOX','Outbox via gateway (recomendado)'],['ARQUIVO','Exportação de arquivo'],['MANUAL','Manual (aprovação por mensagem)']]})}
   ${F('URL base','url',{value:i.url,full:true,ph:c.urlEx})}${F('Empresa / banco (CompanyDB, filial)','empresa',{value:i.empresa})}${F('Usuário técnico','usuario',{value:i.usuario,help:'Senha e tokens ficam no cofre do gateway — nunca no navegador'})}
   <div class="f full"><label>Entidades sincronizadas</label><div class="row">${['MOVIMENTOS','SALDOS','MATERIAIS','DEPOSITOS','LOTES','ORDENS','REQUISICOES'].map(e=>`<label class="chk"><input type="checkbox" name="ent_${e}" ${i.entidades.includes(e)?'checked':''} style="width:auto;min-height:0"> ${e}</label>`).join('')}</div></div></div>
   <div class="sect">Endpoints</div><table class="t"><tbody>${Object.entries(c.endpoints).map(([k,v])=>`<tr><td class="mono xs">${k}</td><td class="sm">${esc(v)}</td></tr>`).join('')}</tbody></table>
   <div class="sect">Mapa de campos WHOUSE → ${esc(c.nome)}</div><table class="lines"><thead><tr><th>WHOUSE</th><th>ERP</th></tr></thead><tbody>${i.mapa.map(([a,b],ix)=>`<tr><td class="mono">${esc(a)}</td><td><input name="map_${ix}" value="${esc(b)}"></td></tr>`).join('')}</tbody></table>
   <div class="sect">Exemplo de payload (última movimentação)</div><pre class="code">${esc(JSON.stringify(S.movs.length?payloadFor(id,kindOf(S.movs[S.movs.length-1].tipo),S.movs[S.movs.length-1].doc,S.movs.filter(m=>m.doc===S.movs[S.movs.length-1].doc)):{},null,2))}</pre></form>`,
   `<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn pri" data-act="intSave" data-i="${id}">Salvar</button>`,{wide:true})}
function intSave(id){const i=S.integracoes.find(x=>x.id===id);const o=readForm($('#iF'));Object.assign(i,{ambiente:o.ambiente,modo:o.modo,url:o.url,empresa:o.empresa,usuario:o.usuario});
  i.entidades=['MOVIMENTOS','SALDOS','MATERIAIS','DEPOSITOS','LOTES','ORDENS','REQUISICOES'].filter(e=>o['ent_'+e]);i.mapa=i.mapa.map(([a,b],ix)=>[a,o['map_'+ix]??b]);audit('CONFIG','INTEGRACAO',id);save();closeDrawer();toast('Conector salvo','ok');render()}

/* ---------- IMPORTAÇÃO / EXPORTAÇÃO / TEMPLATES ---------- */
const ENT={
 materiais:{t:'Materiais',key:['codigo'],cols:[['codigo','Código do material (único)','MC-00405',1],['descricao','Descrição','Rolamento 6206-2RS',1],['um','Unidade (UN, KG, M, L, PR…)','UN',1],['grupo','Grupo','Mecânico',0],['controlaLote','Controla lote S/N','N',0],['controlaValidade','Controla validade S/N','N',0],['minimo','Estoque mínimo','20',0],['pontoPedido','Ponto de pedido','40',0],['maximo','Estoque máximo','100',0],['custo','Custo unitário (R$)','51,90',0],['ncm','NCM','8482.10.10',0],['ean','EAN/GTIN','',0],['leadTime','Lead time (dias)','10',0]]},
 depositos:{t:'Depósitos',key:['codigo'],cols:[['codigo','Código','ALM02',1],['nome','Nome','Almoxarifado Filial',1],['tipo','ALMOXARIFADO|PRODUCAO|QUARENTENA|EXPEDICAO|TERCEIROS|CONSIGNADO','ALMOXARIFADO',1],['erp','Código no ERP','04',0],['resp','Responsável','',0]]},
 enderecos:{t:'Endereços',key:['deposito','codigo'],cols:[['deposito','Código do depósito','ALM01',1],['codigo','Endereço','D-01-1',1],['tipo','PICKING|PULMAO|BLOCADO|QUARENTENA|DOCA|PRATELEIRA','PICKING',1],['capacidade','Capacidade','200',0]]},
 lotes:{t:'Lotes',key:['material','lote'],cols:[['material','Código do material','CS-00203',1],['lote','Lote','L2609-100',1],['fabricacao','Fabricação (dd/mm/aaaa)','01/09/2026',0],['validade','Validade (dd/mm/aaaa)','01/09/2027',0],['fornecedor','Fornecedor','',0],['status','LIBERADO|QUARENTENA|BLOQUEADO','LIBERADO',0]]},
 saldos:{t:'Saldos iniciais / carga',key:null,cols:[['material','Código do material','MC-00401',1],['lote','Lote (se controla)','',0],['validade','Validade do lote','',0],['deposito','Depósito','ALM01',1],['endereco','Endereço','A-01-1',0],['qtd','Quantidade (>0)','25',1],['custo','Custo unitário','42,60',0],['tipoEstoque','NORMAL|ORDEM','NORMAL',0],['ordem','Nº ordem se ORDEM','',0],['doc','Documento','CARGA-INICIAL',0]]},
 ordens:{t:'Ordens + lista de materiais',key:null,cols:[['numero','Nº da ordem','OP-2026-0200',1],['tipo','OP|OS|OV|PROJETO','OP',1],['descricao','Descrição','Conjunto soldado CS-12',1],['cliente','Cliente / CC','Interno',0],['entrega','Entrega','30/10/2026',0],['material','Material (1 linha por item)','MP-00101',1],['qtd','Quantidade','120',1]]}
};
/* aliases de cabeçalho para aceitar planilhas exportadas dos ERPs sem retrabalho */
const ALIAS={codigo:['itemcode','b1_cod','codprod','codpro','default_code','sku','cod','codigo_material'],descricao:['itemname','b1_desc','descrprod','despro','name','description'],um:['inventoryuom','b1_um','codvol','unimed','uom'],grupo:['itmsgrpcod','b1_grupo','codgrupoprod','grupo_material'],
 controlalote:['managebatchnumbers','b1_rastro','usoprod'],custo:['avgprice','b1_custd','custo_medio','price'],minimo:['minlevel','b1_emin'],maximo:['maxlevel','b1_emax'],leadtime:['leadtime','b1_pe'],
 material:['itemcode','d3_cod','b8_produto','codprod','codpro','sku','product'],lote:['batchnumber','distnumber','b8_lotectl','d3_lotectl','controle','codlot','batch'],validade:['expdate','expirydate','b8_dtvalid','d3_dtvalid','dtval','datvlt','expiry'],deposito:['whscode','warehousecode','b2_local','d3_local','codlocal','coddep','warehouse'],qtd:['onhand','quantity','b2_qatu','b8_saldo','d3_quant','qtdneg','qtdmov','qty'],nome:['whsname','nome_deposito']};
function normHdr(h){return String(h).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_]/g,'')}
function mapRow(ent,row){const out={};const keys=Object.keys(row);ENT[ent].cols.forEach(([c])=>{const nc=normHdr(c);let k=keys.find(x=>normHdr(x)===nc);if(k==null){const al=(ent==='depositos'&&nc==='codigo')?ALIAS.deposito:(ALIAS[nc]||[]);k=keys.find(x=>al.includes(normHdr(x)))}out[c]=k!=null?row[k]:''});return out}
const yes=v=>/^(s|sim|y|yes|true|1|tyes|l|x)$/i.test(String(v).trim());
function validateRows(ent,rows){
  const ok=[],errs=[];const seen=new Set();
  rows.forEach((raw,ix)=>{const r=mapRow(ent,raw);const e=[];const line=ix+2;
    ENT[ent].cols.forEach(([c,,,req])=>{if(req&&String(r[c]??'').trim()==='')e.push(`${c} obrigatório`)});
    ['minimo','pontoPedido','maximo','custo','leadTime','capacidade','qtd'].forEach(c=>{if(c in r&&String(r[c]).trim()!==''){const n=parseNum(r[c]);if(isNaN(n))e.push(`${c} numérico inválido ("${r[c]}")`);else r[c]=n}});
    ['fabricacao','validade','entrega'].forEach(c=>{if(c in r&&r[c]!==''){const d=parseDate(r[c]);if(d==='INVALID')e.push(`${c} data inválida ("${r[c]}")`);else r[c]=d}});
    if(ent==='saldos'){if(!(r.qtd>0))e.push('qtd deve ser > 0');const M=mat(String(r.material).toUpperCase());if(!M)e.push(`material ${r.material} não cadastrado`);else{r.material=M.codigo;if(M.controlaLote&&!r.lote)e.push('material controla lote — informe o lote');if(M.controlaValidade&&r.lote&&!lot(M.codigo,r.lote)&&!r.validade)e.push('lote novo exige validade')}
      r.deposito=String(r.deposito).toUpperCase();if(!dep(r.deposito))e.push(`depósito ${r.deposito} inexistente`);if(r.endereco&&!endr(r.deposito,String(r.endereco).toUpperCase()))e.push(`endereço ${r.endereco} inexistente`);r.endereco=String(r.endereco||'').toUpperCase();
      r.tipoEstoque=(r.tipoEstoque||'NORMAL').toUpperCase();if(r.tipoEstoque==='ORDEM'&&!ord(r.ordem))e.push(`ordem ${r.ordem} inexistente`)}
    if(ent==='enderecos'&&!dep(String(r.deposito).toUpperCase()))e.push(`depósito ${r.deposito} inexistente`);
    if(ent==='lotes'&&!mat(String(r.material).toUpperCase()))e.push(`material ${r.material} não cadastrado`);
    if(ent==='ordens'&&!mat(String(r.material).toUpperCase()))e.push(`material ${r.material} não cadastrado`);
    if(ENT[ent].key){const k=ENT[ent].key.map(c=>String(r[c]).toUpperCase()).join('|');if(seen.has(k))e.push('chave duplicada no arquivo');seen.add(k)}
    e.length?errs.push({line,e}):ok.push(r)});
  return{ok,errs};
}
function commitImport(ent,rows){
  let ins=0,upd=0;const U=s=>String(s||'').trim().toUpperCase();
  if(ent==='materiais')rows.forEach(r=>{const m=mat(U(r.codigo));const rec={codigo:U(r.codigo),descricao:String(r.descricao),um:U(r.um)||'UN',grupo:r.grupo||'Geral',controlaLote:yes(r.controlaLote),controlaValidade:yes(r.controlaValidade)&&yes(r.controlaLote),minimo:+r.minimo||0,pontoPedido:+r.pontoPedido||0,maximo:+r.maximo||0,ncm:String(r.ncm||''),ean:String(r.ean||''),leadTime:+r.leadTime||7};
    if(m){Object.assign(m,rec);if(!saldoMat(m.codigo))m.custo=+r.custo||m.custo;upd++}else{S.materiais.push({...rec,custo:+r.custo||0,ativo:true,abc:'C'});ins++}});
  if(ent==='depositos')rows.forEach(r=>{const d=dep(U(r.codigo));const rec={codigo:U(r.codigo),nome:String(r.nome),tipo:U(r.tipo)||'ALMOXARIFADO',erp:String(r.erp||''),resp:String(r.resp||''),ativo:true};d?(Object.assign(d,rec),upd++):(S.depositos.push(rec),ins++)});
  if(ent==='enderecos')rows.forEach(r=>{const e=endr(U(r.deposito),U(r.codigo));const rec={deposito:U(r.deposito),codigo:U(r.codigo),tipo:U(r.tipo)||'PULMAO',capacidade:+r.capacidade||0,ativo:true};e?(Object.assign(e,rec),upd++):(S.enderecos.push(rec),ins++)});
  if(ent==='lotes')rows.forEach(r=>{const l=lot(U(r.material),String(r.lote));const rec={material:U(r.material),lote:String(r.lote),fabricacao:r.fabricacao||'',validade:r.validade||'',fornecedor:String(r.fornecedor||''),status:U(r.status)||'LIBERADO',certificado:''};l?(Object.assign(l,rec),upd++):(S.lotes.push(rec),ins++)});
  if(ent==='ordens'){const g={};rows.forEach(r=>{const n=U(r.numero);g[n]=g[n]||{numero:n,tipo:U(r.tipo)||'OP',descricao:String(r.descricao),cliente:String(r.cliente||''),entrega:r.entrega||addDays(todayISO(),15),status:'ABERTA',itens:[]};g[n].itens.push({material:U(r.material),qtd:+r.qtd})});
    Object.values(g).forEach(o=>{const x=ord(o.numero);x?(Object.assign(x,{...o,status:x.status}),upd++):(S.ordens.push(o),ins++)})}
  if(ent==='saldos'){rows.forEach(r=>{if(r.lote&&!lot(r.material,String(r.lote)))S.lotes.push({material:r.material,lote:String(r.lote),fabricacao:'',validade:r.validade||'',fornecedor:'',status:'LIBERADO'})});
    const movs=rows.map(r=>({tipo:'ENTRADA',material:r.material,lote:r.lote?String(r.lote):'',deposito:r.deposito,endereco:r.endereco,qtd:+r.qtd,custo:+r.custo||mat(r.material).custo,tipoEstoque:r.tipoEstoque,ordem:r.tipoEstoque==='ORDEM'?U(r.ordem):'',obs:'Importação '+(r.doc||'')}));
    postDoc(movs,{doc:nextSeq('IMP'),tipoDoc:'ENTRADA'});ins=movs.length}
  audit('IMPORTAR',ent.toUpperCase(),'arquivo',`${ins} incl. / ${upd} atual.`);calcABC();save();return{ins,upd};
}
async function readFile(file){
  const name=file.name.toLowerCase();
  if(name.endsWith('.json')){const j=JSON.parse(await file.text());return Array.isArray(j)?j:(j.rows||j.data||[])}
  if(typeof XLSX==='undefined')throw new Error('Biblioteca de planilhas não carregada — use CSV ou JSON');
  let wb;if(name.endsWith('.csv')){const txt=await file.text();const first=txt.split(/\r?\n/)[0];wb=XLSX.read(txt,{type:'string',FS:(first.split(';').length>first.split(',').length)?';':',',raw:true})}
  else wb=XLSX.read(await file.arrayBuffer(),{type:'array'});
  const sh=wb.Sheets[wb.SheetNames.find(n=>/dados|data|sheet1|planilha1/i.test(n))||wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sh,{defval:'',raw:true});
}
async function saveFile(name,data){
  try{if(window.claude?.use){const dl=await window.claude.use('downloads');if(dl){await dl.save({filename:name,data});toast('Arquivo entregue: '+name,'ok');return}}}catch(e){if(e&&e.code==='declined'){toast('Download cancelado');return}}
  try{const blob=data instanceof Blob?data:new Blob([data],{type:'application/octet-stream'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500);toast('Download: '+name,'ok')}catch(e){toast('Não foi possível baixar: '+e.message,'bad')}
}
function toCSV(rows){if(!rows.length)return'';const h=Object.keys(rows[0]);const q=v=>{const s=typeof v==='number'?String(v).replace('.',','):String(v??'');return/[;"\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s};return'\uFEFF'+[h.join(';'),...rows.map(r=>h.map(k=>q(r[k])).join(';'))].join('\r\n')}
function exportRows(name,rows,fmtx){
  if(!rows.length)return toast('Nada para exportar','bad');
  if(fmtx==='json')return saveFile(name+'.json',JSON.stringify(rows,null,2));
  if(fmtx==='csv'||typeof XLSX==='undefined')return saveFile(name+'.csv',toCSV(rows));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'DADOS');const out=XLSX.write(wb,{bookType:'xlsx',type:'array'});saveFile(name+'.xlsx',new Blob([out]));
}
function exportData(ent){
  const res=reservedMap();
  return({materiais:()=>S.materiais.map(m=>({codigo:m.codigo,descricao:m.descricao,um:m.um,grupo:m.grupo,controlaLote:m.controlaLote?'S':'N',controlaValidade:m.controlaValidade?'S':'N',minimo:m.minimo,pontoPedido:m.pontoPedido,maximo:m.maximo,custo:m.custo,ncm:m.ncm,ean:m.ean,leadTime:m.leadTime,abc:m.abc,saldo:saldoMat(m.codigo),disponivel:disponivel(m.codigo)})),
   depositos:()=>S.depositos.map(({codigo,nome,tipo,erp,resp})=>({codigo,nome,tipo,erp,resp})),enderecos:()=>S.enderecos.map(({deposito,codigo,tipo,capacidade})=>({deposito,codigo,tipo,capacidade})),
   lotes:()=>S.lotes.map(l=>({material:l.material,lote:l.lote,fabricacao:dtBR(l.fabricacao),validade:dtBR(l.validade),fornecedor:l.fornecedor,status:l.status,saldo:balanceRows({material:l.material,lote:l.lote}).reduce((s,b)=>s+b.qtd,0)})),
   saldos:()=>balanceRows().map(b=>({material:b.material,descricao:mat(b.material)?.descricao,lote:b.lote,validade:dtBR(lot(b.material,b.lote)?.validade),deposito:b.deposito,endereco:b.endereco,qtd:b.qtd,reservado:res.get(b.key)||0,custo:mat(b.material)?.custo,valor:r3(b.qtd*(mat(b.material)?.custo||0)),tipoEstoque:b.tipoEstoque,ordem:b.ordem})),
   ordens:()=>S.ordens.flatMap(o=>o.itens.map(i=>({numero:o.numero,tipo:o.tipo,descricao:o.descricao,cliente:o.cliente,entrega:dtBR(o.entrega),status:o.status,material:i.material,qtd:i.qtd}))),
   movimentos:()=>S.movs.map(m=>({data:new Date(m.ts).toISOString(),tipo:m.tipo,documento:m.doc,material:m.material,lote:m.lote,deposito:m.deposito,endereco:m.endereco,qtd:m.qtd,custo:m.custo,tipoEstoque:m.tipoEstoque,ordem:m.ordem,usuario:m.user,obs:m.obs})),
   pickings:()=>S.pickings.flatMap(p=>p.linhas.flatMap(l=>l.aloc.map(a=>({picking:p.numero,status:p.status,ordem:p.ordem,material:l.material,lote:a.lote,deposito:a.deposito,endereco:a.endereco,alocado:a.qtd,separado:a.sep||0})))),
   inventarios:()=>S.inventarios.flatMap(i=>i.linhas.map(l=>({inventario:i.numero,status:i.status,material:l.material,lote:l.lote,deposito:l.deposito,endereco:l.endereco,sistema:l.sistema,contado:l.contado,recontagem:l.recontagem}))),
   requisicoes:()=>S.requisicoes.map(r=>({numero:r.numero,material:r.material,qtd:r.qtd,necessidade:dtBR(r.necessidade),origem:r.origem,status:r.status,justificativa:r.justificativa})),
   auditoria:()=>S.audit.map(a=>({data:new Date(a.ts).toISOString(),usuario:a.user,acao:a.acao,entidade:a.ent,ref:a.ref,detalhe:a.det}))}[ent]||(()=>[]))();
}
function downloadTemplate(ent,all){
  if(typeof XLSX==='undefined'){const e=ENT[ent];return saveFile(`template_${ent}.csv`,toCSV([Object.fromEntries(e.cols.map(c=>[c[0],c[2]]))]))}
  const wb=XLSX.utils.book_new();const list=all?Object.keys(ENT):[ent];
  list.forEach(k=>{const e=ENT[k];const ws=XLSX.utils.aoa_to_sheet([e.cols.map(c=>c[0]),e.cols.map(c=>c[2])]);ws['!cols']=e.cols.map(()=>({wch:18}));XLSX.utils.book_append_sheet(wb,ws,all?k.toUpperCase().slice(0,31):'DADOS')});
  const ins=[['GPlanSiS|WHOUSE — Template de importação'],['Preencha a aba de dados a partir da linha 2 (a linha 2 é exemplo — substitua).'],['Números aceitam 1.234,56 ou 1234.56; datas dd/mm/aaaa ou aaaa-mm-dd.'],['Cabeçalhos de ERPs (ItemCode, B1_COD, CODPROD, WhsCode…) são reconhecidos automaticamente.'],[],['Entidade','Coluna','Descrição','Obrigatória']];
  list.forEach(k=>ENT[k].cols.forEach(c=>ins.push([ENT[k].t,c[0],c[1],c[3]?'SIM':''])));
  const wi=XLSX.utils.aoa_to_sheet(ins);wi['!cols']=[{wch:24},{wch:18},{wch:60},{wch:12}];XLSX.utils.book_append_sheet(wb,wi,'INSTRUCOES');
  saveFile(all?'GPlanSiS_WHOUSE_templates_completo.xlsx':`template_${ent}.xlsx`,new Blob([XLSX.write(wb,{bookType:'xlsx',type:'array'})]));
}
function erpLayout(id){
  if(id==='sapb1')return exportRows('SAPB1_DTW_Items',S.materiais.map(m=>({ItemCode:m.codigo,ItemName:m.descricao,InventoryUOM:m.um,ManageBatchNumbers:m.controlaLote?'tYES':'tNO',MinInventory:m.minimo,MaxInventory:m.maximo,NCMCode:m.ncm,BarCode:m.ean})));
  if(id==='totvs')return exportRows('TOTVS_SB1_produtos',S.materiais.map(m=>({B1_COD:m.codigo,B1_DESC:m.descricao,B1_UM:m.um,B1_GRUPO:m.grupo.slice(0,4).toUpperCase(),B1_RASTRO:m.controlaLote?'L':'N',B1_EMIN:m.minimo,B1_EMAX:m.maximo,B1_PE:m.leadTime,B1_POSIPI:m.ncm.replace(/\D/g,''),B1_CODBAR:m.ean})));
  if(id==='senior')return exportRows('Senior_produtos',S.materiais.map(m=>({codPro:m.codigo,desPro:m.descricao,uniMed:m.um,ctrLot:m.controlaLote?'S':'N',estMin:m.minimo,estMax:m.maximo})));
  if(id==='sankhya')return exportRows('Sankhya_TGFPRO',S.materiais.map(m=>({CODPROD:m.codigo,DESCRPROD:m.descricao,CODVOL:m.um,TIPCONTEST:m.controlaLote?'L':'N',ESTMIN:m.minimo,ESTMAX:m.maximo,NCM:m.ncm})));
  if(id==='odoo')return exportRows('Odoo_product_template',S.materiais.map(m=>({default_code:m.codigo,name:m.descricao,uom_id:m.um,tracking:m.controlaLote?'lot':'none',use_expiration_date:m.controlaValidade,barcode:m.ean})));
  return exportRows('WHOUSE_saldos',exportData('saldos'));
}
VIEWS.dados=()=>`<div class="grid g2">
 <div class="card"><div class="hd">${ic('ul')}<h3>Importar</h3></div><div class="bd">
  <div class="f" style="margin-bottom:10px"><label>Entidade</label><select id="impEnt">${Object.entries(ENT).map(([k,e])=>`<option value="${k}">${e.t}</option>`).join('')}</select></div>
  <div class="drop" id="drop" data-act="pickFile">${ic('ul',28)}<div style="margin-top:6px"><b>Arraste ou clique</b> para selecionar .xlsx, .csv ou .json</div><div class="xs">Validação linha a linha antes de gravar · aceita cabeçalhos de SAP B1, TOTVS, Sankhya, Senior e Odoo</div></div>
 </div></div>
 <div class="card"><div class="hd">${ic('cad')}<h3>Templates do modelo</h3></div><div class="bd">
  <div class="row" style="margin-bottom:10px"><button class="btn pri" data-act="tplAll">${ic('dl')} Template completo (todas as abas)</button></div>
  <div class="alertlist">${Object.entries(ENT).map(([k,e])=>`<div class="it"><span class="grow"><b>${e.t}</b> <span class="xs muted">${e.cols.length} colunas · ${e.cols.filter(c=>c[3]).length} obrigatórias</span></span><button class="btn sm" data-act="tpl" data-e="${k}">XLSX</button><button class="btn sm" data-act="tplCsv" data-e="${k}">CSV</button></div>`).join('')}</div></div></div>
 <div class="card"><div class="hd">${ic('dl')}<h3>Exportar</h3></div><div class="bd"><div class="alertlist">${['materiais','depositos','enderecos','lotes','saldos','ordens','movimentos','pickings','inventarios','requisicoes','auditoria'].map(k=>`<div class="it"><span class="grow" style="text-transform:capitalize">${k}</span><button class="btn sm" data-act="exp" data-e="${k}" data-f="xlsx">XLSX</button><button class="btn sm" data-act="exp" data-e="${k}" data-f="csv">CSV</button><button class="btn sm" data-act="exp" data-e="${k}" data-f="json">JSON</button></div>`).join('')}</div></div></div>
 <div class="card"><div class="hd">${ic('lock')}<h3>Backup & layouts ERP</h3></div><div class="bd">
  <div class="row" style="margin-bottom:10px"><button class="btn pri" data-act="backup">${ic('dl')} Backup completo (JSON)</button><button class="btn" data-act="restore">${ic('ul')} Restaurar backup</button></div>
  <div class="sect">Layouts de cadastro para ERPs</div><div class="row">${CONNECTORS.filter(c=>c.id!=='rest'&&c.id!=='file').map(c=>`<button class="btn sm" data-act="intLayout" data-i="${c.id}">${esc(c.nome)}</button>`).join('')}</div>
  <div class="xs muted" style="margin-top:8px">SAP B1: layout de Items compatível com DTW/Service Layer. Demais layouts seguem os nomes de campo usuais de cada ERP e devem ser conferidos contra a versão do cliente.</div></div></div></div>`;
VIEWS.after_dados=()=>{const d=$('#drop');d.ondragover=e=>{e.preventDefault();d.classList.add('over')};d.ondragleave=()=>d.classList.remove('over');d.ondrop=e=>{e.preventDefault();d.classList.remove('over');const f=e.dataTransfer.files[0];f&&handleImport(f,$('#impEnt').value)}};
let fileMode=null;
async function handleImport(file,ent){
  try{
    if(ent==='__restore'){const j=JSON.parse(await file.text());if(!j.materiais||!j.movs)throw new Error('Arquivo não é um backup WHOUSE');if(await confirmBox('Restaurar backup',`Substitui <b>toda</b> a base atual por ${j.materiais.length} materiais e ${j.movs.length} movimentos do backup. A base atual é perdida se não houver backup dela.`,'Restaurar',true)){S=j;BAL=null;audit('RESTAURAR','SISTEMA',file.name);save();toast('Backup restaurado','ok');render()}return}
    const rows=await readFile(file);if(!rows.length)return toast('Arquivo sem linhas de dados','bad');
    const {ok,errs}=validateRows(ent,rows);
    const prevCols=ENT[ent].cols.map(c=>c[0]);
    const go=await openModal(`Importar ${ENT[ent].t} — ${esc(file.name)}`,`<div class="row" style="margin-bottom:8px">${P(ok.length+' válida(s)','ok')} ${errs.length?P(errs.length+' com erro','bad'):''} <span class="muted sm">de ${rows.length} linhas</span></div>
      ${errs.length?`<div class="sect">Erros (linha da planilha)</div><div style="max-height:160px;overflow:auto" class="sm">${errs.slice(0,80).map(x=>`<div><b class="mono">L${x.line}</b> ${esc(x.e.join('; '))}</div>`).join('')}</div>`:''}
      ${ok.length?`<div class="sect">Prévia</div><div class="tw" style="max-height:220px"><table class="t"><thead><tr>${prevCols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${ok.slice(0,20).map(r=>`<tr>${prevCols.map(c=>`<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:''}`,
      [{t:'Cancelar',v:0},...(errs.length?[{t:'Baixar relatório de erros',v:'err'}]:[]),...(ok.length?[{t:errs.length?'Importar somente válidas':'Importar',v:'go',cls:'pri'}]:[])],{wide:true});
    if(go==='err')return saveFile(`erros_${ent}.csv`,toCSV(errs.map(x=>({linha:x.line,erros:x.e.join(' | ')}))));
    if(go==='go'){const r=commitImport(ent,ok);toast(`${ENT[ent].t}: ${r.ins} incluído(s), ${r.upd} atualizado(s)`,'ok');render()}
  }catch(e){toast(e instanceof BizError?e.message:'Falha na importação: '+e.message,'bad');console.error(e)}
}

/* ---------- AUDITORIA / CONFIG ---------- */
VIEWS.auditoria=()=>tbl('aud',[{t:'Data/hora',v:a=>tsBR(a.ts),s:a=>a.ts},{t:'Usuário',k:'user'},{t:'Ação',h:a=>P(a.acao,'mut'),v:a=>a.acao},{t:'Entidade',k:'ent'},{t:'Referência',k:'ref',cls:'mono'},{t:'Detalhe',k:'det'}],S.audit,{empty:'Sem eventos',tools:`<button class="btn" data-act="exp" data-e="auditoria" data-f="xlsx">${ic('dl')} Exportar</button>`});
VIEWS.config=()=>`<div class="card" style="max-width:820px"><div class="bd"><form id="cfgF"><div class="fg">
  ${F('Empresa','empresa',{value:S.cfg.empresa})}${API.on?F('Usuário conectado','usuario_ro',{value:ME?`${ME.nome} (${ME.papel})`:'',readonly:true}):F('Usuário operador','usuario',{value:S.cfg.usuario})}
  ${F('Modo de operação','modo',{value:S.cfg.modo,opts:[['INDEPENDENTE','Independente — WHOUSE é mestre'],['INTEGRADO','Integrado — ERP é mestre de cadastro/fiscal']]})}
  ${F('Estratégia de saída padrão','estrategia',{value:S.cfg.estrategia,opts:['FEFO','FIFO']})}
  ${F('Alerta de validade (dias)','diasVencAlerta',{type:'number',value:S.cfg.diasVencAlerta})}${F('Tolerância de inventário (%)','toleranciaInv',{type:'number',step:'any',value:S.cfg.toleranciaInv*100})}
  ${F('Inspeção de qualidade padrão no recebimento','inspecaoPadrao',{type:'checkbox',value:S.cfg.inspecaoPadrao})}${F('Contagem cega por padrão','contagemCega',{type:'checkbox',value:S.cfg.contagemCega})}</div>
  <div class="sect">Invariantes travadas</div><div class="sm muted">Saldo negativo: <b>proibido</b> · Saída de lote em quarentena/bloqueado: <b>proibida</b> · Consumo de stock by order por outra ordem: <b>proibido</b> · Ação da IA: <b>somente proposta</b> · Ledger: <b>append-only</b> (correção por estorno/ajuste).</div>
  <div class="sect">Atalhos</div><div class="kbdhelp"><kbd>Ctrl K</kbd><span>Busca global</span><kbd>F2</kbd><span>Escanear código</span><kbd>F4</kbd><span>Assistente IA</span><kbd>Alt N</kbd><span>Nova transferência</span><kbd>Esc</kbd><span>Fechar gaveta/modal</span></div></form></div>
  <div class="df" style="display:flex;gap:8px;justify-content:space-between;padding:10px 14px;border-top:1px solid var(--line)"><div class="row"><button class="btn dan" data-act="resetDemo">Recriar base demo</button><button class="btn dan" data-act="resetEmpty">Base vazia</button></div><button class="btn pri" data-act="cfgSave">Salvar configurações</button></div></div>`;

/* ---------- AÇÕES (delegação única) ---------- */
const A={
 toggleSide:()=>$('#side').classList.toggle('on'),
 closeDrawer:()=>closeDrawer(),
 toggleTheme:()=>{const cur=document.documentElement.dataset.theme||(window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light');const n=cur==='dark'?'light':'dark';document.documentElement.dataset.theme=n;S.cfg.tema=n;save()},
 tab:el=>{sub[el.dataset.k]=el.dataset.v;if(route!=={est:'estoque',pk:'picking',inv:'inventario',pl:'planejamento',cad:'cadastros',it:'integracoes',dg:'digital'}[el.dataset.k])return;render()},
 openScanner:el=>openScanner(el.dataset.target),
 scanGo:el=>{const h=window._scanHits[+el.dataset.i];closeModal(null);h&&h.go()},
 openAI:()=>{openDrawer('Assistente IA · WHOUSE',aiPanelHTML(),'');bindAIPanel();setTimeout(()=>$('#aiIn')?.focus(),250)},
 aiSend:()=>aiSend(), aiAsk:el=>aiSend(el.dataset.q), aiInsights:()=>aiInsights(),
 /* recebimento */
 recNew:()=>recDrawer(null),
 recFromXml:()=>{fileMode='__nfe';$('#fileIn').accept='.xml';$('#fileIn').click()},
 recAddLine:()=>{const tb=$('#recLines tbody');const tmp=document.createElement('tbody');tmp.innerHTML=`<tr>${tb.rows[0]?tb.rows[0].innerHTML:''}</tr>`;const tr=tmp.firstElementChild;$$('input',tr).forEach(i=>i.value='');tb.appendChild(tr)},
 recDelLine:el=>{const tb=$('#recLines tbody');if(tb.rows.length>1)el.closest('tr').remove()},
 recSave:el=>{const r=readRec(el.dataset.rc);if(!r)return;const i=S.recebimentos.findIndex(x=>x.numero===r.numero);if(i>=0)S.recebimentos[i]=r;else S.recebimentos.push(r);audit('SALVAR','RECEBIMENTO',r.numero);save();toast(`${r.numero} salvo`,'ok');closeDrawer();render()},
 recCancel:async el=>{if(!await confirmBox('Cancelar recebimento','O recebimento fica cancelado e nenhum movimento é gerado.','Cancelar recebimento',true))return;const r=S.recebimentos.find(x=>x.numero===el.dataset.rc);r.status='CANCELADO';audit('CANCELAR','RECEBIMENTO',r.numero);save();closeDrawer();render()},
 recPost:async el=>{
  const r=readRec(el.dataset.rc);if(!r)return;
  if(r.itens.some(i=>i.qtdConf==null))return toast('Conferência cega obrigatória: informe a quantidade conferida de todos os itens','bad');
  const div=r.itens.filter(i=>r3(i.qtdConf)!==r3(i.qtdNF));
  if(div.length&&!await confirmBox('Divergência NF × físico',`${div.length} item(ns) divergente(s): ${div.map(i=>`<b>${esc(i.material)}</b> NF ${fmt(i.qtdNF)} / conferido ${fmt(i.qtdConf)}`).join('; ')}.<br><br>A entrada será lançada pela quantidade <b>conferida</b> e a divergência fica registrada para tratativa com o fornecedor.`,'Lançar pelo conferido'))return;
  if(r.inspecao&&!dep('QUA01'))return toast('Depósito QUA01 (quarentena) não existe — crie-o ou desmarque a inspeção','bad');
  try{
   const movs=[];const novos=[];
   r.itens.forEach(i=>{const M=mat(i.material);if(i.qtdConf<=0)return;
    if(M.controlaLote){if(!i.lote)i.lote=autoLote(i.material);if(!lot(i.material,i.lote)){const L={material:i.material,lote:i.lote,fabricacao:'',validade:i.validade||'',fornecedor:r.fornecedor,status:r.inspecao?'QUARENTENA':'LIBERADO',certificado:''};S.lotes.push(L);novos.push(L)}else if(r.inspecao)lot(i.material,i.lote).status='QUARENTENA'}else i.lote='';
    i.cq=r.inspecao?'PENDENTE':'LIBERADO';
    movs.push({tipo:'ENTRADA',material:i.material,lote:i.lote,deposito:r.inspecao?'QUA01':i.deposito,endereco:r.inspecao?(S.enderecos.find(e=>e.deposito==='QUA01')?.codigo||''):i.endereco,qtd:i.qtdConf,custo:i.custo,obs:`NF ${r.nf} · ${r.fornecedor}`})});
   try{postDoc(movs,{doc:r.numero,tipoDoc:'ENTRADA'})}catch(e){novos.forEach(L=>S.lotes.splice(S.lotes.indexOf(L),1));throw e}
   r.status=r.inspecao?'EM_INSPECAO':'CONCLUIDO';r.divergencias=div.length;
   const ix=S.recebimentos.findIndex(x=>x.numero===r.numero);if(ix>=0)S.recebimentos[ix]=r;else S.recebimentos.push(r);
   save();toast(`${r.numero} lançado${r.inspecao?' em quarentena':''}`,'ok');closeDrawer();render();
  }catch(e){toast(e.message,'bad')}},
 cqLiberar:async el=>{const r=S.recebimentos.find(x=>x.numero===el.dataset.rc);const i=r.itens[+el.dataset.ix];
  if(!await confirmBox('Liberar na qualidade',`Transfere <b>${fmt(i.qtdConf)} ${mat(i.material)?.um}</b> de ${esc(i.material)}${i.lote?' lote '+esc(i.lote):''} de QUA01 para <b>${esc(i.deposito)}/${esc(i.endereco||'—')}</b> e marca o lote como LIBERADO.`,'Liberar'))return;
  try{const src=balanceRows({material:i.material,lote:i.lote||'',deposito:'QUA01'})[0];if(!src)throw new BizError('Saldo em quarentena não encontrado');
   postDoc(transferMovs({tipo:'LIBERACAO_CQ',material:i.material,lote:i.lote,de:{dep:'QUA01',end:src.endereco},para:{dep:i.deposito,end:i.endereco},qtd:Math.min(i.qtdConf,src.qtd),obs:'Liberação CQ '+r.numero}),{doc:r.numero+'-CQ'+el.dataset.ix,tipoDoc:'TRANSFERENCIA'});
   if(i.lote)lot(i.material,i.lote).status='LIBERADO';i.cq='LIBERADO';if(r.itens.every(x=>x.cq!=='PENDENTE'))r.status='CONCLUIDO';audit('CQ_LIBERAR','LOTE',i.material+'/'+(i.lote||'—'));save();toast('Liberado','ok');recDrawer(r.numero);render()}catch(e){toast(e.message,'bad')}},
 cqRejeitar:async el=>{const r=S.recebimentos.find(x=>x.numero===el.dataset.rc);const i=r.itens[+el.dataset.ix];
  const v=await openModal('Rejeitar na qualidade',`<p style="margin-top:0">${matLabel(i.material)} ${i.lote?'· lote <span class="mono">'+esc(i.lote)+'</span>':''} · ${fmt(i.qtdConf)}</p><div class="f"><label>Motivo</label><input id="rejMot" placeholder="laudo reprovado, avaria, fora de especificação…"></div>`,[{t:'Cancelar',v:0},{t:'Manter bloqueado em QUA01',v:'blq'},{t:'Devolver ao fornecedor (baixa)',v:'dev',cls:'dan'}]);
  if(!v)return;const mot=($('#rejMot')?.value||'').trim()||'sem motivo';
  try{if(i.lote)lot(i.material,i.lote).status='BLOQUEADO';
   if(v==='dev'){const src=balanceRows({material:i.material,lote:i.lote||'',deposito:'QUA01'})[0];if(src)postDoc([{tipo:'REJEICAO',material:i.material,lote:i.lote,deposito:'QUA01',endereco:src.endereco,qtd:-src.qtd,obs:'Devolução: '+mot,ignoraStatusLote:true}],{doc:r.numero+'-DEV'+el.dataset.ix,tipoDoc:'SAIDA'})}
   i.cq='REJEITADO';i.motivo=mot;if(r.itens.every(x=>x.cq!=='PENDENTE'))r.status='CONCLUIDO';audit('CQ_REJEITAR','LOTE',i.material+'/'+(i.lote||'—'),mot);save();toast('Rejeitado','ok');recDrawer(r.numero);render()}catch(e){toast(e.message,'bad')}},
 printRec:el=>{const r=S.recebimentos.find(x=>x.numero===el.dataset.rc);printLabels(r.itens.map(i=>({code:i.lote?i.material+'|'+i.lote:i.material,t2:mat(i.material)?.descricao,t3:`${fmt(i.qtdConf)} ${mat(i.material)?.um}${i.validade?' · val '+dtBR(i.validade):''}`})),'Etiquetas do recebimento')},
 /* estoque */
 movNew:el=>movDrawer(el.dataset.t,{material:el.dataset.m||''}),
 movFrom:el=>{const k=el.dataset.key;movDrawer('TRANSFERENCIA',{material:k.split('|')[0],key:k})},
 movPost:()=>movPost(),
 ef:el=>{EF[el.dataset.k]=el.value;render()},
 mapDep:el=>{EF.mapDep=el.value;render()},
 endView:el=>endDrawer(el.dataset.d,el.dataset.e),
 endNew:()=>endDrawer(EF.mapDep||'ALM01',null),
 lotNew:()=>lotDrawer(null,null),
 printEnds:el=>{const d=el.dataset.d||$('#etqDep')?.value||'ALM01';printLabels(S.enderecos.filter(e=>e.deposito===d&&e.ativo).map(e=>({code:e.codigo,t2:dep(d)?.nome,t3:`${d} · ${e.tipo}`})),'Etiquetas de endereço '+d)},
 printMats:()=>{const g=$('#etqGrp')?.value;printLabels(S.materiais.filter(m=>m.ativo&&(!g||m.grupo===g)).map(m=>({code:m.codigo,t2:m.descricao,t3:m.um+' · '+m.grupo})),'Etiquetas de material')},
 printLots:()=>printLabels(S.lotes.filter(l=>balanceRows({material:l.material,lote:l.lote}).some(b=>b.qtd>0)).map(l=>({code:l.material+'|'+l.lote,t2:mat(l.material)?.descricao,t3:`Lote ${l.lote}${l.validade?' · val '+dtBR(l.validade):''}`})),'Etiquetas de lote'),
 /* ordens / stock by order */
 ordNew:()=>ordDrawer(null), ordEdit:el=>ordDrawer(el.dataset.o), ordSave:el=>ordSave(el.dataset.o),
 ordSegAll:async el=>{const o=ord(el.dataset.o);const movs=[];const falta=[];const res=reservedMap();
  o.itens.forEach(i=>{const seg=balanceRows({material:i.material,tipoEstoque:'ORDEM',ordem:o.numero}).reduce((s,b)=>s+b.qtd,0);const cons=S.movs.filter(m=>m.ordem===o.numero&&m.material===i.material&&['PICKING','SAIDA'].includes(m.tipo)).reduce((s,m)=>s-m.qtd,0);let need=r3(i.qtd-seg-cons);if(need<=0)return;
   const a=allocate(i.material,need,{usarNormal:true});a.aloc.filter(x=>x.tipoEstoque==='NORMAL').forEach(x=>movs.push(...transferMovs({tipo:'RESERVA_ORDEM',material:i.material,lote:x.lote,de:{dep:x.deposito,end:x.endereco,tipoEstoque:'NORMAL'},para:{dep:x.deposito,end:x.endereco,tipoEstoque:'ORDEM',ordem:o.numero},qtd:x.qtd,obs:'Segregação p/ '+o.numero})));if(a.falta)falta.push(`${i.material}: ${fmt(a.falta)}`)});
  if(!movs.length)return toast(falta.length?'Sem saldo livre para segregar: '+falta.join('; '):'Ordem já coberta','bad');
  if(!await confirmBox('Segregar para a ordem',`Converte <b>${movs.length/2}</b> posição(ões) de estoque NORMAL em estoque da ordem <b>${esc(o.numero)}</b> (FEFO). Esse saldo deixa de estar disponível para outras demandas.${falta.length?`<br><br><b style="color:var(--bad)">Sem cobertura:</b> ${esc(falta.join('; '))}`:''}`,'Segregar'))return;
  try{postDoc(movs,{doc:nextSeq('SEG'),tipoDoc:'RESERVA_ORDEM'});toast('Saldo segregado','ok');render()}catch(e){toast(e.message,'bad')}},
 ordRelease:async el=>{const o=el.dataset.o,m=el.dataset.m;const rows=balanceRows({material:m,tipoEstoque:'ORDEM',ordem:o});const q=rows.reduce((s,b)=>s+b.qtd,0);
  if(!await confirmBox('Liberar estoque da ordem',`Devolve <b>${fmt(q)} ${mat(m)?.um}</b> de ${esc(m)} da ordem ${esc(o)} para o estoque NORMAL (disponível a todos).`,'Liberar'))return;
  try{postDoc(rows.flatMap(b=>transferMovs({tipo:'RESERVA_ORDEM',material:m,lote:b.lote,de:{dep:b.deposito,end:b.endereco,tipoEstoque:'ORDEM',ordem:o},para:{dep:b.deposito,end:b.endereco,tipoEstoque:'NORMAL'},qtd:b.qtd,obs:'Liberação da ordem '+o})),{doc:nextSeq('LIB'),tipoDoc:'RESERVA_ORDEM'});toast('Liberado','ok');render()}catch(e){toast(e.message,'bad')}},
 pickFromOrd:el=>pickNewDrawer(el.dataset.o),
 /* picking */
 pickNew:()=>pickNewDrawer(''),
 pkAddLine:()=>{const tb=$('#pkLines tbody');tb.insertAdjacentHTML('beforeend',pkLine({material:'',qtd:''}))},
 rmRow:el=>{const tb=el.closest('tbody');if(tb.rows.length>1)el.closest('tr').remove()},
 pkSim:()=>pickCreate(true), pkCreate:()=>pickCreate(false),
 sepFull:el=>{const inp=$(`.sepIn[data-li="${el.dataset.li}"][data-ai="${el.dataset.ai}"]`);const p=S.pickings.find(x=>x.numero===$('#dTitle').textContent.replace('Picking ',''));const a=p.linhas[+el.dataset.li].aloc[+el.dataset.ai];a.sep=a.qtd;if(p.status==='ABERTO')p.status='EM_SEPARACAO';save();pickDrawer(p.numero)},
 pkFinish:el=>pickFinish(el.dataset.p),
 pkCancel:async el=>{if(!await confirmBox('Cancelar picking','As reservas de todas as linhas são liberadas imediatamente. Nenhum movimento é gerado.','Cancelar picking',true))return;const p=S.pickings.find(x=>x.numero===el.dataset.p);p.status='CANCELADO';audit('CANCELAR','PICKING',p.numero);save();closeDrawer();render()},
 pkRealloc:el=>{const p=S.pickings.find(x=>x.numero===el.dataset.p);
  p.linhas.forEach(l=>{const done=l.aloc.filter(a=>(a.sep||0)>0).map(a=>({...a,qtd:a.sep}));const got=done.reduce((s,a)=>s+a.qtd,0);const need=r3(l.qtd-got);const tmp={linhas:[{material:l.material,aloc:l.aloc}]};const a=need>0?allocate(l.material,need,{ordem:p.ordem,estrategia:p.estrategia,usarNormal:p.usarNormal!==false,excluirPicking:tmp}):{aloc:[],falta:0};l.aloc=[...done,...a.aloc];l.falta=a.falta});
  audit('REALOCAR','PICKING',p.numero);save();toast('Realocado','ok');pickDrawer(p.numero);render()},
 pkShip:async el=>{const p=S.pickings.find(x=>x.numero===el.dataset.p);
  if(!await confirmBox('Confirmar expedição',`Baixa do estoque da doca <b>${esc(p.destino.dep)}/${esc(p.destino.end||'—')}</b> todas as quantidades separadas deste picking. Operação definitiva (estorno só por entrada de devolução).`,'Expedir'))return;
  const movs=[];p.linhas.forEach(l=>l.aloc.forEach(a=>{if((a.sep||0)>0)movs.push({tipo:'SAIDA',material:l.material,lote:a.lote,deposito:p.destino.dep,endereco:p.destino.end,tipoEstoque:a.tipoEstoque,ordem:a.ordem,qtd:-a.sep,obs:'Expedição '+p.numero})}));
  try{postDoc(movs,{doc:p.numero+'-EXP',tipoDoc:'SAIDA'});p.status='EXPEDIDO';p.expedido=Date.now();save();closeDrawer();toast('Expedido','ok');render()}catch(e){toast(e.message,'bad')}},
 pkPrint:el=>{const p=S.pickings.find(x=>x.numero===el.dataset.p);const rows=p.linhas.flatMap(l=>l.aloc.map(a=>({...a,material:l.material}))).sort((a,b)=>(a.deposito+a.endereco).localeCompare(b.deposito+b.endereco,'pt-BR',{numeric:true}));
  const html=`<div style="padding:10px;font-family:Arial"><h2 style="margin:0">Lista de separação ${p.numero}</h2><div>${p.ordem||'Avulso'} · ${p.estrategia} · ${new Date().toLocaleString('pt-BR')}</div>${code128(p.numero,40)}<table border="1" cellspacing="0" cellpadding="4" style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px"><tr><th>#</th><th>Endereço</th><th>Material</th><th>Descrição</th><th>Lote</th><th>Qtd</th><th>Separado</th></tr>${rows.map((r,i)=>`<tr><td>${i+1}</td><td>${r.deposito}/${esc(r.endereco)}</td><td>${esc(r.material)}</td><td>${esc(mat(r.material)?.descricao||'')}</td><td>${esc(r.lote||'')}</td><td style="text-align:right">${fmt(r.qtd)}</td><td></td></tr>`).join('')}</table><p>Separador: ____________ Conferente: ____________</p></div>`;
  $('#printArea').innerHTML=html;setTimeout(()=>window.print(),100)},
 pickWave:()=>{const sel=$$('.pkSel:checked').map(i=>i.value);if(sel.length<1)return toast('Marque um ou mais pickings na lista','bad');
  const agg={};sel.forEach(n=>{const p=S.pickings.find(x=>x.numero===n);p.linhas.forEach(l=>l.aloc.forEach(a=>{const k=a.deposito+'/'+a.endereco+'|'+l.material+'|'+a.lote;agg[k]=agg[k]||{end:a.deposito+'/'+a.endereco,material:l.material,lote:a.lote,qtd:0,pk:new Set()};agg[k].qtd+=a.qtd-(a.sep||0);agg[k].pk.add(n)}))});
  const rows=Object.values(agg).filter(r=>r.qtd>0).sort((a,b)=>a.end.localeCompare(b.end,'pt-BR',{numeric:true}));
  const html=`<table class="t"><thead><tr><th>#</th><th>Endereço</th><th>Material</th><th>Lote</th><th class="num">Qtd total</th><th>Pickings</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td>${i+1}</td><td class="mono">${esc(r.end)}</td><td>${matLabel(r.material)}</td><td class="mono">${esc(r.lote||'—')}</td><td class="num">${fmt(r.qtd)}</td><td class="xs mono">${[...r.pk].join(', ')}</td></tr>`).join('')}</tbody></table>`;
  openModal(`Onda de separação · ${sel.length} picking(s) · ${rows.length} paradas`,html,[{t:'Fechar',v:0},{t:'Imprimir rota',v:'p',cls:'pri'}],{wide:true}).then(v=>{if(v==='p'){$('#printArea').innerHTML=`<div style="padding:10px;font-family:Arial"><h2>Onda ${sel.join(', ')}</h2>${html}</div>`;setTimeout(()=>window.print(),100)}})},
 /* inventário */
 invNew:()=>invNewDrawer(),
 invCreate:()=>invCreate(readForm($('#invF'))),
 invCiclico:()=>{const last={};S.inventarios.filter(i=>i.status==='APROVADO').forEach(i=>i.linhas.forEach(l=>{last[l.material]=Math.max(last[l.material]||0,i.aprovado||i.criado)}));
  const lim={A:30,B:90,C:180};const mats=S.materiais.filter(m=>saldoMat(m.codigo)>0&&(Date.now()-(last[m.codigo]||0))/864e5>lim[m.abc||'C']).sort((a,b)=>'ABC'.indexOf(a.abc)-'ABC'.indexOf(b.abc)).slice(0,15).map(m=>m.codigo);
  if(!mats.length)return toast('Nenhum item vencido no calendário cíclico','ok');invCreate({mats,cega:S.cfg.contagemCega},`Cíclico ABC · ${mats.length} itens`)},
 invCancel:async el=>{if(!await confirmBox('Cancelar contagem','As quantidades digitadas são descartadas; nenhum ajuste é gerado.','Cancelar contagem',true))return;const i=S.inventarios.find(x=>x.numero===el.dataset.n);i.status='CANCELADO';save();closeDrawer();render()},
 invClose:el=>{const i=S.inventarios.find(x=>x.numero===el.dataset.n);const nc=i.linhas.filter(l=>l.contado==null).length;confirmBox('Encerrar contagem',`${nc?`<b>${nc}</b> linha(s) não contadas serão ignoradas (sem ajuste). `:''}A contagem vai para revisão, onde saldo do sistema e divergências passam a ser exibidos.`,'Encerrar').then(ok=>{if(!ok)return;i.status='EM_REVISAO';save();invDrawer(i.numero);render()})},
 invReopen:el=>{const i=S.inventarios.find(x=>x.numero===el.dataset.n);i.status='EM_CONTAGEM';save();invDrawer(i.numero)},
 invApprove:el=>invApprove(el.dataset.n),
 invAddLine:async el=>{const inv=S.inventarios.find(x=>x.numero===el.dataset.n);
  const v=await openModal('Item encontrado na contagem',`<form id="ilF"><div class="fg">${F('Material','material',{opts:matOpts(),full:true})}${F('Lote','lote',{})}${F('Depósito','deposito',{opts:depOpts(false)})}${F('Endereço','endereco',{})}${F('Quantidade contada','contado',{type:'number',step:'any'})}</div></form>`,[{t:'Cancelar',v:0},{t:'Adicionar',v:1,cls:'pri'}]);
  if(!v)return;const o=readForm($('#ilF'));const q=parseNum(o.contado);if(!o.material||!(q>=0))return toast('Material e quantidade obrigatórios','bad');if(mat(o.material).controlaLote&&!o.lote)return toast('Material controla lote','bad');if(o.endereco&&!endr(o.deposito,o.endereco.toUpperCase()))return toast('Endereço inexistente','bad');
  inv.linhas.push({material:o.material,lote:o.lote,deposito:o.deposito,endereco:o.endereco.toUpperCase(),tipoEstoque:'NORMAL',ordem:'',sistema:0,contado:q,recontagem:null,obs:'encontrado'});save();invDrawer(inv.numero)},
 invPrint:el=>{const i=S.inventarios.find(x=>x.numero===el.dataset.n);$('#printArea').innerHTML=`<div style="padding:10px;font-family:Arial"><h2 style="margin:0">Folha de contagem ${i.numero}</h2><div>${esc(i.escopo)} · ${i.cega?'CEGA':''}</div><table border="1" cellspacing="0" cellpadding="5" style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px"><tr><th>Posição</th><th>Material</th><th>Descrição</th><th>Lote</th>${i.cega?'':'<th>Sistema</th>'}<th style="width:90px">Contado</th></tr>${i.linhas.map(l=>`<tr><td>${l.deposito}/${esc(l.endereco)}</td><td>${esc(l.material)}</td><td>${esc(mat(l.material)?.descricao||'')}</td><td>${esc(l.lote||'')}</td>${i.cega?'':`<td>${fmt(l.sistema)}</td>`}<td></td></tr>`).join('')}</table><p>Contador: ____________ Data: ___/___/____</p></div>`;setTimeout(()=>window.print(),100)},
 kmat:el=>{sub.kmat=el.value;render()},
 goKardex:el=>{sub.inv='kardex';sub.kmat=el.dataset.m;closeDrawer();location.hash='#/inventario';render()},
 exportKardex:el=>{const m=el.dataset.m;let s=0;exportRows('kardex_'+m,S.movs.filter(x=>x.material===m).sort((a,b)=>a.ts-b.ts).map(x=>{s=r3(s+x.qtd);return{data:new Date(x.ts).toLocaleString('pt-BR'),tipo:x.tipo,doc:x.doc,lote:x.lote,deposito:x.deposito,endereco:x.endereco,estoque:x.tipoEstoque,ordem:x.ordem,entrada:x.qtd>0?x.qtd:'',saida:x.qtd<0?-x.qtd:'',saldo:s,custo:x.custo,usuario:x.user}}),'xlsx')},
 /* planejamento */
 repAll:()=>$$('.repSel').forEach(c=>c.checked=true),
 repGen:()=>{const sel=$$('.repSel:checked').map(c=>c.value);if(!sel.length)return toast('Selecione itens com sugestão','bad');const rep=reposicao();sel.forEach(c=>{const r=rep.find(x=>x.m.codigo===c);newReq(c,r.sug,'MRP',`${r.crit} · cobertura ${isFinite(r.cob)?r.cob.toFixed(1)+'d':'—'} · LT ${r.m.leadTime}d`)});toast(`${sel.length} requisição(ões) proposta(s)`,'ok');sub.pl='req';render()},
 exportRep:()=>exportRows('reposicao_mrp',reposicao().map(r=>({material:r.m.codigo,descricao:r.m.descricao,um:r.m.um,abc:r.m.abc,xyz:r.xyz.cls,disponivel:r.disp,consumo_dia:+r.media.toFixed(3),cobertura_dias:isFinite(r.cob)?+r.cob.toFixed(1):'',lead_time:r.m.leadTime,necessidade_ordens:r.ordNec,segregado:r.ordSeg,ponto_pedido:r.pp,maximo:r.m.maximo,sugestao:r.sug,situacao:r.crit})),'xlsx'),
 reqApprove:el=>{const r=S.requisicoes.find(x=>x.numero===el.dataset.r);r.status='APROVADA';r.aprovador=userName();audit('APROVAR','REQUISICAO',r.numero);save();render()},
 reqReject:el=>{const r=S.requisicoes.find(x=>x.numero===el.dataset.r);r.status='REJEITADO';audit('REJEITAR','REQUISICAO',r.numero);save();render()},
 reqSend:el=>{const r=S.requisicoes.find(x=>x.numero===el.dataset.r);const act=S.integracoes.filter(i=>i.ativo&&i.entidades.includes('REQUISICOES'));
  if(!act.length){r.status='ENVIADA';save();exportRows('requisicao_'+r.numero,[{numero:r.numero,material:r.material,qtd:r.qtd,necessidade:r.necessidade}],'csv');return render()}
  act.forEach(i=>S.outbox.unshift({id:uid('OB'),idem:`${i.id}:REQUISICAO:${r.numero}`,destino:i.id,kind:'REQUISICAO',doc:r.numero,ts:Date.now(),status:'PENDENTE',tentativas:0,log:[],
   payload:i.id==='sapb1'?{DocDate:todayISO(),DocDueDate:r.necessidade,Comments:'WHOUSE '+r.numero,DocumentLines:[{ItemCode:r.material,Quantity:r.qtd,RequiredDate:r.necessidade}]}:{tipo:'requisicao_compra',numero:r.numero,material:r.material,qtd:r.qtd,necessidade:r.necessidade}}));
  r.status='ENVIADA';audit('ENVIAR','REQUISICAO',r.numero);save();toast('Requisição enfileirada para o ERP','ok');render()},
 recalcABC:()=>{calcABC();save();toast('ABC recalculado','ok');render()},
 /* cadastros */
 matNew:()=>matDrawer(null), matSave:el=>matSave(el.dataset.m), depNew:()=>depDrawer(null),
 endBulk:()=>simpleDrawer('Gerar endereços em lote',F('Depósito','deposito',{opts:depOpts(false)})+F('Ruas (separadas por vírgula)','ruas',{value:'D,E'})+F('Prédios por rua','predios',{type:'number',value:4})+F('Níveis por prédio','niveis',{type:'number',value:3})+F('Capacidade picking (nível 1)','capP',{type:'number',value:200})+F('Capacidade pulmão','capU',{type:'number',value:600}),
  o=>{let n=0;o.ruas.split(',').map(x=>x.trim().toUpperCase()).filter(Boolean).forEach(r=>{for(let p=1;p<=+o.predios;p++)for(let l=1;l<=+o.niveis;l++){const c=`${r}-${String(p).padStart(2,'0')}-${l}`;if(!endr(o.deposito,c)){S.enderecos.push({deposito:o.deposito,codigo:c,tipo:l===1?'PICKING':'PULMAO',capacidade:l===1?+o.capP:+o.capU,ativo:true});n++}}});audit('GERAR','ENDERECO',o.deposito,n+' endereços');save();closeDrawer();toast(`${n} endereço(s) criados`,'ok');render()}),
 /* coletor */
 colRec:()=>{location.hash='#/recebimento';setTimeout(()=>recDrawer(null),50)},
 colPick:()=>{const p=S.pickings.filter(x=>['ABERTO','EM_SEPARACAO'].includes(x.status)).sort((a,b)=>({URGENTE:0,ALTA:1,NORMAL:2}[a.prioridade]-{URGENTE:0,ALTA:1,NORMAL:2}[b.prioridade])||a.criado-b.criado)[0];p?pickDrawer(p.numero):toast('Nenhum picking em aberto')},
 colCount:()=>{const i=S.inventarios.find(x=>x.status==='EM_CONTAGEM');i?invDrawer(i.numero):A.invCiclico()},
 pwaInstall:async()=>{if(!deferredPrompt)return toast('Instalação indisponível aqui — hospede o pacote PWA em HTTPS');deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null},
 exportPWA:async()=>{const c=document.documentElement.cloneNode(true);try{const js=await (await fetch('app.js')).text();const sc=c.querySelector('script[src^="app.js"]');if(sc){sc.removeAttribute('src');sc.textContent=js}const xl=c.querySelector('script[src*="xlsx"]');if(xl)xl.setAttribute('src','https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');c.querySelector('#login')?.remove()}catch(e){}['#view','#nav','#bottomnav','#dBody','#dFoot','#mBody','#mFoot','#printArea','#toasts','#logoMark'].forEach(s=>{const e=c.querySelector(s);if(e)e.innerHTML=''});c.querySelectorAll('.on').forEach(e=>e.classList.remove('on'));saveFile('GPlanSiS_WHOUSE.html','<!DOCTYPE html>\n'+c.outerHTML)},
 /* integrações */
 cfgMode:()=>{S.cfg.modo=S.cfg.modo==='INDEPENDENTE'?'INTEGRADO':'INDEPENDENTE';audit('CONFIG','SISTEMA','modo',S.cfg.modo);save();render()},
 obProcess:async()=>{const r=await processOutbox();toast(`Fila: ${r.ok} enviada(s)${API.on?'':' (simulação)'} · ${r.fail} retida(s)`,r.fail?'':'ok');render()},
 obRetry:async el=>{const o=S.outbox.find(x=>x.id===el.dataset.o);if(o.status==='DLQ'){o.status='ERRO';o.tentativas=0}await processOutbox([o.id]);render()},
 obView:el=>{const o=S.outbox.find(x=>x.id===el.dataset.o);openModal(`${o.kind} · ${o.doc} → ${conn(o.destino)?.nome}`,`<div class="xs muted mono" style="margin-bottom:6px">${esc(o.idem)} · ${esc(conn(o.destino)?.endpoints[o.kind]||'')}</div><pre class="code">${esc(JSON.stringify(o.payload,null,2))}</pre>${o.log.length?`<div class="sect">Log</div>${o.log.map(l=>`<div class="sm"><span class="mono xs">${tsBR(l.ts)}</span> ${esc(l.msg)}</div>`).join('')}`:''}`,[{t:'Fechar',v:0},{t:'Copiar JSON',v:'c',cls:'pri'}],{wide:true}).then(v=>{if(v==='c')navigator.clipboard?.writeText(JSON.stringify(o.payload,null,2)).then(()=>toast('Copiado','ok'),()=>toast('Área de transferência indisponível','bad'))})},
 obExport:()=>saveFile('whouse_outbox.json',JSON.stringify(S.outbox,null,2)),
 obPurge:async()=>{const n=S.outbox.filter(o=>o.status==='ENVIADO').length;if(!n)return toast('Nenhum enviado para limpar');if(!await confirmBox('Limpar enviados',`Remove ${n} mensagem(ns) já enviadas da fila local. Os movimentos não são afetados.`,'Limpar',true))return;S.outbox=S.outbox.filter(o=>o.status!=='ENVIADO');save();render()},
 intCfg:el=>intCfgDrawer(el.dataset.i), intSave:el=>intSave(el.dataset.i),
 intToggle:el=>{const i=S.integracoes.find(x=>x.id===el.dataset.i);i.ativo=!i.ativo;audit('CONFIG','INTEGRACAO',i.id,i.ativo?'ativado':'desativado');save();render()},
 intTest:el=>{const i=S.integracoes.find(x=>x.id===el.dataset.i),c=conn(i.id);const chk=[['URL configurada',!!i.url],['URL segura (https/sftp)',/^(https|sftp):/.test(i.url||'')],['Empresa/banco informado',!!i.empresa||i.id!=='sapb1'],['Mapa de campos completo',i.mapa.every(([,b])=>b)],['Contrato do ERP confirmado',c.confirmado]];
  openModal(`Teste · ${c.nome}`,`${chk.map(([t,ok])=>`<div class="row" style="padding:4px 0"><span class="dot" style="background:${ok?'var(--ok)':'var(--bad)'}"></span><span class="grow">${t}</span><b>${ok?'OK':'pendente'}</b></div>`).join('')}<div class="sm muted" style="margin-top:10px">Validação local de configuração. O teste de conectividade real (login no ${esc(c.proto)}) é executado pelo gateway — o navegador não abre conexão direta com o ERP por segurança.</div>`)},
 intLayout:el=>erpLayout(el.dataset.i),
 /* dados */
 pickFile:()=>{fileMode=$('#impEnt').value;$('#fileIn').accept='.xlsx,.xls,.csv,.json';$('#fileIn').click()},
 tpl:el=>downloadTemplate(el.dataset.e,false), tplAll:()=>downloadTemplate(null,true),
 tplCsv:el=>{const e=ENT[el.dataset.e];saveFile(`template_${el.dataset.e}.csv`,toCSV([Object.fromEntries(e.cols.map(c=>[c[0],c[2]]))]))},
 exp:el=>exportRows('whouse_'+el.dataset.e+'_'+todayISO(),exportData(el.dataset.e),el.dataset.f),
 backup:()=>saveFile(`whouse_backup_${todayISO()}.json`,JSON.stringify(S)),
 restore:()=>{fileMode='__restore';$('#fileIn').accept='.json';$('#fileIn').click()},
 cfgSave:()=>{const o=readForm($('#cfgF'));Object.assign(S.cfg,{empresa:o.empresa,usuario:API.on?S.cfg.usuario:(o.usuario||'operador'),modo:o.modo,estrategia:o.estrategia,diasVencAlerta:+o.diasVencAlerta||45,toleranciaInv:(parseNum(o.toleranciaInv)||2)/100,inspecaoPadrao:o.inspecaoPadrao,contagemCega:o.contagemCega});audit('CONFIG','SISTEMA','cfg');save();toast('Configurações salvas','ok');render()},
 resetDemo:async()=>{if(!await confirmBox('Recriar base de demonstração',(API.on?'Substitui a base <b>compartilhada do servidor</b> (todos os usuários) pela base demo. A versão atual fica no histórico e pode ser restaurada em Usuários → Versões.':'Apaga todos os dados locais e gera novamente a base demo.')+' Faça backup antes se precisar.','Recriar',true))return;seed();render();toast('Base demo recriada','ok')},
 resetEmpty:async()=>{if(!await confirmBox('Iniciar base vazia',(API.on?'Substitui a base <b>compartilhada do servidor</b> por uma base vazia (a atual fica no histórico). ':'Apaga todos os dados locais. ')+'Ficam apenas ALM01, QUA01 e EXP01 e os conectores. Use Importar/Templates para carregar seus cadastros.','Apagar tudo',true))return;
  const integ=S.integracoes;S=EMPTY();S.integracoes=integ;S.depositos=[{codigo:'ALM01',nome:'Almoxarifado',tipo:'ALMOXARIFADO',erp:'01',ativo:true,resp:''},{codigo:'QUA01',nome:'Quarentena',tipo:'QUARENTENA',erp:'98',ativo:true,resp:''},{codigo:'EXP01',nome:'Expedição',tipo:'EXPEDICAO',erp:'03',ativo:true,resp:''}];
  S.enderecos=[{deposito:'QUA01',codigo:'Q1',tipo:'QUARENTENA',capacidade:9999,ativo:true},{deposito:'EXP01',codigo:'DOCA1',tipo:'DOCA',capacidade:9999,ativo:true}];BAL=null;audit('RESET','SISTEMA','base vazia');save();render()}
};
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el||el.tagName==='SELECT')return;const f=A[el.dataset.act];if(!f)return;if(!actAllowed(el.dataset.act)){e.preventDefault();return}if(el.tagName==='A'&&el.getAttribute('href')?.startsWith('#/')){setTimeout(()=>f(el,e),0);return}e.preventDefault();f(el,e)});
document.addEventListener('change',e=>{const el=e.target;if(el.tagName==='SELECT'&&el.dataset.act&&A[el.dataset.act]&&actAllowed(el.dataset.act))A[el.dataset.act](el,e)});

/* NF-e XML → recebimento pré-preenchido */
async function importNFe(file){
  const x=new DOMParser().parseFromString(await file.text(),'application/xml');const g=(n,t)=>(n.getElementsByTagName(t)[0]?.textContent||'').trim();
  if(x.getElementsByTagName('parsererror').length||!x.getElementsByTagName('det').length)return toast('XML não parece ser uma NF-e válida','bad');
  const emit=x.getElementsByTagName('emit')[0];const itens=[...x.getElementsByTagName('det')].map(d=>{const cod=g(d,'cProd').toUpperCase();const ean=g(d,'cEAN');const M=mat(cod)||S.materiais.find(m=>m.ean&&m.ean===ean);const rastro=d.getElementsByTagName('rastro')[0];
    return{material:M?.codigo||'',lote:rastro?g(rastro,'nLote'):'',validade:rastro?g(rastro,'dVal'):'',qtdNF:parseNum(g(d,'qCom')),qtdConf:null,custo:parseNum(g(d,'vUnCom')),deposito:'ALM01',endereco:'',_x:g(d,'xProd')}});
  const nao=itens.filter(i=>!i.material);
  const r={numero:'',fornecedor:emit?g(emit,'xNome'):'',nf:g(x,'nNF'),pedido:g(x,'xPed'),data:(g(x,'dhEmi')||todayISO()).slice(0,10),status:'RASCUNHO',inspecao:S.cfg.inspecaoPadrao,itens};
  const n=nextSeq('RC');r.numero=n;S.recebimentos.push(r);audit('IMPORTAR','NFE',n,'NF '+r.nf);save();render();recDrawer(n);
  if(nao.length)toast(`${nao.length} item(ns) da NF sem correspondência de material (${nao.map(i=>i._x).slice(0,3).join('; ')}) — selecione manualmente`,'bad');else toast('NF-e importada — faça a conferência cega','ok');
}
$('#fileIn').onchange=e=>{const f=e.target.files[0];e.target.value='';if(!f)return;if(fileMode==='__nfe')importNFe(f);else handleImport(f,fileMode||'materiais')};

/* ---------- BUSCA GLOBAL / ATALHOS ---------- */
$('#gsearch').addEventListener('keydown',e=>{if(e.key!=='Enter')return;const q=e.target.value.trim();if(!q)return;const ql=q.toLowerCase();
  const hits=[];S.materiais.filter(m=>(m.codigo+' '+m.descricao+' '+m.ean).toLowerCase().includes(ql)).slice(0,8).forEach(m=>hits.push({t:'Material',h:`${matLabel(m.codigo)} · ${fmt(saldoMat(m.codigo))} ${m.um}`,go:()=>matDrawer(m.codigo)}));
  S.lotes.filter(l=>l.lote.toLowerCase().includes(ql)).slice(0,5).forEach(l=>hits.push({t:'Lote',h:`${esc(l.lote)} · ${esc(l.material)}`,go:()=>lotDrawer(l.material,l.lote)}));
  S.ordens.filter(o=>(o.numero+' '+o.descricao).toLowerCase().includes(ql)).forEach(o=>hits.push({t:'Ordem',h:`${esc(o.numero)} · ${esc(o.descricao)}`,go:()=>ordDrawer(o.numero)}));
  S.pickings.filter(p=>p.numero.toLowerCase().includes(ql)).forEach(p=>hits.push({t:'Picking',h:p.numero,go:()=>pickDrawer(p.numero)}));
  S.recebimentos.filter(r=>(r.numero+' '+r.nf+' '+r.fornecedor).toLowerCase().includes(ql)).forEach(r=>hits.push({t:'Recebimento',h:`${r.numero} · NF ${esc(r.nf)} · ${esc(r.fornecedor)}`,go:()=>recDrawer(r.numero)}));
  S.enderecos.filter(x=>x.codigo.toLowerCase()===ql).forEach(x=>hits.push({t:'Endereço',h:`${x.deposito}/${esc(x.codigo)}`,go:()=>endDrawer(x.deposito,x.codigo)}));
  window._scanHits=hits;openModal(`Busca: ${q}`,hits.length?hits.map((h,i)=>`<div class="step" style="cursor:pointer" data-act="scanGo" data-i="${i}"><div class="n">${i+1}</div><div class="grow"><div class="xs muted">${h.t}</div>${h.h}</div></div>`).join(''):'<div class="muted">Nada encontrado.</div>')});
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#gsearch').focus();$('#gsearch').select()}
  else if(e.key==='F2'){e.preventDefault();openScanner()}
  else if(e.key==='F4'){e.preventDefault();A.openAI()}
  else if(e.altKey&&e.key.toLowerCase()==='n'){e.preventDefault();movDrawer('TRANSFERENCIA')}
  else if(e.key==='Escape'){if($('#modal').classList.contains('on'))closeModal(false);else if($('#drawer').classList.contains('on'))closeDrawer();else $('#side').classList.remove('on')}
});

/* =====================================================================
   SERVIDOR — sessão, sincronização multiusuário e gerenciador de usuários.
   Modo servidor: a página foi servida por um WHOUSE com /api (whouse.gplansis.com).
   Modo arquivo: HTML aberto sozinho — tudo local, como antes.
   Sincronização: cada save() envia o documento com a versão-base; se outro usuário
   gravou antes (409), faz merge 3-vias por entidade (base × local × servidor),
   renumera documentos que colidiram e reenvia. Ledger é união por id (append-only).
   ===================================================================== */
const API={on:false,online:true,pushing:false,again:false,timer:null,pending:false,lastErr:'',chg:0};
let ME=null,BASE=null,BASEV=0,DIRTY=false;
const CACHE_KEY='whouse_srv_cache_v1';
const ROLE_RANK={CONSULTA:0,OPERADOR:1,GESTOR:2,ADMIN:3};
const PAPEL_TXT={ADMIN:'Administrador',GESTOR:'Gestor',OPERADOR:'Operador',CONSULTA:'Consulta (somente leitura)'};
const MOD_TXT={dashboard:'Painel',recebimento:'Recebimento & CQ',estoque:'Estoque & Endereços',picking:'Picking & Expedição',inventario:'Inventário & Kardex',planejamento:'Planejamento & IA',cadastros:'Cadastros',digital:'Digitalização',integracoes:'Integrações ERP',dados:'Importar / Exportar',auditoria:'Auditoria',config:'Configurações',usuarios:'Usuários & Acessos'};
function userName(){return ME?ME.nome:(S?.cfg?.usuario||'operador')}
const allowed=r=>r==='usuarios'?!!(API.on&&ME&&ME.papel==='ADMIN'):(!ME||ME.modulosEfetivos.includes(r));
function navRoutes(){const out=[];let g=null;for(const r of ROUTES){if(r.g){g=r;continue}if(!allowed(r.id))continue;if(g){out.push(g);g=null}out.push(r)}return out}
const READ_ACTS=new Set(['toggleSide','closeDrawer','toggleTheme','tab','openScanner','scanGo','openAI','aiSend','aiAsk','aiInsights','ef','mapDep','endView','kmat','goKardex','exportKardex','exp','exportRep','obView','obExport','printRec','printEnds','printMats','printLots','pkPrint','invPrint','pickWave','intLayout','intTest','tpl','tplAll','tplCsv','backup','userMenu','pwaInstall','exportPWA','movNew','movFrom','recNew','lotNew','endNew','ordNew','ordEdit','matNew','depNew','pickNew','invNew','pickFromOrd','colRec','colPick','usrTab','usrReload','logout','senhaPropria']);
const GESTOR_ACTS=new Set(['invApprove','reqApprove','reqReject','reqSend','cqLiberar','cqRejeitar','cfgSave','cfgMode','intCfg','intSave','intToggle','obPurge','obProcess','obRetry','repGen']);
const ADMIN_ACTS=new Set(['resetDemo','resetEmpty','restore','usrNew','usrEdit','usrSave','usrSenha','usrDesbloq','usrSessoes','usrToggle','verRestaurar']);
function actAllowed(act){
  if(!ME)return true;
  if(ME.papel==='CONSULTA'&&!READ_ACTS.has(act)){toast('Perfil CONSULTA: somente leitura','bad');return false}
  if(ADMIN_ACTS.has(act)&&ME.papel!=='ADMIN'){toast('Ação restrita ao administrador','bad');return false}
  if(GESTOR_ACTS.has(act)&&ROLE_RANK[ME.papel]<2){toast('Ação restrita a GESTOR ou ADMIN','bad');return false}
  return true;
}
class ApiError extends Error{constructor(st,msg,body){super(msg);this.status=st;this.body=body}}
async function api(method,path,body){
  let r;
  try{r=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{'X-WHOUSE':'1',...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:(typeof body==='string'?body:JSON.stringify(body))})}
  catch(e){throw new ApiError(0,'Sem conexão com o servidor')}
  const t=await r.text();let j=null;try{j=t?JSON.parse(t):null}catch(e){}
  if(r.status===401&&path!=='/api/auth/login'&&path!=='/api/auth/senha'){ME=null;showLogin('Sessão expirada — entre novamente');throw new ApiError(401,'Sessão expirada')}
  if(!r.ok){const d=j&&j.detail;throw new ApiError(r.status,typeof d==='string'?d:Array.isArray(d)?d.map(x=>x.msg).join('; '):(t||r.statusText).slice(0,200),j)}
  return j;
}
function normalize(doc){const e=EMPTY();doc=doc&&typeof doc==='object'?doc:{};for(const k of Object.keys(e))if(doc[k]==null)doc[k]=e[k];doc.cfg={...e.cfg,...doc.cfg};return doc}
function persistCache(){try{localStorage.setItem(CACHE_KEY,JSON.stringify({u:ME?.login,me:ME,v:BASEV,dirty:DIRTY,s:S,base:BASE}))}catch(e){if(!persistCache.warned){persistCache.warned=1;console.warn('cache local indisponível',e)}}}
function readCache(){try{return JSON.parse(localStorage.getItem(CACHE_KEY)||'null')}catch(e){return null}}
function srvSave(){
  if(!ME)return;
  if(ME.papel==='CONSULTA'){toast('Perfil CONSULTA: alteração não gravada','bad');if(BASE){S=normalize(JSON.parse(BASE));BAL=null;setTimeout(render,0)}return}
  DIRTY=true;API.chg++;persistCache();clearTimeout(API.timer);API.timer=setTimeout(push,350);renderSync();
}
async function push(){
  if(!API.on||!ME)return;
  if(API.pushing){API.again=true;return}
  API.pushing=true;renderSync();
  try{
    for(let i=0;i<6&&DIRTY;i++){
      const chg=API.chg,docStr=JSON.stringify(S);
      try{
        const j=await api('PUT','/api/estado',`{"base":${BASEV},"doc":${docStr}}`);
        BASEV=j.versao;BASE=docStr;if(API.chg===chg)DIRTY=false;API.online=true;API.lastErr='';persistCache();
      }catch(e){
        if(e.status===409&&e.body){mergeRemote(e.body);continue}
        if(e.status===401)break;
        if(e.status===403){API.lastErr=e.message;toast(e.message+' — alterações locais descartadas','bad');if(BASE)S=normalize(JSON.parse(BASE));BAL=null;DIRTY=false;persistCache();render();break}
        if(e.status===0){API.online=false;API.lastErr='sem conexão';setTimeout(push,15000);break}
        API.lastErr=e.message;toast('Falha ao gravar no servidor: '+e.message,'bad');setTimeout(push,30000);break;
      }
    }
  }finally{API.pushing=false;renderSync();if(API.again){API.again=false;if(DIRTY)push()}}
}
/* merge 3-vias por entidade */
const MKEYS={materiais:m=>m.codigo,depositos:d=>d.codigo,enderecos:e=>e.deposito+'|'+e.codigo,lotes:l=>l.material+'|'+l.lote,ordens:o=>o.numero,pickings:p=>p.numero,recebimentos:r=>r.numero,inventarios:i=>i.numero,requisicoes:r=>r.numero,integracoes:i=>i.id,movs:m=>m.id,outbox:o=>o.id,audit:a=>a.id};
const RENUM=new Set(['pickings','recebimentos','inventarios','requisicoes']);
function merge3(B,L,R){
  B=normalize(B);R=normalize(R);const J=JSON.stringify;const out={...R};const avisos=[];const localAdd={};const clash=[];
  out.cfg={...R.cfg};for(const k of Object.keys(L.cfg||{}))if(J(L.cfg[k])!==J(B.cfg[k]))out.cfg[k]=L.cfg[k];
  out.seq={...(R.seq||{})};for(const [k,v] of Object.entries(L.seq||{}))out.seq[k]=Math.max(out.seq[k]||0,v);
  for(const [col,kf] of Object.entries(MKEYS)){
    const b=new Map(B[col].map(x=>[kf(x),x])),l=new Map((L[col]||[]).map(x=>[kf(x),x])),r=new Map(R[col].map(x=>[kf(x),x]));const res=new Map();localAdd[col]=[];
    for(const [k,x] of r){const lx=l.get(k),bx=b.get(k);
      if(bx&&!lx){if(J(x)!==J(bx))res.set(k,x);continue}                       // apagado aqui; mantém se mudou lá
      if(lx&&bx&&J(lx)!==J(bx)){res.set(k,lx);if(J(x)!==J(bx)&&col!=='integracoes')avisos.push(`${col} ${k}: alterado por você e por outro usuário — prevaleceu a sua versão`);continue}
      if(lx&&!bx){if(J(lx)===J(x)){res.set(k,lx);continue}
        if(RENUM.has(col)){clash.push({col,x:lx});res.set(k,x);continue}
        res.set(k,lx);avisos.push(`${col} ${k}: criado ao mesmo tempo por outro usuário — prevaleceu a sua versão`);continue}
      res.set(k,lx&&J(lx)===J(x)?lx:x);
    }
    for(const [k,x] of l){if(r.has(k))continue;if(b.has(k)){if(J(x)!==J(b.get(k)))res.set(k,x);continue}res.set(k,x);localAdd[col].push(x)}
    out[col]=[...res.values()];
  }
  const seqOn=p=>{out.seq[p]=(out.seq[p]||0)+1;return `${p}-${new Date().getFullYear()}-${String(out.seq[p]).padStart(5,'0')}`};
  const ren={};
  clash.forEach(({col,x})=>{const old=x.numero;const nw=seqOn(old.split('-')[0]);ren[old]=nw;x.numero=nw;out[col].push(x);localAdd[col].push(x);avisos.push(`${old} já havia sido usado por outro usuário — seu documento foi renumerado para ${nw}`)});
  const remNew=new Set(R.movs.filter(m=>!B.movs.some(b=>b.id===m.id)).map(m=>m.doc));
  localAdd.movs.forEach(m=>{if(remNew.has(m.doc)&&!Object.keys(ren).some(o=>m.doc===o||m.doc.startsWith(o+'-'))){const mm=/^([A-Z]+)-\d{4}-\d+$/.exec(m.doc);if(mm){ren[m.doc]=seqOn(mm[1]);avisos.push(`Documento ${m.doc} renumerado para ${ren[m.doc]}`)}}});
  const rn=v=>{if(typeof v!=='string')return v;for(const [o,n] of Object.entries(ren)){if(v===o)return n;if(v.startsWith(o+'-'))return n+v.slice(o.length)}return v};
  if(Object.keys(ren).length){
    localAdd.movs.forEach(m=>{m.doc=rn(m.doc)});
    localAdd.outbox.forEach(o=>{const d=rn(o.doc);if(d!==o.doc){o.idem=o.idem.slice(0,o.idem.length-o.doc.length)+d;o.doc=d}});
    localAdd.audit.forEach(a=>{a.ref=rn(a.ref)});
  }
  out.audit.sort((a,b)=>b.ts-a.ts);out.outbox.sort((a,b)=>b.ts-a.ts);
  return{doc:out,avisos};
}
function mergeRemote(rem){
  const base=BASE?JSON.parse(BASE):{};const{doc,avisos}=merge3(base,S,rem.doc);
  S=doc;BASE=JSON.stringify(rem.doc);BASEV=rem.versao;BAL=null;
  const neg=balanceRows().filter(b=>b.qtd<-1e-9);
  if(neg.length){audit('CONFLITO','SALDO','merge',`${neg.length} posição(ões) negativas após gravação simultânea`);avisos.push(`${neg.length} posição(ões) ficaram negativas por movimentação simultânea de outro usuário — confira no estoque e ajuste`)}
  avisos.slice(0,4).forEach(a=>toast(a,'bad'));
  if(uiBusy())API.pending=true;else render();
}
const uiBusy=()=>$('#drawer').classList.contains('on')||$('#modal').classList.contains('on')||!!document.activeElement?.closest?.('#view input,#view textarea');
function srvFlushPending(){if(API.on&&API.pending&&!uiBusy()){API.pending=false;if(DIRTY)render();else pull(true)}}
async function pull(force){
  if(!API.on||!ME||API.pushing||document.hidden&&!force)return;
  try{
    const v=await api('GET','/api/estado/versao');API.online=true;
    if(v.versao===BASEV&&!force){renderSync();return}
    if(DIRTY){push();return}
    if(uiBusy()){API.pending=true;renderSync();return}
    const j=await api('GET','/api/estado');
    if(DIRTY){mergeRemote(j);push();return}
    if(j.versao!==BASEV||force){S=normalize(j.doc);BASE=JSON.stringify(j.doc);BASEV=j.versao;BAL=null;API.pending=false;persistCache();render()}
  }catch(e){if(e.status===0)API.online=false;renderSync()}
}
function renderSync(){
  const el=$('#srvState');if(!el||!API.on)return;
  const st=!API.online?['#F06A5E','Offline — alterações guardadas no aparelho']:API.pushing||DIRTY?['#F6A709','Gravando no servidor…']:API.pending?['#7DB3F0','Há atualização de outro usuário — feche a janela para ver']:API.lastErr?['#F06A5E',API.lastErr]:['#4CC37E',`Servidor v${BASEV}`];
  el.innerHTML=`<span class="dot" style="background:${st[0]}"></span> ${esc(st[1])}`;
  const c=$('#userChip');if(c&&ME)c.innerHTML=`${ic('users')}<span class="hide-m">${esc(ME.nome.split(' ')[0])}</span>`;
}

/* ---------- login / senha ---------- */
function showLogin(msg){
  $('.app').classList.add('hide');$('#bottomnav').classList.add('hide');const L=$('#login');L.classList.remove('hide');
  $('#loginMark').innerHTML=LOGO(54);$('#loginMsg').textContent=msg||'';$('#loginMsg').className='xs '+(msg?'lerr':'muted');
  setTimeout(()=>$('#lgLogin').focus(),50);
}
function hideLogin(){$('#login').classList.add('hide');$('.app').classList.remove('hide');$('#bottomnav').classList.remove('hide')}
$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const b=$('#lgBtn');b.disabled=true;$('#loginMsg').textContent='Entrando…';$('#loginMsg').className='xs muted';
  try{ME=await api('POST','/api/auth/login',{login:$('#lgLogin').value.trim(),senha:$('#lgSenha').value});$('#lgSenha').value='';
    if(ME.trocarSenha&&!await trocaSenha(true)){await api('POST','/api/auth/logout',{}).catch(()=>{});ME=null;showLogin('Troca de senha obrigatória no primeiro acesso');return}
    hideLogin();await boot();
  }catch(err){$('#loginMsg').textContent=err.message;$('#loginMsg').className='xs lerr'}finally{b.disabled=false}
});
async function trocaSenha(obrigatoria){
  for(;;){
    const v=await openModal(obrigatoria?'Defina sua senha':'Alterar senha',`${obrigatoria?'<p class="sm" style="margin-top:0">Você entrou com uma senha temporária. Defina uma senha pessoal para continuar.</p>':''}<form id="pwF"><div class="fg" style="grid-template-columns:1fr">${F(obrigatoria?'Senha temporária':'Senha atual','atual',{type:'password'})}${F('Nova senha','nova',{type:'password',help:'Mínimo 10 caracteres, com maiúsculas, minúsculas e número'})}${F('Confirme a nova senha','conf',{type:'password'})}</div></form>`,[{t:'Cancelar',v:false},{t:'Salvar senha',v:true,cls:'pri'}]);
    if(!v)return false;
    const o=readForm($('#pwF'));
    if(o.nova!==o.conf){toast('A confirmação não confere','bad');continue}
    try{ME=await api('POST','/api/auth/senha',{atual:o.atual,nova:o.nova});toast('Senha alterada','ok');return true}catch(e){toast(e.message,'bad')}
  }
}

/* ---------- partida ---------- */
function baseVazia(){
  const x=EMPTY();x.cfg.usuario='';
  x.depositos=[{codigo:'ALM01',nome:'Almoxarifado',tipo:'ALMOXARIFADO',erp:'01',ativo:true,resp:''},{codigo:'QUA01',nome:'Quarentena',tipo:'QUARENTENA',erp:'98',ativo:true,resp:''},{codigo:'EXP01',nome:'Expedição',tipo:'EXPEDICAO',erp:'03',ativo:true,resp:''}];
  x.enderecos=[{deposito:'QUA01',codigo:'Q1',tipo:'QUARENTENA',capacidade:9999,ativo:true},{deposito:'EXP01',codigo:'DOCA1',tipo:'DOCA',capacidade:9999,ativo:true}];
  x.integracoes=CONNECTORS.map(c=>({id:c.id,ativo:false,ambiente:'HOMOLOGACAO',url:'',empresa:'',usuario:'',modo:'OUTBOX',entidades:['MOVIMENTOS','SALDOS','MATERIAIS'],mapa:JSON.parse(JSON.stringify(c.mapa)),ultimoSync:null}));
  return x;
}
async function firstRun(){
  if(ME.papel!=='ADMIN'){$('#view').innerHTML=`<div class="empty"><b>Base ainda não inicializada</b>O administrador precisa iniciar a base do WHOUSE no primeiro acesso.</div>`;return false}
  let local=null;try{const raw=localStorage.getItem(KEY);if(raw){const j=JSON.parse(raw);if(Array.isArray(j.movs)&&Array.isArray(j.materiais))local=j}}catch(e){}
  const v=await openModal('Iniciar a base do WHOUSE',`<p style="margin-top:0">A base do servidor está vazia. Escolha como começar — a escolha vale para todos os usuários e pode ser desfeita depois pelo histórico de versões.</p>
   <div class="alertlist"><div class="it"><b style="min-width:150px">Base vazia</b><span class="muted sm">Só ALM01, QUA01, EXP01. Cadastre ou importe seus materiais, saldos e ordens (produção).</span></div>
   <div class="it"><b style="min-width:150px">Demonstração</b><span class="muted sm">18 materiais, 90 dias de movimentos, ordens, lotes e quarentena — para treinar a equipe.</span></div>
   ${local?`<div class="it"><b style="min-width:150px">Dados deste aparelho</b><span class="muted sm">Envia a base que já existe neste navegador: ${local.materiais.length} materiais, ${local.movs.length} movimentos.</span></div>`:''}</div>`,
   [{t:'Base vazia',v:'vazia'},{t:'Demonstração',v:'demo',cls:local?'':'pri'},...(local?[{t:'Enviar dados deste aparelho',v:'local',cls:'pri'}]:[])],{wide:true});
  if(v==='demo'){seed()}else if(v==='local'){S=normalize(local)}else if(v==='vazia'){S=baseVazia()}else return firstRun();
  BAL=null;BASE='{}';BASEV=0;audit('INICIAR','SISTEMA','base',v);DIRTY=true;API.chg++;await push();return true;
}
async function boot(){
  const cache=readCache();let j=null;
  try{j=await api('GET','/api/estado')}catch(e){if(e.status===401)return}
  if(j){
    if(cache&&cache.u===ME.login&&cache.dirty&&cache.base){S=normalize(cache.s);BASE=cache.base;BASEV=cache.v;DIRTY=true;if(j.versao!==BASEV)mergeRemote(j);toast('Enviando alterações feitas sem conexão…')}
    else if(j.versao===0){startApp();if(!await firstRun())return;render();return}
    else{S=normalize(j.doc);BASE=JSON.stringify(j.doc);BASEV=j.versao;DIRTY=false}
  }else if(cache&&cache.u===ME.login&&cache.s){S=normalize(cache.s);BASE=cache.base;BASEV=cache.v;DIRTY=!!cache.dirty;API.online=false;toast('Sem conexão com o servidor — operando com a cópia deste aparelho','bad')}
  else{$('#view').innerHTML='<div class="empty"><b>Sem conexão com o servidor</b>Verifique a rede e recarregue a página.</div>';return}
  BAL=null;persistCache();startApp();if(DIRTY)push();
}
let started=false;
function startApp(){
  if(!S)S=baseVazia();
  let tema='';try{tema=localStorage.getItem('whouse_tema')||''}catch(e){}
  tema=API.on?tema:(S.cfg.tema||'');if(tema)document.documentElement.dataset.theme=tema;
  go();renderSync();
  if(started)return;started=true;
  $('#logoMark').innerHTML=LOGO(38);
  const tick=()=>{$('#clock').textContent=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})};tick();setInterval(tick,30000);
  if(API.on){setInterval(()=>pull(false),12000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)pull(false)});window.addEventListener('online',()=>{API.online=true;DIRTY?push():pull(true)})}
}

/* ---------- menu do usuário ---------- */
A.userMenu=async()=>{if(!ME)return;
  const v=await openModal(ME.nome,`<div class="alertlist"><div class="it"><span class="grow muted">Login</span><b class="mono">${esc(ME.login)}</b></div><div class="it"><span class="grow muted">Perfil</span><b>${esc(PAPEL_TXT[ME.papel])}${ME.master?' · master':''}</b></div><div class="it"><span class="grow muted">Módulos</span><span class="sm" style="text-align:right">${ME.modulosEfetivos.map(m=>esc(MOD_TXT[m]||m)).join(', ')}</span></div><div class="it"><span class="grow muted">Base</span><b class="mono">v${BASEV}</b></div></div>`,[{t:'Fechar',v:0},{t:'Alterar senha',v:'pw'},{t:'Sair',v:'out',cls:'dan'}]);
  if(v==='pw')trocaSenha(false);if(v==='out')A.logout()};
A.logout=async()=>{if(DIRTY&&!await confirmBox('Sair','Há alterações ainda não gravadas no servidor. Sair agora pode perdê-las.','Sair mesmo assim',true))return;
  try{await api('POST','/api/auth/logout',{})}catch(e){}ME=null;try{localStorage.removeItem(CACHE_KEY)}catch(e){}S=null;BASE=null;BASEV=0;DIRTY=false;showLogin('Sessão encerrada')};
A.senhaPropria=()=>trocaSenha(false);
const _toggleTheme=A.toggleTheme;
A.toggleTheme=()=>{if(!API.on)return _toggleTheme();const cur=document.documentElement.dataset.theme||(window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light');const n=cur==='dark'?'light':'dark';document.documentElement.dataset.theme=n;try{localStorage.setItem('whouse_tema',n)}catch(e){}};

/* ---------- fila de integração (servidor) ---------- */
async function processOutboxSrv(ids){
  let ok=0,fail=0;const alvo=S.outbox.filter(o=>ids?ids.includes(o.id):['PENDENTE','ERRO'].includes(o.status));
  for(const o of alvo){
    const i=S.integracoes.find(x=>x.id===o.destino);const c=conn(o.destino);
    if(!i?.ativo||!i.url){o.status='ERRO';o.log.push({ts:Date.now(),msg:!i?.ativo?'Conector desativado':'URL não configurada'});fail++;continue}
    if(o.destino==='rest'){
      o.tentativas++;
      try{const r=await api('POST','/api/integracao/webhook',{url:i.url.replace(/\/+$/,'')+'/events',idem:o.idem,payload:o.payload});
        if(r.ok){o.status='ENVIADO';o.log.push({ts:Date.now(),msg:`POST /events → HTTP ${r.status}`});i.ultimoSync=Date.now();ok++}
        else{o.status=o.tentativas>=3?'DLQ':'ERRO';o.log.push({ts:Date.now(),msg:`HTTP ${r.status||'—'}: ${r.msg||''}`.slice(0,300)});fail++}
      }catch(e){o.status=o.tentativas>=3?'DLQ':'ERRO';o.log.push({ts:Date.now(),msg:e.message});fail++}
      continue;
    }
    // ERPs: exigem o gateway com credenciais do cliente. Nada é enviado nem marcado como enviado.
    const msg=o.destino==='file'?'Conector de arquivo: exporte a fila (JSON) ou os layouts — não há envio automático':`Gateway ${c?.nome||o.destino} não instalado neste servidor — mensagem retida (nada foi enviado)`;
    if(o.log[o.log.length-1]?.msg!==msg)o.log.push({ts:Date.now(),msg});o.status='PENDENTE';fail++;
  }
  save();return{ok,fail};
}

/* ---------- IA pelo servidor (tool use com as ferramentas locais) ---------- */
async function aiServer(ans){
  const tools=AI_TOOLS.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema}));
  const hist=AIH.slice(0,-1).filter(m=>m.content&&m.content!=='Pensando…');
  const msgs=[];hist.slice(-10).forEach(m=>{if(!msgs.length&&m.role!=='user')return;const last=msgs[msgs.length-1];if(last&&last.role===m.role)last.content+='\n\n'+m.content;else msgs.push({role:m.role,content:m.content})});
  const used=[];let txt='';
  for(let k=0;k<8;k++){
    const r=await api('POST','/api/ia/mensagens',{system:AI_SYS(),messages:msgs,tools,max_tokens:1500});
    msgs.push({role:'assistant',content:r.content});
    const t=(r.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').trim();if(t){txt=t;ans.content=t;refreshAI()}
    if(r.stop_reason!=='tool_use')break;
    const results=[];
    for(const c of r.content.filter(c=>c.type==='tool_use')){used.push(c.name);ans.tools='ferramentas: '+used.join(', ');refreshAI();
      let out,err=false;try{const tl=AI_TOOLS.find(x=>x.name===c.name);if(!tl)throw new Error('ferramenta desconhecida');out=await tl.execute(c.input||{})}catch(e){out={erro:e.message};err=true}
      results.push({type:'tool_result',tool_use_id:c.id,content:JSON.stringify(out).slice(0,60000),...(err?{is_error:true}:{})})}
    msgs.push({role:'user',content:results});
  }
  return txt||'(sem resposta)';
}
async function aiInsightsServer(box){
  box.innerHTML='<div class="muted">Analisando dados…</div>';
  const data={kpis:AI_TOOLS.find(t=>t.name==='resumo_kpis').execute({}),reposicao:AI_TOOLS.find(t=>t.name==='listar_reposicao').execute({}).slice(0,12),lotes:lotesVencendo(60).slice(0,8).map(l=>({lote:l.lote,material:l.material,dias:l.dias,qtd:l.qtd})),ordens:S.ordens.filter(o=>o.status!=='ENCERRADA').slice(0,10).map(o=>AI_TOOLS.find(t=>t.name==='status_ordem').execute({ordem:o.numero}))};
  try{const r=await api('POST','/api/ia/mensagens',{system:AI_SYS(),max_tokens:900,messages:[{role:'user',content:`Analise os dados e devolva APENAS JSON: {"insights":[{"nivel":"critico|atencao|info","texto":"frase curta com códigos e números"}]} com 4 a 6 itens priorizados.\nDADOS:${JSON.stringify(data)}`}]});
    const t=(r.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');const j=JSON.parse(t.slice(t.indexOf('{'),t.lastIndexOf('}')+1));
    const ico={critico:'🔴',atencao:'🟠',info:'🔵'};box.innerHTML=(j.insights||[]).map(x=>`<div style="padding:4px 0;border-bottom:1px solid var(--line2)">${ico[x.nivel]||'•'} ${esc(x.texto)}</div>`).join('')+'<div class="xs muted" style="margin-top:6px">Gerado pelo Claude sobre os dados atuais. Verifique antes de agir.</div>';
  }catch(e){box.innerHTML=localInsights().map(t=>`<div style="padding:4px 0">${t}</div>`).join('')+`<div class="xs muted">IA indisponível (${esc(e.message)}) — motor local.</div>`}
}

/* ---------- GERENCIADOR DE USUÁRIOS ---------- */
const UST={tab:'lista',users:null,papeis:null,mods:null,acessos:null,versoes:null,err:''};
VIEWS.usuarios=()=>{
  if(!API.on)return`<div class="empty"><b>Disponível no servidor</b>O gerenciador de usuários funciona na versão publicada (whouse.gplansis.com).</div>`;
  const head=`<div class="tabs">${[['lista','Usuários'],['acessos','Registro de acessos'],['versoes','Versões da base'],['perfis','Perfis e permissões']].map(([k,t])=>`<button class="${UST.tab===k?'on':''}" data-act="usrTab" data-v="${k}">${t}</button>`).join('')}</div>`;
  if(UST.err)return head+`<div class="empty"><b>Falha ao carregar</b>${esc(UST.err)} <button class="btn sm" data-act="usrReload">Tentar de novo</button></div>`;
  if(UST.tab==='lista'){
    if(!UST.users)return head+'<div class="empty">Carregando…</div>';
    const U=UST.users;const ativos=U.filter(u=>u.ativo);
    return head+`<div class="grid g4" style="margin-bottom:12px"><div class="kpi lead"><div class="l">Usuários ativos</div><div class="v">${ativos.length}</div><div class="s">${U.length-ativos.length} inativo(s)</div></div>
      <div class="kpi"><div class="l">Administradores</div><div class="v">${ativos.filter(u=>u.papel==='ADMIN').length}</div></div>
      <div class="kpi"><div class="l">Sessões abertas</div><div class="v">${U.reduce((s,u)=>s+(u.sessoes||0),0)}</div></div>
      <div class="kpi ${U.some(u=>u.bloqueadoAte&&new Date(u.bloqueadoAte)>new Date())?'alert':''}"><div class="l">Bloqueados</div><div class="v">${U.filter(u=>u.bloqueadoAte&&new Date(u.bloqueadoAte)>new Date()).length}</div><div class="s">${U.filter(u=>u.trocarSenha).length} com senha temporária</div></div></div>`+
    tbl('usr',[{t:'Nome',h:u=>`<b>${esc(u.nome)}</b>${u.master?' '+P('MASTER','br'):''}${u.id===ME.id?' '+P('você','info'):''}`,v:u=>u.nome},{t:'Login',k:'login',cls:'mono'},{t:'Perfil',h:u=>P(u.papel,{ADMIN:'br',GESTOR:'info',OPERADOR:'ok',CONSULTA:'mut'}[u.papel]),v:u=>u.papel},
      {t:'Módulos',h:u=>`<span class="sm">${u.modulos==null?'<span class="muted">padrão do perfil</span>':u.modulosEfetivos.length+' personalizado(s)'}</span>`,v:u=>u.modulosEfetivos.join(' ')},
      {t:'Último acesso',v:u=>u.ultimoLogin?tsBR(u.ultimoLogin):'nunca',s:u=>u.ultimoLogin||''},{t:'Sessões',v:u=>u.sessoes,num:true},
      {t:'Situação',h:u=>!u.ativo?P('INATIVO','mut'):u.bloqueadoAte&&new Date(u.bloqueadoAte)>new Date()?P('BLOQUEADO','bad'):u.trocarSenha?P('SENHA TEMPORÁRIA','warn'):P('ATIVO','ok'),v:u=>u.ativo?'ativo':'inativo'}],
      U,{onRow:u=>usrDrawer(u.id),empty:'Nenhum usuário',tools:`<button class="btn pri" data-act="usrNew">${ic('plus')} Novo usuário</button><button class="btn" data-act="usrReload">${ic('ref')} Atualizar</button>`});
  }
  if(UST.tab==='acessos'){
    if(!UST.acessos)return head+'<div class="empty">Carregando…</div>';
    const cor={LOGIN:'ok',LOGOUT:'mut',LOGIN_FALHA:'bad',LOGIN_BLOQUEADO:'bad'};
    return head+tbl('acs',[{t:'Data/hora',v:a=>tsBR(a.ts),s:a=>a.ts},{t:'Evento',h:a=>P(a.evento.replace(/_/g,' '),cor[a.evento]||'info'),v:a=>a.evento},{t:'Login',k:'login',cls:'mono'},{t:'Detalhe',k:'detalhe'},{t:'IP',k:'ip',cls:'mono'},{t:'Navegador',v:a=>(a.ua||'').replace(/^Mozilla\/5\.0 /,'').slice(0,70)}],UST.acessos,{empty:'Sem registros',tools:`<button class="btn" data-act="usrReload">${ic('ref')} Atualizar</button>`});
  }
  if(UST.tab==='versoes'){
    if(!UST.versoes)return head+'<div class="empty">Carregando…</div>';
    return head+`<div class="muted sm" style="margin-bottom:8px">Cada gravação na base gera uma versão. As últimas 300 ficam guardadas; restaurar cria uma versão nova (nada é apagado).</div>`+tbl('ver',[{t:'Versão',h:v=>`<b class="mono">v${v.versao}</b>${v.versao===BASEV?' '+P('atual','ok'):''}`,v:v=>v.versao,s:v=>v.versao},{t:'Gravada em',v:v=>tsBR(v.atualizado_em),s:v=>v.atualizado_em},{t:'Por',k:'atualizado_por'},{t:'Materiais',v:v=>v.materiais,num:true},{t:'Movimentos',v:v=>v.movs,num:true},{t:'Tamanho',v:v=>v.bytes?fmt(v.bytes/1024,0)+' KB':'—',num:true},
      {t:'',h:v=>v.versao!==BASEV?`<button class="btn sm" data-act="verRestaurar" data-v="${v.versao}">Restaurar</button>`:''}],UST.versoes,{empty:'Sem versões',tools:`<button class="btn" data-act="usrReload">${ic('ref')} Atualizar</button>`});
  }
  if(UST.tab==='perfis'){
    const P0=UST.papeis||{};const mods=UST.mods||Object.keys(MOD_TXT);
    return head+`<div class="card"><div class="bd"><div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Módulo</th>${Object.keys(PAPEL_TXT).map(p=>`<th style="text-align:center">${p}</th>`).join('')}</tr></thead><tbody>${mods.map(m=>`<tr><td>${esc(MOD_TXT[m]||m)}</td>${Object.keys(PAPEL_TXT).map(p=>`<td style="text-align:center">${(P0[p]||[]).includes(m)?'●':'<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="sect">Regras</div><div class="sm">
    <b>ADMIN</b> — tudo, inclusive usuários, versões da base, restauração e reinício da base.<br>
    <b>GESTOR</b> — todos os módulos operacionais; aprova inventário, requisições e liberação/rejeição de CQ; configura integrações e parâmetros.<br>
    <b>OPERADOR</b> — recebe, movimenta, separa, conta. Não aprova inventário, requisição nem CQ.<br>
    <b>CONSULTA</b> — somente leitura; o servidor recusa qualquer gravação deste perfil.<br><br>
    Os módulos de cada usuário podem ser personalizados; as restrições de aprovação seguem o perfil. O administrador master (<span class="mono">${esc(UST.users?.find(u=>u.master)?.login||'—')}</span>) não pode ser rebaixado nem desativado.</div></div></div>`;
  }
};
VIEWS.after_usuarios=()=>{if(!API.on)return;const need=UST.tab==='lista'||UST.tab==='perfis'?!UST.users:UST.tab==='acessos'?!UST.acessos:UST.tab==='versoes'?!UST.versoes:false;if(need&&!UST.err)usrLoad()};
async function usrLoad(){
  try{UST.err='';
    if(UST.tab==='lista'||UST.tab==='perfis'||!UST.users){const j=await api('GET','/api/usuarios');UST.users=j.usuarios;UST.papeis=j.papeis;UST.mods=j.modulos}
    if(UST.tab==='acessos')UST.acessos=await api('GET','/api/acessos?limite=500');
    if(UST.tab==='versoes')UST.versoes=await api('GET','/api/estado/historico');
  }catch(e){UST.err=e.message}
  if(route==='usuarios'&&!uiBusy())render();
}
A.usrTab=el=>{UST.tab=el.dataset.v;UST.err='';render()};
A.usrReload=()=>{UST.users=UST.acessos=UST.versoes=null;UST.err='';render()};
A.usrNew=()=>usrDrawer(null);
function usrDrawer(id){
  const u=id?UST.users.find(x=>x.id===id):{login:'',nome:'',email:'',papel:'OPERADOR',modulos:null,ativo:true};
  const mods=UST.mods||Object.keys(MOD_TXT);const def=p=>(UST.papeis?.[p]||[]);
  const efet=u.modulos==null?def(u.papel):u.modulos;
  const bloq=u.bloqueadoAte&&new Date(u.bloqueadoAte)>new Date();
  const body=`<form id="usrF">${id?`<div class="row" style="margin-bottom:10px">${u.master?P('ADMINISTRADOR MASTER','br'):''}${!u.ativo?P('INATIVO','mut'):bloq?P('BLOQUEADO até '+tsBR(u.bloqueadoAte),'bad'):u.trocarSenha?P('SENHA TEMPORÁRIA','warn'):P('ATIVO','ok')}<span class="muted sm">último acesso ${u.ultimoLogin?tsBR(u.ultimoLogin):'nunca'} · ${u.sessoes||0} sessão(ões) · criado ${tsBR(u.criadoEm)}</span></div>`:''}
   <div class="fg">${F('Login (e-mail ou usuário)','login',{value:u.login,req:true,readonly:!!id,ph:'nome@empresa.com.br'})}${F('Nome completo','nome',{value:u.nome,req:true})}
   ${F('E-mail','email',{type:'email',value:u.email||''})}${F('Perfil','papel',{value:u.papel,opts:Object.entries(PAPEL_TXT),readonly:!!u.master})}
   ${F('Ativo (pode entrar no sistema)','ativo',{type:'checkbox',value:u.ativo,full:true})}</div>
   <div class="sect">Módulos liberados</div>
   <label class="chk" style="margin-bottom:6px"><input type="checkbox" name="padrao" ${u.modulos==null?'checked':''} style="width:auto;min-height:0"> Usar o padrão do perfil</label>
   <div class="grid g2" id="usrMods" style="gap:4px 12px">${mods.filter(m=>m!=='usuarios').map(m=>`<label class="chk sm"><input type="checkbox" name="mod_${m}" ${efet.includes(m)?'checked':''} ${u.modulos==null||m==='dashboard'?'disabled':''} style="width:auto;min-height:0"> ${esc(MOD_TXT[m]||m)}</label>`).join('')}</div>
   <div class="xs muted" style="margin-top:6px">O módulo Usuários & Acessos é exclusivo do perfil ADMIN. ${id?'':'Uma senha temporária é gerada ao criar — o usuário define a própria no primeiro acesso.'}</div></form>`;
  const foot=id?`${u.id!==ME.id&&!u.master?`<button class="btn dan" data-act="usrToggle" data-u="${id}">${u.ativo?'Desativar':'Reativar'}</button>`:''}<button class="btn" data-act="usrSenha" data-u="${id}">Redefinir senha</button>${bloq?`<button class="btn" data-act="usrDesbloq" data-u="${id}">Desbloquear</button>`:''}${u.sessoes?`<button class="btn" data-act="usrSessoes" data-u="${id}">Encerrar sessões</button>`:''}<button class="btn pri" data-act="usrSave" data-u="${id}">Salvar</button>`
    :`<button class="btn" data-act="closeDrawer">Cancelar</button><button class="btn pri" data-act="usrSave" data-u="">Criar usuário</button>`;
  openDrawer(id?`Usuário · ${u.nome}`:'Novo usuário',body,foot);
  const f=$('#usrF');const sync=()=>{const pad=$('[name=padrao]',f).checked;const p=$('[name=papel]',f).value;mods.filter(m=>m!=='usuarios').forEach(m=>{const c=$(`[name=mod_${m}]`,f);c.disabled=pad||m==='dashboard';if(pad)c.checked=def(p).includes(m)})};
  $('[name=padrao]',f).onchange=sync;$('[name=papel]',f).onchange=sync;
}
async function showTempPw(login,pw,titulo){
  const v=await openModal(titulo,`<p style="margin-top:0">Entregue ao usuário <b class="mono">${esc(login)}</b> por um canal seguro. Ela aparece <b>só agora</b> e deve ser trocada no primeiro acesso.</p><div style="font:600 22px var(--fm);letter-spacing:1px;padding:14px;text-align:center;border:1px dashed var(--brand);border-radius:8px;background:var(--panel2);user-select:all">${esc(pw)}</div><div class="xs muted" style="margin-top:8px">Endereço: <span class="mono">${esc(location.origin)}</span></div>`,[{t:'Copiar',v:'c'},{t:'Concluído',v:1,cls:'pri'}]);
  if(v==='c'){try{await navigator.clipboard.writeText(`WHOUSE ${location.origin}\nlogin: ${login}\nsenha temporária: ${pw}`);toast('Copiado','ok')}catch(e){toast('Área de transferência indisponível — anote a senha','bad');return showTempPw(login,pw,titulo)}}
}
A.usrSave=async el=>{
  const id=+el.dataset.u||null;const f=$('#usrF');const o=readForm(f);clearErr(f);
  if(!id&&!(o.login.length>=3))return fieldErr(f,'login','Mínimo 3 caracteres');if(!(o.nome.length>=2))return fieldErr(f,'nome','Obrigatório');
  const mods=o.padrao?null:(UST.mods||Object.keys(MOD_TXT)).filter(m=>m==='dashboard'||o['mod_'+m]);
  try{
    if(id){await api('PATCH','/api/usuarios/'+id,{nome:o.nome,email:o.email,papel:o.papel||undefined,ativo:o.ativo,modulos:mods,usarPadrao:!!o.padrao});toast('Usuário salvo','ok');closeDrawer()}
    else{const r=await api('POST','/api/usuarios',{login:o.login,nome:o.nome,email:o.email||null,papel:o.papel,ativo:o.ativo,modulos:mods});closeDrawer();await showTempPw(r.usuario.login,r.senhaTemporaria,'Usuário criado')}
    if(id===ME.id)ME=await api('GET','/api/auth/me');
    A.usrReload();
  }catch(e){toast(e.message,'bad')}
};
A.usrToggle=async el=>{const u=UST.users.find(x=>x.id===+el.dataset.u);
  if(!await confirmBox(u.ativo?'Desativar usuário':'Reativar usuário',u.ativo?`<b>${esc(u.nome)}</b> perde o acesso imediatamente e suas sessões abertas são encerradas. O histórico dele (movimentos, auditoria) é preservado.`:`<b>${esc(u.nome)}</b> volta a poder entrar com a senha atual.`,u.ativo?'Desativar':'Reativar',u.ativo))return;
  try{await api('PATCH','/api/usuarios/'+u.id,{ativo:!u.ativo});toast('Feito','ok');closeDrawer();A.usrReload()}catch(e){toast(e.message,'bad')}};
A.usrSenha=async el=>{const u=UST.users.find(x=>x.id===+el.dataset.u);
  if(!await confirmBox('Redefinir senha',`Gera uma nova senha temporária para <b>${esc(u.nome)}</b>, encerra as sessões dele e exige troca no próximo acesso.`,'Gerar senha'))return;
  try{const r=await api('POST',`/api/usuarios/${u.id}/senha`,{});closeDrawer();await showTempPw(u.login,r.senhaTemporaria,'Nova senha temporária');if(u.id===ME.id){showLogin('Sua senha foi redefinida — entre com a temporária');return}A.usrReload()}catch(e){toast(e.message,'bad')}};
A.usrDesbloq=async el=>{try{await api('POST',`/api/usuarios/${el.dataset.u}/desbloquear`,{});toast('Desbloqueado','ok');closeDrawer();A.usrReload()}catch(e){toast(e.message,'bad')}};
A.usrSessoes=async el=>{const u=UST.users.find(x=>x.id===+el.dataset.u);if(!await confirmBox('Encerrar sessões',`Desconecta <b>${esc(u.nome)}</b> de todos os aparelhos.${u.id===ME.id?' Isso inclui esta sessão.':''}`,'Encerrar',true))return;
  try{const r=await api('DELETE',`/api/usuarios/${u.id}/sessoes`);toast(`${r.encerradas} sessão(ões) encerrada(s)`,'ok');closeDrawer();if(u.id===ME.id){ME=null;showLogin('Sessões encerradas');return}A.usrReload()}catch(e){toast(e.message,'bad')}};
A.verRestaurar=async el=>{const v=+el.dataset.v;
  if(!await confirmBox('Restaurar versão',`A base compartilhada volta ao estado da <b>v${v}</b> para todos os usuários. Isso cria uma versão nova — a atual continua no histórico e pode ser restaurada depois.${DIRTY?'<br><br><b style="color:var(--bad)">Você tem alterações ainda não gravadas; elas serão descartadas.</b>':''}`,'Restaurar',true))return;
  try{await api('POST','/api/estado/restaurar/'+v,{});DIRTY=false;await pull(true);UST.versoes=null;toast(`Base restaurada a partir da v${v}`,'ok');render()}catch(e){toast(e.message,'bad')}};

/* ---------- INIT ---------- */
document.addEventListener('submit',e=>{if(e.target.id!=='loginForm')e.preventDefault()});
(async function init(){
  if(location.protocol==='https:'&&!/claude|anthropic/i.test(location.hostname)&&'serviceWorker' in navigator){
    const l=document.createElement('link');l.rel='manifest';l.href='manifest.webmanifest';document.head.appendChild(l);
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
  if(/^https?:$/.test(location.protocol)){
    try{const r=await fetch('/api/saude',{cache:'no-store'});API.on=r.ok&&(await r.json()).app==='whouse'}catch(e){const c=readCache();API.on=!!c?.me}
  }
  if(!API.on){
    $('#login')?.remove();$('#userChip')?.remove();
    if(!load()||!S||!Array.isArray(S.movs))seed();
    S.requisicoes=S.requisicoes||[];S.integracoes=S.integracoes||[];
    startApp();return;
  }
  try{ME=await api('GET','/api/auth/me')}
  catch(e){if(e.status===0){const c=readCache();if(c?.me){ME=c.me;API.online=false;hideLogin();return boot()}}return showLogin('')}
  if(ME.trocarSenha&&!await trocaSenha(true)){ME=null;return showLogin('Troca de senha obrigatória no primeiro acesso')}
  hideLogin();boot();
})();
