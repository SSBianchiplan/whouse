'use strict';
/* Página inicial do WHOUSE: menu no celular, gráficos da tela ilustrativa e CTA que
   reconhece a sessão aberta ("Continuar como …"). Sem dependências. */
(function(){
  const menu=document.getElementById('menu'),links=document.getElementById('links');
  menu.addEventListener('click',()=>{const on=links.classList.toggle('on');menu.setAttribute('aria-expanded',on)});
  links.addEventListener('click',e=>{if(e.target.closest('a')){links.classList.remove('on');menu.setAttribute('aria-expanded','false')}});
  document.getElementById('ano').textContent=new Date().getFullYear();

  // tela ilustrativa: série determinística (mesma a cada visita)
  let s=20260926;const R=()=>(s=(s*1664525+1013904223)>>>0)/4294967296;
  document.getElementById('mockBars').innerHTML=Array.from({length:24},()=>{const e=20+R()*80,o=15+R()*70;return`<span><i style="height:${e}%"></i><i style="height:${o}%"></i></span>`}).join('');
  document.getElementById('mockMap').innerHTML=Array.from({length:24},(_,i)=>`<u class="${i%6===5?'q':i%3===0?'p':''}" style="--h:${Math.round(R()*100)}%"></u>`).join('');

  // sessão aberta → CTA personalizado
  fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():null).then(me=>{
    if(!me||!me.nome)return;
    const n=me.nome.split(' ')[0];
    document.querySelectorAll('[data-entrar-txt]').forEach(el=>el.textContent='Continuar como '+n);
    document.querySelectorAll('.nav [data-entrar]').forEach(el=>el.textContent='Abrir o sistema');
  }).catch(()=>{});

  if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
