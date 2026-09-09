(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const stars = window.PLANETORY_DATA;
  const tutorial = stars[0];
  const STORAGE = 'planetory-spec-prototype-v1';
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
  const view = { x: 0, y: 0, zoom: 1 };
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
  const position = s => ({ x: size.w * (size.w < 760 ? .76 : .54) + view.x + s.x * view.zoom, y: size.h * .41 + view.y + s.y * view.zoom });
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
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const points = [];
    for (const g of groups) {
      const s = g.members[0];
      const pointSize = g.members.length > 1 ? 180 : (s.tic === tutorial.tic ? 150 : 115) * Math.max(.65, Math.min(1.3, Math.sqrt(view.zoom)));
      points.push(g.x, g.y, pointSize, .85, .88, 1);
    }
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attr.pos); gl.vertexAttribPointer(attr.pos, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(attr.size); gl.vertexAttribPointer(attr.size, 1, gl.FLOAT, false, 24, 8);
    gl.enableVertexAttribArray(attr.color); gl.vertexAttribPointer(attr.color, 3, gl.FLOAT, false, 24, 12);
    gl.uniform2f(uniforms.viewport, size.w, size.h); gl.uniform1f(uniforms.dpr, size.dpr);
    gl.drawArrays(gl.POINTS, 0, groups.length);
  }
  function computeGroups() {
    const result = unlocked().map(s => ({ ...position(s), members: [s] }));
    if (view.zoom >= .8) return result;
    // A tiny fixture uses proximity grouping. Production needs precomputed LOD and spatial tiles.
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
        if (Math.hypot(result[i].x - result[j].x, result[i].y - result[j].y) < 46) {
          const members = [...result[i].members, ...result[j].members];
          result[i] = { x: members.reduce((v, s) => v + position(s).x, 0) / members.length, y: members.reduce((v, s) => v + position(s).y, 0) / members.length, members };
          result.splice(j, 1); merged = true; break outer;
        }
      }
    }
    return result;
  }
  function drawDecoration() {
    const svg = $('map-decoration'); svg.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
    const origin = position(tutorial);
    const fragment = document.createDocumentFragment();
    // Concentric guide marks describe the personal layout, not celestial coordinates.
    [190, 380, 650].forEach((r, i) => {
      const radius = r * view.zoom;
      if (radius < 18) return;
      fragment.append(el('circle', { cx: origin.x, cy: origin.y, r: radius, fill: 'none', stroke: i === 0 ? '#272e3b' : '#171b23', 'stroke-width': .7, 'stroke-dasharray': i === 0 ? '1 8' : '2 13' }));
    });
    if (state.guideDone) for (const s of stars.slice(1)) {
      const to = position(s);
      fragment.append(el('line', { x1: origin.x, y1: origin.y, x2: to.x, y2: to.y, stroke: '#273b5c', opacity: state.selected === s.tic ? '.9' : '.4', 'stroke-width': .8, 'stroke-dasharray': '3 8' }));
    }
    const r = 40 * Math.max(.7, Math.min(1.3, view.zoom));
    [0, 90, 180, 270].forEach(angle => {
      const a = angle * Math.PI / 180;
      fragment.append(el('line', { x1: origin.x + Math.cos(a) * (r + 22), y1: origin.y + Math.sin(a) * (r + 22), x2: origin.x + Math.cos(a) * (r + 29), y2: origin.y + Math.sin(a) * (r + 29), stroke: '#596d8b', 'stroke-width': .8 }));
    });
    svg.replaceChildren(fragment);
  }
  function renderMap() {
    if (!size.w || state.page !== 'map') return;
    groups = computeGroups();
    const key = groups.map(g => g.members.map(s => s.tic).join(',')).join('|') + `:${state.selected}:${state.guideDone}:${state.started.join(',')}:${state.seen.join(',')}:${webglAvailable}`;
    if (key !== renderKey) {
      const frag = document.createDocumentFragment();
      groups.forEach((g, index) => {
        const b = document.createElement('button'); b.className = 'star-node'; b.dataset.index = index;
        if (g.members.length > 1) {
          b.classList.add('cluster-node'); b.setAttribute('aria-label', `별 ${g.members.length}개 묶음, 눌러 확대`);
          b.innerHTML = `${g.members.length}<span class="star-label">별 ${g.members.length}개 · 눌러 확대</span>`;
          b.addEventListener('click', () => { state.selected = null; updateUI(); fit(g.members, true); });
          b.addEventListener('pointerenter', () => {
            const active = g.members.filter(s => state.started.includes(s.tic)).length;
            $('map-tooltip').textContent = `별 ${g.members.length}개 · 분석 중 ${active}개 · 미시작 ${g.members.length - active}개`;
            $('map-tooltip').style.left = `${Math.min(size.w - 235, g.x + 35)}px`;
            $('map-tooltip').style.top = `${g.y - 30}px`; $('map-tooltip').hidden = false;
          });
          b.addEventListener('pointerleave', () => { $('map-tooltip').hidden = true; });
        } else {
          const s = g.members[0];
          b.dataset.tic = s.tic;
          b.classList.toggle('selected', state.selected === s.tic);
          const isNew = s !== tutorial && !state.seen.includes(s.tic);
          const badge = s === tutorial ? '<span class="badge">1</span>' : isNew ? '<span class="badge new">NEW</span>' : '';
          const sub = s === tutorial ? (state.guideDone ? '안내 완료 · 분석 중' : '첫 번째 탐사') : (state.started.includes(s.tic) ? '분석 중' : '자유 탐사');
          b.innerHTML = `${badge}<span class="star-label">TIC ${s.tic}</span><span class="star-subtitle">${sub}</span>`;
          if (!webglAvailable) b.style.background = 'radial-gradient(circle,white 0 3px,#d9dcff50 5px,transparent 24px)';
          b.setAttribute('aria-label', `TIC ${s.tic}, ${sub}${isNew ? ', 새로 열린 별' : ''}`);
          b.setAttribute('aria-pressed', String(state.selected === s.tic));
          b.addEventListener('click', () => selectStar(s.tic));
        }
        frag.append(b);
      });
      $('map-nodes').replaceChildren(frag); renderKey = key;
    }
    [...$('map-nodes').children].forEach((b, i) => { b.style.left = `${groups[i].x}px`; b.style.top = `${groups[i].y}px`; });
    drawDecoration(); drawStars();
    $('zoom-label').textContent = `${Math.round(view.zoom * 100)}%`;
    $('map-area').textContent = state.guideDone ? 'EXPANSION / 01' : 'ORIGIN / 00';
    $('zoom-out').disabled = view.zoom <= .06;
    $('zoom-in').disabled = view.zoom >= 3.5;
  }
  function moveCamera(target, animate = true) {
    cancelAnimationFrame(cameraAnimation);
    $('map-tooltip').hidden = true;
    if (!animate || reduceMotion) { Object.assign(view, target); renderMap(); return; }
    const start = { ...view }, time = performance.now();
    function step(now) {
      const t = Math.min(1, (now - time) / 650), ease = 1 - Math.pow(1 - t, 3);
      for (const key of ['x', 'y', 'zoom']) view[key] = start[key] + (target[key] - start[key]) * ease;
      renderMap(); if (t < 1) cameraAnimation = requestAnimationFrame(step);
    }
    cameraAnimation = requestAnimationFrame(step);
  }
  function focus(s, animate = true) {
    const zoom = Math.max(.8, Math.min(1.1, view.zoom));
    const destX = size.w < 760 ? size.w * .76 : (size.w > 1120 ? size.w * .52 : size.w * .51);
    const destY = size.h * (size.w < 760 ? .38 : .42);
    moveCamera({ x: destX - size.w * (size.w < 760 ? .76 : .54) - s.x * zoom, y: destY - size.h * .41 - s.y * zoom, zoom }, animate);
  }
  function fit(members = unlocked(), expand = false, animate = true) {
    const xmin = Math.min(...members.map(s => s.x)), xmax = Math.max(...members.map(s => s.x));
    const ymin = Math.min(...members.map(s => s.y)), ymax = Math.max(...members.map(s => s.y));
    if (members.length === 1) return focus(members[0], animate);
    const mobile = size.w < 760;
    const left = mobile ? 50 : 335, right = size.w - (state.selected ? (mobile ? 35 : 365) : (mobile ? 35 : 85));
    const top = mobile ? 335 : 125, bottom = size.h - (mobile ? 290 : 210);
    const width = Math.max(150, right - left), height = Math.max(150, bottom - top);
    let zoom = Math.min(width / Math.max(180, xmax - xmin), height / Math.max(180, ymax - ymin), expand ? 1.5 : 1);
    zoom = Math.max(.15, zoom);
    moveCamera({ zoom, x: (left + right) / 2 - size.w * (mobile ? .76 : .54) - (xmin + xmax) / 2 * zoom, y: (top + bottom) / 2 - size.h * .41 - (ymin + ymax) / 2 * zoom }, animate);
  }
  function zoomAt(factor, x = size.w / 2, y = size.h / 2) {
    cancelAnimationFrame(cameraAnimation);
    const z = Math.max(.06, Math.min(3.5, view.zoom * factor)), ratio = z / view.zoom;
    const cx = size.w * (size.w < 760 ? .76 : .54), cy = size.h * .41;
    view.x = x - cx - (x - cx - view.x) * ratio; view.y = y - cy - (y - cy - view.y) * ratio;
    view.zoom = z; renderMap();
  }
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
    $('quest-action').innerHTML = state.guideDone ? '새로 열린 별 보기 <span>↗</span>' : stage === 2 ? '첫 분석으로 이동 <span>↗</span>' : '첫 번째 별 보기 <span>↗</span>';
    $('quest-content').hidden = !!state.questCollapsed;
    $('quest-toggle').setAttribute('aria-expanded', String(!state.questCollapsed)); $('quest-toggle-icon').textContent = state.questCollapsed ? '＋' : '−';
    $('welcome-card').hidden = (state.guideDone && !replayGuide) || state.guideDismissed || !!state.selected;
    $('new-notice').hidden = !state.guideDone || !!state.selected || stars.slice(1).every(s => state.seen.includes(s.tic));
    $('star-list').replaceChildren(...list.map(s => {
      const b = document.createElement('button'); b.className = 'list-star';
      b.innerHTML = `<i></i><span>TIC ${s.tic}<small>${s === tutorial ? '첫 탐사 안내' : '자유 탐사'}</small></span><span>${s !== tutorial && !state.seen.includes(s.tic) ? 'NEW' : '↗'}</span>`;
      b.addEventListener('click', () => { if (state.page !== 'map') returnMap(false); selectStar(s.tic); }); return b;
    }));
    const s = currentStar(); $('star-detail').hidden = !s;
    if (s) {
      $('detail-category').textContent = s === tutorial ? 'TUTORIAL 01' : `EXPLORATION ${stars.indexOf(s) + 1 < 10 ? '0' : ''}${stars.indexOf(s) + 1}`;
      $('detail-id').textContent = `TIC ${s.tic}`;
      $('detail-status').textContent = state.started.includes(s.tic) ? '분석 중' : '아직 분석하지 않았어요';
      $('detail-sectors').className = 'sector-chips'; $('detail-sectors').innerHTML = s.observations.map(o => `<span class="sector-chip">${o.sector}</span>`).join('');
      $('detail-mag').textContent = s.tmag == null ? '정보 없음' : `${s.tmag.toFixed(2)} 등급`;
      $('detail-path').textContent = s === tutorial ? '첫 탐사 안내' : '안내 완료 · 시연';
      $('detail-note').textContent = s === tutorial && state.guideDone ? '첫 분석 안내를 마쳤어요. 이 별의 분석은 계속할 수 있습니다.' : s === tutorial ? '이 별에서 첫 분석을 시작합니다. 별빛이 반복해서 줄어드는 흔적을 살펴보세요.' : '나의 탐사 지도에 새로 열린 별입니다. 관측 기록을 자유롭게 살펴보세요.';
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
      b.innerHTML = `<span class="small-star"></span><span>TIC ${s.tic}</span><small>관측 회차 ${s.observations.map(o => o.sector).join(' · ')}</small>`;
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

  surface.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    cancelAnimationFrame(cameraAnimation); surface.setPointerCapture(e.pointerId); surface.focus({ preventScroll: true });
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    surface.classList.add('dragging'); $('map-tooltip').hidden = true;
  });
  surface.addEventListener('pointermove', e => { if (!pointer || e.pointerId !== pointer.id) return; view.x = pointer.vx + e.clientX - pointer.x; view.y = pointer.vy + e.clientY - pointer.y; renderMap(); });
  const endDrag = () => { pointer = null; surface.classList.remove('dragging'); };
  surface.addEventListener('pointerup', endDrag); surface.addEventListener('pointercancel', endDrag); surface.addEventListener('lostpointercapture', endDrag);
  surface.addEventListener('wheel', e => { e.preventDefault(); const r = surface.getBoundingClientRect(); zoomAt(Math.exp(-Math.max(-180, Math.min(180, e.deltaY)) * .0025), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  surface.addEventListener('keydown', e => {
    if (e.target !== surface) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(e.key)) e.preventDefault();
    if (e.key === 'ArrowLeft') view.x += 50;
    if (e.key === 'ArrowRight') view.x -= 50;
    if (e.key === 'ArrowUp') view.y += 50;
    if (e.key === 'ArrowDown') view.y -= 50;
    if (e.key === '+' || e.key === '=') return zoomAt(1.25);
    if (e.key === '-') return zoomAt(.8);
    if (e.key === 'Home') return fit();
    renderMap();
  });
  $('zoom-in').onclick = () => zoomAt(1.25); $('zoom-out').onclick = () => zoomAt(.8);
  $('fit-map').onclick = () => fit();
  $('welcome-select').onclick = () => selectStar(tutorial.tic);
  $('welcome-close').onclick = () => { state.guideDismissed = true; save(); updateUI(); };
  $('quest-action').onclick = () => {
    if (state.guideDone) { state.selected = null; updateUI(); save(); fit(); }
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
  $('unlock-explore').onclick = () => { closeDialog('unlock-dialog'); fit(); };
  $('show-new').onclick = () => { state.selected = null; updateUI(); fit(); };
  $('legend-button').onclick = () => { $('legend').hidden = !$('legend').hidden; $('legend-button').setAttribute('aria-expanded', String(!$('legend').hidden)); };
  $('legend-close').onclick = () => { $('legend').hidden = true; $('legend-button').setAttribute('aria-expanded', 'false'); };
  $('help-button').onclick = () => showDialog('help-dialog');
  $('demo-button').onclick = () => showDialog('demo-dialog');
  $('reset-demo').onclick = () => {
    closeDialog('demo-dialog'); cancelAnimationFrame(cameraAnimation); replayGuide = false; analysisReturnView = null; state = initialState(); save(); renderKey = ''; Object.assign(view, { x: 0, y: 0, zoom: 1 });
    updateUI(); resize(); $('star-list').hidden = webglAvailable; $('list-toggle').setAttribute('aria-expanded', String(!webglAvailable)); $('list-arrow').textContent = webglAvailable ? '＋' : '−'; $('legend').hidden = true;
    toast('처음 방문 상태로 돌아왔습니다.');
  };
  $('unlocked-demo').onclick = () => { closeDialog('demo-dialog'); completeGuide(false); toast('두 별이 열린 시연 상태입니다. 실제 등급 변화는 없습니다.'); };
  $('restart-guide').onclick = () => {
    closeDialog('help-dialog'); replayGuide = true; state.page = 'map'; state.guideDismissed = false; state.selected = null; updateUI(); resize(); focus(tutorial); save();
  };
  $('nav-map').onclick = () => { if (state.page !== 'map') returnMap(); else { state.selected = null; updateUI(); fit(); save(); } };
  document.querySelector('.brand').onclick = e => { e.preventDefault(); $('nav-map').click(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { if (!$('legend').hidden) $('legend-close').click(); else if (state.page === 'map' && state.selected) $('detail-close').click(); } });
  new ResizeObserver(resize).observe(surface);
  new ResizeObserver(() => { if (state.page === 'analysis') drawChart(); }).observe($('chart-container'));
  initWebGL(); updateUI(); resize(); save();
})();
