(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const stars = window.PLANETORY_DATA;
  const tutorial = stars[0];
  const STORAGE = 'planetory-sky-prototype-v1';
  const NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const initialState = () => ({ guideDone: false, guideDismissed: false, selected: null, started: [], seen: [], page: 'map', questCollapsed: false });
  let state = initialState();
  let storageAvailable = true;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null');
    if (saved && typeof saved.guideDone === 'boolean') {
      state = { ...state, ...saved, started: Array.isArray(saved.started) ? saved.started.filter(id => stars.some(s => s.tic === id)) : [], seen: Array.isArray(saved.seen) ? saved.seen : [] };
      if (!stars.some(s => s.tic === state.selected) || (!state.guideDone && state.selected !== tutorial.tic)) state.selected = null;
      if (state.page !== 'analysis' || !state.selected) state.page = 'map';
    }
  } catch { storageAvailable = false; }
  let size = { w: 0, h: 0, dpr: 1 };
  const M=window.SkyMath;
  const sectors=window.PLANETORY_SECTORS.map(s=>({...s,ccds:s.ccds.map(c=>({...c,vectors:c.boundary.map(p=>M.vector(...p))}))}));
  const layers={grid:true,sector:false,sectorId:3,opacity:.65};
  const view={ra:tutorial.ra,dec:tutorial.dec,fov:55};
  let seed=206;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const background=Array.from({length:6000},()=>({v:M.vector(random()*360,Math.asin(random()*2-1)/M.R),size:4+random()**5*18,color:random()>.7?[.68,.78,1]:[.92,.93,1]}));
  let groups = [];
  let renderKey = '';
  let cameraAnimation = 0;
  let pointer = null;
  let toastTimer;
  let previousFocus = null;
  let replayGuide = false;
  let analysisReturnView = null;
  const surface = $('map-surface');
  const canvas = $('star-canvas');
  let gl, program, buffer, attr, uniforms;
  let webglAvailable = false;

  function save() {
    try { localStorage.setItem(STORAGE, JSON.stringify(state)); storageAvailable = true; }
    catch { storageAvailable = false; }
    $('save-status').textContent = storageAvailable ? '이 브라우저에 진행 저장' : '현재 화면에서만 진행 유지';
  }
  const unlocked = () => state.guideDone ? stars : [tutorial];
  const currentStar = () => stars.find(s => s.tic === state.selected);
  const position = s => M.project(M.vector(s.ra,s.dec),view,size);
  function el(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
  }
  function showDialog(id) {
    previousFocus = document.activeElement;
    if (!$(id).open) $(id).showModal();
  }
  function closeDialog(id) {
    $(id).close();
    if (previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus({ preventScroll: true });
  }
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d.id);
  }));

  function initWebGL() {
    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'low-power' });
      if (!gl) throw new Error('WebGL unavailable');
      function compile(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      }
      const vs = compile(gl.VERTEX_SHADER, `attribute vec2 aPosition; attribute float aSize; attribute vec3 aColor; uniform vec2 uViewport; uniform float uDpr; varying vec3 vColor; void main(){vec2 p=aPosition/uViewport; gl_Position=vec4(p.x*2.0-1.0,1.0-p.y*2.0,0.0,1.0);gl_PointSize=aSize*uDpr;vColor=aColor;}`);
      const fs = compile(gl.FRAGMENT_SHADER, `precision mediump float;varying vec3 vColor;void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=length(p);float halo=exp(-r*r*13.0)*.18;float core=exp(-r*r*550.0);float rayX=exp(-abs(p.y)*135.0)*exp(-abs(p.x)*10.0)*.38;float rayY=exp(-abs(p.x)*135.0)*exp(-abs(p.y)*10.0)*.38;float a=halo+core+rayX+rayY;float fade=1.0-smoothstep(.7,1.0,r);gl_FragColor=vec4(mix(vColor,vec3(1.0),min(core*2.0,1.0)),min(a*fade,1.0));}`);
      program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      buffer = gl.createBuffer();
      attr = { pos: gl.getAttribLocation(program, 'aPosition'), size: gl.getAttribLocation(program, 'aSize'), color: gl.getAttribLocation(program, 'aColor') };
      uniforms = { viewport: gl.getUniformLocation(program, 'uViewport'), dpr: gl.getUniformLocation(program, 'uDpr') };
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      webglAvailable = true;
    } catch {
      webglAvailable = false;
      $('star-list').hidden = false;
      $('list-toggle').setAttribute('aria-expanded', 'true');
      $('list-arrow').textContent = '−';
      toast('그래픽 표시를 사용할 수 없어 내 별 목록을 함께 표시합니다.');
    }
  }
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); webglAvailable = false; renderKey = ''; renderMap();
    $('star-list').hidden = false; $('list-toggle').setAttribute('aria-expanded', 'true'); $('list-arrow').textContent = '−';
    toast('그래픽 연결이 중단되었습니다. 내 별 목록에서 탐사를 이어갈 수 있어요.');
  });
  canvas.addEventListener('webglcontextrestored', () => { initWebGL(); renderKey = ''; renderMap(); });
  function drawStars() {
    if (!webglAvailable) return;
    gl.viewport(0,0,canvas.width,canvas.height); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    const points=[];
    for(const star of background){const p=M.project(star.v,view,size);if(p.visible&&p.x>-15&&p.x<size.w+15&&p.y>-15&&p.y<size.h+15)points.push(p.x,p.y,star.size,star.color[0],star.color[1],star.color[2]);}
    for(const g of groups){const s=g.members[0];points.push(g.x,g.y,s===tutorial?145:125,1,M.clamp(.65+(s.temperature-3000)/6000,.6,1),M.clamp(.42+(s.temperature-3000)/9000,.4,1));}
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(points),gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attr.pos);gl.vertexAttribPointer(attr.pos,2,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(attr.size);gl.vertexAttribPointer(attr.size,1,gl.FLOAT,false,24,8);
    gl.enableVertexAttribArray(attr.color);gl.vertexAttribPointer(attr.color,3,gl.FLOAT,false,24,12);
    gl.uniform2f(uniforms.viewport,size.w,size.h);gl.uniform1f(uniforms.dpr,size.dpr);
    gl.drawArrays(gl.POINTS,0,points.length/6);
  }
  function computeGroups(){return unlocked().map(s=>({...position(s),members:[s]})).filter(p=>p.visible&&p.x>-75&&p.x<size.w+75&&p.y>-100&&p.y<size.h+100);}
  function clippedPolygon(vectors){
    const forward=M.frame(view).forward,out=[];
    for(let i=0;i<vectors.length;i++){
      const a=vectors[i],b=vectors[(i+1)%vectors.length],az=M.dot(a,forward),bz=M.dot(b,forward),ain=az>=.08,bin=bz>=.08;
      if(ain)out.push(a);
      if(ain!==bin){const t=(.08-az)/(bz-az);out.push(a.map((v,j)=>v+(b[j]-v)*t));}
    }
    return out;
  }
  function drawDecoration(){
    const svg=$('map-decoration');svg.setAttribute('viewBox',`0 0 ${size.w} ${size.h}`);
    const frag=document.createDocumentFragment();
    if(layers.grid){
      const lines=[];
      for(let ra=0;ra<360;ra+=30)lines.push(Array.from({length:91},(_,i)=>M.vector(ra,-90+i*2)));
      for(let dec=-75;dec<=75;dec+=15)lines.push(Array.from({length:181},(_,i)=>M.vector(i*2,dec)));
      for(const line of lines){let d='',previous=null;for(const v of line){const p=M.project(v,view,size);if(p.z>.06){d+=`${previous?'L':'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `;previous=p;}else previous=null;}frag.append(el('path',{d,fill:'none',stroke:'#90b2dc','stroke-opacity':.12,'stroke-width':.7}));}
      for(let ra=0;ra<360;ra+=30){const p=M.project(M.vector(ra,Math.round(view.dec/15)*15),view,size);if(p.visible&&p.x>285&&p.x<size.w-260&&p.y>40&&p.y<size.h-80){const t=el('text',{x:p.x+8,y:p.y-9,fill:'#647c96','font-size':9});t.textContent=`${ra}°`;frag.append(t);}}
    }
    if(layers.sector){
      const sector=sectors.find(s=>s.sector===layers.sectorId),colors=['#83cfff','#89b4ff','#7dddc8','#d5b1fa'];
      for(const ccd of sector.ccds){
        const vertices=clippedPolygon(ccd.vectors);
        if(vertices.length<3)continue;
        const points=vertices.map(v=>M.project(v,view,size));
        const d=points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')+'Z';
        frag.append(el('path',{d,fill:colors[ccd.camera-1],'fill-opacity':layers.opacity*.25,stroke:colors[ccd.camera-1],'stroke-opacity':layers.opacity,'stroke-width':.9}));
        const p=M.project(M.vector(...ccd.center),view,size);
        if(p.visible&&p.x>280&&p.x<size.w-300&&p.y>40&&p.y<size.h-90){const label=el('text',{x:p.x,y:p.y,'text-anchor':'middle',fill:colors[ccd.camera-1],'fill-opacity':.75,'font-size':9,'letter-spacing':1});label.textContent=`CAM ${ccd.camera} · CCD ${ccd.ccd}`;frag.append(label);}
      }
    }
    svg.replaceChildren(frag);
  }
  function renderMap(){
    if(!size.w||state.page!=='map')return;
    groups=computeGroups();
    const key=groups.map(g=>g.members[0].tic).join('|')+`:${state.selected}:${state.guideDone}:${state.started.join(',')}:${state.seen.join(',')}:${webglAvailable}`;
    if(key!==renderKey){
      const frag=document.createDocumentFragment();
      for(const g of groups){
        const s=g.members[0],b=document.createElement('button'),isNew=s!==tutorial&&!state.seen.includes(s.tic);
        const sub=s===tutorial?(state.guideDone?'안내 완료 · 분석 중':'첫 번째 탐사'):(state.started.includes(s.tic)?'분석 중':'자유 탐사');
        b.className='star-node';b.dataset.tic=s.tic;b.classList.toggle('selected',state.selected===s.tic);
        b.innerHTML=`${s===tutorial?'<span class="badge">1</span>':isNew?'<span class="badge new">NEW</span>':''}<span class="star-label">TIC ${s.tic}</span><span class="star-subtitle">${sub}</span>`;
        b.setAttribute('aria-label',`TIC ${s.tic}, ${sub}`);b.setAttribute('aria-pressed',String(state.selected===s.tic));
        if(!webglAvailable)b.style.background='radial-gradient(circle,white 0 3px,#ffb87b50 5px,transparent 24px)';
        b.onclick=()=>selectStar(s.tic);frag.append(b);
      }
      $('map-nodes').replaceChildren(frag);renderKey=key;
    }
    [...$('map-nodes').children].forEach((b,i)=>{b.style.left=`${groups[i].x}px`;b.style.top=`${groups[i].y}px`;});
    drawDecoration();drawStars();drawOverview($('sky-overview'));
    if($('sky-dialog').open)drawOverview($('sky-overview-large'));
    $('zoom-label').textContent=`시야 ${Math.round(view.fov)}°`;
    $('map-area').textContent=`RA ${M.wrap(view.ra).toFixed(1)}° / DEC ${view.dec>=0?'+':''}${view.dec.toFixed(1)}°`;
    $('zoom-out').disabled=view.fov>=120;$('zoom-in').disabled=view.fov<=12;
    $('visible-count').textContent=`화면 안 ${groups.length} / 열린 별 ${unlocked().length}`;
    $('sector-caption').hidden=!layers.sector;
    $('sector-caption').textContent=`SECTOR ${layers.sectorId} · 실제 관측 영역`;
    $('sky-overview-card').hidden=!!state.selected;
    for(const b of $('star-list').children){const s=stars.find(s=>s.tic===b.dataset.tic),visible=groups.some(g=>g.members[0]===s);b.querySelector('.list-position').textContent=visible?'화면 안':'방향 이동 ↗';}
  }
  function drawOverview(svg){
    const w=360,h=180,X=ra=>(360-M.wrap(ra))/360*w,Y=dec=>(90-dec)/180*h;
    svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.replaceChildren();
    for(let x=0;x<=360;x+=60)svg.append(el('line',{x1:x,y1:0,x2:x,y2:h,stroke:'#233b54','stroke-width':.7}));
    for(let y=0;y<=180;y+=45)svg.append(el('line',{x1:0,y1:y,x2:w,y2:y,stroke:'#233b54','stroke-width':.7}));
    if(layers.sector){const sec=sectors.find(s=>s.sector===layers.sectorId);for(const c of sec.ccds){let d='',last=null;for(const [ra,dec]of [...c.boundary,c.boundary[0]]){const x=X(ra),y=Y(dec);d+=`${last!==null&&Math.abs(x-last)<180?'L':'M'}${x.toFixed(1)} ${y.toFixed(1)} `;last=x;}svg.append(el('path',{d,fill:'none',stroke:'#558d93','stroke-width':.7}));}}
    const edge=[];for(let i=0;i<=30;i++)edge.push([size.w*i/30,0]);for(let i=1;i<=30;i++)edge.push([size.w,size.h*i/30]);for(let i=1;i<=30;i++)edge.push([size.w*(1-i/30),size.h]);for(let i=1;i<=30;i++)edge.push([0,size.h*(1-i/30)]);
    let d='',last=null;for(const [x,y]of edge){const p=M.unproject(x,y,view,size),xx=X(p.ra),yy=Y(p.dec);d+=`${last!==null&&Math.abs(xx-last)<180?'L':'M'}${xx.toFixed(1)} ${yy.toFixed(1)} `;last=xx;}svg.append(el('path',{d,fill:'none',stroke:'#8ae6d5','stroke-opacity':.65,'stroke-width':1,'stroke-dasharray':'3 3'}));
    for(const s of unlocked()){const circle=el('circle',{cx:X(s.ra),cy:Y(s.dec),r:state.selected===s.tic?4:3,fill:s===tutorial?'#ffc39d':'#91eadb',stroke:'#091b2e','stroke-width':1});svg.append(circle);const t=el('text',{x:Math.min(290,X(s.ra)+7),y:Math.max(12,Y(s.dec)-7),fill:'#c6dbe8','font-size':8});t.textContent=`TIC ${s.tic}`;svg.append(t);}
    svg.append(el('circle',{cx:X(view.ra),cy:Y(view.dec),r:3,fill:'none',stroke:'#ffffff','stroke-width':1}));
  }
  function moveCamera(target,animate=true){
    cancelAnimationFrame(cameraAnimation);$('map-tooltip').hidden=true;
    target={...view,...target,ra:M.wrap(target.ra??view.ra),dec:M.clamp(target.dec??view.dec,-89.5,89.5)};
    if(!animate||reduceMotion){Object.assign(view,target);renderMap();return;}
    const start={...view},time=performance.now();
    function step(now){const t=Math.min(1,(now-time)/1000),ease=1-Math.pow(1-t,3),p=M.interpolate(start,target,ease);Object.assign(view,p,{fov:start.fov+(target.fov-start.fov)*ease});renderMap();if(t<1)cameraAnimation=requestAnimationFrame(step);}
    cameraAnimation=requestAnimationFrame(step);
  }
  function focus(s,animate=true){moveCamera({ra:s.ra,dec:s.dec,fov:55},animate);}
  function fit(members=unlocked(),expand=false,animate=true){focus(currentStar()||tutorial,animate);}
  function openSky(){showDialog('sky-dialog');drawOverview($('sky-overview-large'));}
  function zoomAt(factor){cancelAnimationFrame(cameraAnimation);view.fov=M.clamp(view.fov/factor,12,120);renderMap();}

  function selectStar(id) {
    if (!unlocked().some(s => s.tic === id)) return;
    state.selected = id; state.guideDismissed = true;
    if (!state.seen.includes(id)) state.seen.push(id);
    updateUI(); save(); focus(currentStar());
  }
  function updateUI() {
    const map = state.page === 'map';
    $('map-page').hidden = !map; $('analysis-page').hidden = map;
    const list = unlocked();
    $('star-count').textContent = String(list.length).padStart(2, '0'); $('list-count').textContent = list.length;
    $('count-note').textContent = state.guideDone ? '두 개의 새로운 여정이 열렸어요' : '첫 탐사를 기다리고 있어요';
    const stage = state.guideDone ? 3 : state.started.includes(tutorial.tic) ? 2 : state.selected === tutorial.tic ? 2 : 1;
    $('quest-bar').style.width = `${stage / 3 * 100}%`;
    $('quest-step').textContent = state.guideDone ? '03 / 03 · 안내 완료' : stage === 2 ? '02 / 03 · 분석 시작하기' : '01 / 03 · 별 만나기';
    $('quest-title').textContent = state.guideDone ? '다음 별은 직접 골라보세요' : stage === 2 ? '빛의 변화를 살펴볼까요?' : '첫 번째 별을 만나보세요';
    $('quest-description').innerHTML = state.guideDone ? '새로운 두 별이 열렸어요.<br>처음 만난 별도 계속 분석할 수 있어요.' : stage === 2 ? '별 정보에서 분석을 시작하세요.<br>분석 화면에서 안내가 이어집니다.' : '빛의 변화를 살펴보며<br>나만의 탐사를 시작해요.';
    $('quest-action').innerHTML = state.guideDone ? '전체 하늘에서 새 별 보기 <span>↗</span>' : stage === 2 ? '첫 분석으로 이동 <span>↗</span>' : '첫 번째 별 보기 <span>↗</span>';
    $('quest-content').hidden = !!state.questCollapsed;
    $('quest-toggle').setAttribute('aria-expanded', String(!state.questCollapsed)); $('quest-toggle-icon').textContent = state.questCollapsed ? '＋' : '−';
    $('welcome-card').hidden = (state.guideDone && !replayGuide) || state.guideDismissed || !!state.selected;
    $('new-notice').hidden = !state.guideDone || !!state.selected || stars.slice(1).every(s => state.seen.includes(s.tic));
    $('star-list').replaceChildren(...list.map(s => {
      const b = document.createElement('button'); b.className = 'list-star'; b.dataset.tic=s.tic;
      b.innerHTML = `<i></i><span>TIC ${s.tic}<small>${s === tutorial ? '첫 탐사 안내' : '자유 탐사'}</small></span><span>${s !== tutorial && !state.seen.includes(s.tic) ? 'NEW' : ''}<small class="list-position">방향 이동 ↗</small></span>`;
      b.addEventListener('click', () => { if (state.page !== 'map') returnMap(false); selectStar(s.tic); }); return b;
    }));
    const s = currentStar(); $('star-detail').hidden = !s;
    if (s) {
      $('detail-category').textContent = s === tutorial ? 'TUTORIAL 01' : `EXPLORATION ${stars.indexOf(s) + 1 < 10 ? '0' : ''}${stars.indexOf(s) + 1}`;
      $('detail-id').textContent = `TIC ${s.tic}`;
      $('detail-status').textContent = state.started.includes(s.tic) ? '분석 중' : '아직 분석하지 않았어요';
      $('detail-sectors').className = 'sector-chips'; $('detail-sectors').innerHTML = s.observations.map(o => `<span class="sector-chip">${o.sector}</span>`).join('');
      $('detail-mag').textContent = s.tmag == null ? '정보 없음' : `${s.tmag.toFixed(2)} 등급`;
      $('detail-path').textContent = `${s.ra.toFixed(2)}° / ${s.dec>=0?'+':''}${s.dec.toFixed(2)}°`;
      $('detail-note').textContent = s === tutorial && state.guideDone ? '첫 분석 안내를 마쳤어요. 이 별의 분석은 계속할 수 있습니다.' : s === tutorial ? '이 별에서 첫 분석을 시작합니다. 별빛이 반복해서 줄어드는 흔적을 살펴보세요.' : '하늘의 실제 위치에 새로 열린 별입니다. 관측 기록을 자유롭게 살펴보세요.';
      $('analysis-start').innerHTML = `${state.started.includes(s.tic) ? '분석 이어하기' : '분석 시작'} <span>↗</span>`;
    }
    if (map) renderMap(); else renderAnalysis();
  }
  function startAnalysis() {
    const s = currentStar(); if (!s) return;
    analysisReturnView = { ...view };
    replayGuide = false;
    if (!state.started.includes(s.tic)) state.started.push(s.tic);
    state.page = 'analysis'; save(); updateUI(); window.scrollTo(0, 0); $('analysis-back').focus({ preventScroll: true });
  }
  function returnMap(focusSelected = true) {
    state.page = 'map'; save(); updateUI(); resize();
    if (analysisReturnView) moveCamera(analysisReturnView, false);
    else if (focusSelected && currentStar()) focus(currentStar(), false);
    surface.focus({ preventScroll: true });
  }
  function renderAnalysis() {
    const s = currentStar(); if (!s) return;
    $('analysis-title').textContent = `TIC ${s.tic}`;
    $('analysis-meta').textContent = `관측 회차 ${s.observations.map(o => o.sector).join(' · ')}  /  ${s === tutorial ? '첫 분석 안내' : '자유 탐사'}`;
    $('chart-sectors').textContent = s.observations.map(o => `S${o.sector}`).join(' / ');
    const canComplete = s === tutorial && !state.guideDone;
    $('complete-demo').hidden = !canComplete; $('free-return').hidden = canComplete;
    $('simulation-title').textContent = canComplete ? '첫 분석 안내가 끝난 상황을 확인해 보세요.' : '선택한 별의 분석 화면으로 연결되는 자리입니다.';
    $('simulation-description').textContent = canComplete ? '아래 버튼은 실제 분석을 채점하지 않습니다. 안내를 마친 뒤 지도에 새 별이 열리는 흐름을 재현합니다.' : '실제 자료의 미리보기까지 연결했습니다. 그래프 조작·제출·결과 판정은 분석 프론트와 연결할 예정입니다.';
    drawChart();
  }
  function drawChart() {
    if (state.page !== 'analysis') return;
    const s = currentStar(), svg = $('lightcurve');
    const w = svg.clientWidth || 650, h = svg.clientHeight || 265;
    const margin = { l: 59, r: 19, t: 31, b: 53 };
    const points = s.curves.flatMap(c => c.points);
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [x, y] of points) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    const ypad = Math.max(.0002, (ymax - ymin) * .13); ymin -= ypad; ymax += ypad;
    const X = x => margin.l + (x - xmin) / (xmax - xmin || 1) * (w - margin.l - margin.r);
    const Y = y => h - margin.b - (y - ymin) / (ymax - ymin || 1) * (h - margin.t - margin.b);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.replaceChildren();
    const label = (text, attrs) => { const n = el('text', { fill: '#8192ac', 'font-size': 10, 'font-family': 'Pretendard, sans-serif', ...attrs }); n.textContent = text; svg.append(n); };
    svg.append(el('rect', { x: margin.l, y: margin.t, width: w - margin.l - margin.r, height: h - margin.t - margin.b, fill: '#080d16', stroke: '#27364d', 'stroke-width': .7 }));
    for (let i = 0; i < 4; i++) {
      const y = ymin + (ymax - ymin) * i / 3;
      svg.append(el('line', { x1: margin.l, y1: Y(y), x2: w - margin.r, y2: Y(y), stroke: '#1c293d', 'stroke-width': .6 }));
      label(y.toFixed(3), { x: margin.l - 9, y: Y(y) + 3, 'text-anchor': 'end' });
    }
    const tickCount = w < 450 ? 3 : 5;
    for (let i = 0; i < tickCount; i++) {
      const x = xmin + (xmax - xmin) * i / (tickCount - 1);
      label(x.toFixed(1), { x: X(x), y: h - margin.b + 18, 'text-anchor': i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle' });
    }
    for (const c of s.curves) {
      const cx = X((c.points[0][0] + c.points[c.points.length - 1][0]) / 2);
      label(`S${c.sector}`, { x: cx, y: 19, 'text-anchor': 'middle', fill: '#7497cb', 'font-size': 9 });
      // Individual points preserve real observation gaps; no lines bridge missing data.
      let d = '';
      for (const [x, y] of c.points) d += `M${X(x).toFixed(2)} ${Y(y).toFixed(2)}h.1`;
      svg.append(el('path', { d, fill: 'none', stroke: '#96b9f4', 'stroke-width': 1.8, 'stroke-linecap': 'round', opacity: .8 }));
    }
    label('시간 (BJD − 2457000, 일)', { x: (margin.l + w - margin.r) / 2, y: h - 10, 'text-anchor': 'middle', fill: '#a8b9d1', 'font-size': 10 });
    label('정규화 밝기', { transform: `translate(13 ${(margin.t + h - margin.b) / 2}) rotate(-90)`, 'text-anchor': 'middle', fill: '#a8b9d1', 'font-size': 10 });
  }
  function completeGuide(show = true) {
    replayGuide = false; analysisReturnView = null;
    state.guideDone = true; state.guideDismissed = true; state.page = 'map'; state.selected = null;
    if (!state.started.includes(tutorial.tic)) state.started.push(tutorial.tic);
    save(); updateUI(); resize(); fit(unlocked(), false, false);
    $('unlock-cards').replaceChildren(...stars.slice(1).map(s => {
      const b = document.createElement('button'); b.className = 'unlock-star';
      b.innerHTML = `<span class="small-star"></span><span>TIC ${s.tic}</span><small>${s.dec<0?'남쪽':'북쪽'} 하늘 · ${M.separation(tutorial,s).toFixed(0)}° 떨어진 방향</small>`;
      b.addEventListener('click', () => { closeDialog('unlock-dialog'); selectStar(s.tic); }); return b;
    }));
    if (show) showDialog('unlock-dialog');
  }
  function resize() {
    if (state.page !== 'map') { drawChart(); return; }
    const r = surface.getBoundingClientRect(); if (!r.width || !r.height) return;
    const first = !size.w;
    size = { w: r.width, h: r.height, dpr: Math.min(window.devicePixelRatio || 1, 2) };
    canvas.width = Math.round(size.w * size.dpr); canvas.height = Math.round(size.h * size.dpr);
    if (first && state.guideDone) fit(unlocked(), false, false); else renderMap();
  }

  function turn(dx,dy){view.ra=M.wrap(view.ra+dx*view.fov/size.h/Math.max(.18,Math.cos(view.dec*M.R)));view.dec=M.clamp(view.dec+dy*view.fov/size.h,-89.5,89.5);renderMap();}
  surface.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button'))return;cancelAnimationFrame(cameraAnimation);surface.setPointerCapture(e.pointerId);surface.focus({preventScroll:true});pointer={id:e.pointerId,x:e.clientX,y:e.clientY};surface.classList.add('dragging');});
  surface.addEventListener('pointermove',e=>{if(!pointer||e.pointerId!==pointer.id)return;turn(e.clientX-pointer.x,e.clientY-pointer.y);pointer.x=e.clientX;pointer.y=e.clientY;});
  const endDrag=()=>{pointer=null;surface.classList.remove('dragging');};
  surface.addEventListener('pointerup',endDrag);surface.addEventListener('pointercancel',endDrag);surface.addEventListener('lostpointercapture',endDrag);
  surface.addEventListener('wheel',e=>{e.preventDefault();zoomAt(Math.exp(-M.clamp(e.deltaY,-180,180)*.0025));},{passive:false});
  surface.addEventListener('keydown',e=>{if(e.target!==surface)return;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(e.key)){e.preventDefault();cancelAnimationFrame(cameraAnimation);}
  if(e.key==='ArrowLeft')turn(35,0);if(e.key==='ArrowRight')turn(-35,0);if(e.key==='ArrowUp')turn(0,35);if(e.key==='ArrowDown')turn(0,-35);if(e.key==='+'||e.key==='=')zoomAt(1.25);if(e.key==='-')zoomAt(.8);if(e.key==='Home')fit();});
  $('zoom-in').onclick = () => zoomAt(1.25); $('zoom-out').onclick = () => zoomAt(.8);
  $('fit-map').onclick = () => fit();
  $('welcome-select').onclick = () => selectStar(tutorial.tic);
  $('welcome-close').onclick = () => { state.guideDismissed = true; save(); updateUI(); };
  $('quest-action').onclick = () => {
    if (state.guideDone) { openSky(); }
    else if (state.selected === tutorial.tic || state.started.includes(tutorial.tic)) { state.selected = tutorial.tic; startAnalysis(); }
    else selectStar(tutorial.tic);
  };
  $('quest-toggle').onclick = () => { state.questCollapsed = !state.questCollapsed; save(); updateUI(); };
  $('list-toggle').onclick = () => { const open = $('star-list').hidden; $('star-list').hidden = !open; $('list-toggle').setAttribute('aria-expanded', String(open)); $('list-arrow').textContent = open ? '−' : '＋'; };
  $('detail-close').onclick = () => { state.selected = null; save(); updateUI(); };
  $('detail-focus').onclick = () => { if (currentStar()) focus(currentStar()); };
  $('analysis-start').onclick = startAnalysis;
  $('analysis-back').onclick = () => returnMap(); $('free-return').onclick = () => returnMap();
  $('complete-demo').onclick = () => completeGuide();
  $('unlock-explore').onclick = () => { closeDialog('unlock-dialog'); openSky(); };
  $('show-new').onclick = openSky;
  $('legend-button').onclick = () => { $('legend').hidden = !$('legend').hidden; $('legend-button').setAttribute('aria-expanded', String(!$('legend').hidden)); };
  $('legend-close').onclick = () => { $('legend').hidden = true; $('legend-button').setAttribute('aria-expanded', 'false'); };
  $('help-button').onclick = () => showDialog('help-dialog');
  $('demo-button').onclick = () => showDialog('demo-dialog');
  $('reset-demo').onclick = () => {
    closeDialog('demo-dialog'); cancelAnimationFrame(cameraAnimation); replayGuide = false; analysisReturnView = null; state = initialState(); save(); renderKey = ''; Object.assign(view,{ra:tutorial.ra,dec:tutorial.dec,fov:55});Object.assign(layers,{grid:true,sector:false,sectorId:3,opacity:.65});$('grid-toggle').checked=true;$('sector-toggle').checked=false;$('sector-select').value='3';$('sector-opacity').value='65';$('opacity-label').textContent='65%';$('layers-panel').hidden=true;$('layers-button').setAttribute('aria-expanded','false');
    updateUI(); resize(); $('star-list').hidden=false;$('list-toggle').setAttribute('aria-expanded','true');$('list-arrow').textContent='−'; $('legend').hidden = true;
    toast('처음 방문 상태로 돌아왔습니다.');
  };
  $('unlocked-demo').onclick = () => { closeDialog('demo-dialog'); completeGuide(false); toast('두 별이 열린 시연 상태입니다. 실제 등급 변화는 없습니다.'); };
  $('restart-guide').onclick = () => {
    closeDialog('help-dialog'); replayGuide = true; state.page = 'map'; state.guideDismissed = false; state.selected = null; updateUI(); resize(); focus(tutorial); save();
  };
  $('nav-map').onclick = () => { if (state.page !== 'map') returnMap(); else { state.selected = null; updateUI(); fit(); save(); } };
  document.querySelector('.brand').onclick = e => { e.preventDefault(); $('nav-map').click(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { if (!$('legend').hidden) $('legend-close').click(); else if (state.page === 'map' && state.selected) $('detail-close').click(); } });
  $('layers-button').onclick=()=>{const open=$('layers-panel').hidden;$('layers-panel').hidden=!open;$('layers-button').setAttribute('aria-expanded',String(open));$('legend').hidden=true;};
  $('layers-close').onclick=()=>{$('layers-panel').hidden=true;$('layers-button').setAttribute('aria-expanded','false');};
  $('grid-toggle').onchange=e=>{layers.grid=e.target.checked;renderMap();};
  $('sector-toggle').onchange=e=>{layers.sector=e.target.checked;renderMap();};
  $('sector-select').onchange=e=>{layers.sectorId=Number(e.target.value);layers.sector=true;$('sector-toggle').checked=true;renderMap();};
  $('sector-opacity').oninput=e=>{layers.opacity=Number(e.target.value)/100;$('opacity-label').textContent=`${e.target.value}%`;renderMap();};
  $('sector-focus').onclick=()=>{const s=sectors.find(s=>s.sector===layers.sectorId);layers.sector=true;$('sector-toggle').checked=true;state.selected=null;state.guideDismissed=true;save();updateUI();moveCamera({ra:s.ra,dec:s.dec,fov:118});};
  $('overview-button').onclick=openSky;$('overview-card-button').onclick=openSky;
  $('overview-list').replaceChildren();
  $('sky-dialog').addEventListener('close',()=>surface.focus({preventScroll:true}));
  $('sky-overview-large').addEventListener('click',e=>{const r=e.currentTarget.getBoundingClientRect();const ra=M.wrap(360-(e.clientX-r.left)/r.width*360),dec=M.clamp(90-(e.clientY-r.top)/r.height*180,-89.5,89.5);state.selected=null;state.guideDismissed=true;save();closeDialog('sky-dialog');updateUI();moveCamera({ra,dec});});
  const originalOpenSky=openSky;
  openSky=function(){
    $('overview-list').replaceChildren(...unlocked().map(s=>{const b=document.createElement('button');b.className='secondary-button';b.textContent=`TIC ${s.tic} · ${s.dec<0?'남쪽':'북쪽'} 하늘 ↗`;b.onclick=()=>{closeDialog('sky-dialog');selectStar(s.tic);};return b;}));
    originalOpenSky();
  };
  $('overview-button').onclick=()=>openSky();$('overview-card-button').onclick=()=>openSky();$('show-new').onclick=()=>openSky();
  new ResizeObserver(resize).observe(surface);
  new ResizeObserver(() => { if (state.page === 'analysis') drawChart(); }).observe($('chart-container'));
  initWebGL(); updateUI(); resize(); if(currentStar()&&state.page==='map')focus(currentStar(),false); save();
})();
