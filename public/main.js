// 城東小あるき — PLATEAU那覇の実測データを歩く
// world.json: tools/build_world.py が CityGML(建物LOD1)+DEM(地形) から生成
import * as THREE from './lib/three.module.js';

const EYE = 1.62;          // 目線の高さ(m)
const WALK = 4.6, RUN = 9.4;
const GRAVITY = 22, JUMP = 7.2;
const HOLD_MS = 320;       // ジャンプ長押しで飛行を切り替えるまでの時間
const FLY = 14, FLY_V = 9; // 飛行の水平・垂直速度(m/s)
const FLY_CEIL = 480;      // 地表からの上限高度(m)
const RADIUS = 0.55;       // プレイヤーの当たり半径(m)
const N_SEESAA = 10;
const PICKUP = 4.0;        // 保護できる距離(m)
const HASH = 24;           // 当たり判定用の空間ハッシュの升目(m)。建物・道路で共用

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 端末
// ?touch=1 でPCでもタッチUIを確認できる(?touch=0 で強制的に切る)
const qs = new URLSearchParams(location.search);
const TOUCH = qs.has('touch')
  ? qs.get('touch') !== '0'
  : (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
if (TOUCH) document.body.classList.add('touch');

// ---------------------------------------------------------------- ワールド
const world = await fetch('./data/world.json').then((r) => r.json());
const { size, cell, n, groundAtCenter } = world.meta;
const HALF = size / 2;
const terrain = world.terrain;               // terrain[ix*n + iz]

/** 世界座標(x,z) の地表標高。グリッドを双一次補間する。 */
function groundAt(x, z) {
  const fx = Math.min(n - 1.001, Math.max(0, (x + HALF) / cell));
  const fz = Math.min(n - 1.001, Math.max(0, (z + HALF) / cell));
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
  const a = terrain[i * n + j],       b = terrain[(i + 1) * n + j];
  const c = terrain[i * n + j + 1],   d = terrain[(i + 1) * n + j + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

// ---------------------------------------------------------------- 3D基盤
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 2600);
const renderer = new THREE.WebGLRenderer({
  antialias: !TOUCH, powerPreference: 'high-performance',
});
// スマホは画素数が効くので上限を下げる(Retinaで等倍だと描画量が4倍になる)
renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = TOUCH ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

const SKY_TOP = new THREE.Color(0x2f7fc4);
const SKY_BOT = new THREE.Color(0xcfe4ec);
scene.fog = new THREE.Fog(SKY_BOT.getHex(), 260, 1250);

// 空(内側から見るドーム)
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(2000, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: SKY_TOP }, bot: { value: SKY_BOT } },
    vertexShader: `varying float h;
      void main(){ vec4 w = modelMatrix*vec4(position,1.0); h = normalize(w.xyz).y;
        gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 bot; varying float h;
      void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*1.5+0.08,0.0,1.0)), 1.0); }`,
  })
));

scene.add(new THREE.HemisphereLight(0xbcd9ea, 0x6f6a55, 1.5));
const sun = new THREE.DirectionalLight(0xfff2dc, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(TOUCH ? 1024 : 2048, TOUCH ? 1024 : 2048);
const SH = TOUCH ? 70 : 105;   // 影を描く範囲(プレイヤー中心 ±SH m)
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 640 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0012;
sun.shadow.normalBias = 0.55;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- 質感
const MAXANISO = renderer.capabilities.getMaxAnisotropy();

/** ビルのファサード。1枚 = 横16m × 縦12.8m(3.2m階高×4層)。 */
const TILE_W = 16, TILE_H = 12.8;
function facadeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
  const CW = 32, CH = 64;                    // 1窓 = 2m × 3.2m
  for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 8; k++) {
      g.fillStyle = `rgba(46,54,60,${0.26 + Math.random() * 0.34})`;   // 窓
      g.fillRect(k * CW + 7, row * CH + 13, CW - 14, CH - 33);
    }
    g.fillStyle = 'rgba(0,0,0,.10)';                                    // 床スラブの陰
    g.fillRect(0, row * CH + CH - 6, 256, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = MAXANISO;
  return t;
}

// ---------------------------------------------------------------- 道路
// PLATEAU の交通モデル(tran LOD1)の道路「面」。中心線ではなく実際の路面形状で、
// 高さは持たない(一律0)ため平面として扱い、地面テクスチャに焼いて地形へ伏せる。
const rstore = [];
const rmap = new Map();
{
  for (const r of world.roads ?? []) {
    const f = r.f, m = f.length / 2;
    const ring = new Array(m);
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < m; i++) {
      const x = f[i * 2] - HALF, z = f[i * 2 + 1] - HALF;
      ring[i] = new THREE.Vector2(x, z);
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    const idx = rstore.length;
    rstore.push({ ring, minx, maxx, minz, maxz });
    for (let gx = Math.floor(minx / HASH); gx <= Math.floor(maxx / HASH); gx++) {
      for (let gz = Math.floor(minz / HASH); gz <= Math.floor(maxz / HASH); gz++) {
        const k = `${gx},${gz}`;
        (rmap.get(k) ?? rmap.set(k, []).get(k)).push(idx);
      }
    }
  }
  console.log(`道路面 ${rstore.length}`);
}

/** (x,z) が道路面の上か。シーサーの設置場所選びに使う。 */
function onRoad(x, z) {
  const ids = rmap.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`);
  if (!ids) return false;
  for (const id of ids) {
    const r = rstore[id];
    if (x < r.minx || x > r.maxx || z < r.minz || z > r.maxz) continue;
    const g = r.ring, m = g.length;
    let inside = false;
    for (let k = 0, l = m - 1; k < m; l = k++) {
      const a = g[k], c = g[l];
      if ((a.y > z) !== (c.y > z) &&
          x < (c.x - a.x) * (z - a.y) / (c.y - a.y) + a.x) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** canvas に道路面のパスを引く(塗りは呼び出し側)。 */
function roadPath(ctx, toX, toZ) {
  ctx.beginPath();
  for (const r of rstore) {
    ctx.moveTo(toX(r.ring[0].x), toZ(r.ring[0].y));
    for (let i = 1; i < r.ring.length; i++) ctx.lineTo(toX(r.ring[i].x), toZ(r.ring[i].y));
    ctx.closePath();
  }
}

/**
 * 地面を1枚のテクスチャで描く。道路は tran の実データを焼き、
 * それ以外は建物 footprint を太らせた「敷地」とその密度場で塗り分ける。
 * 密度が高い=敷地、どこからも離れた広い場所=緑地。tran に入らない
 * 私道・路地は密度から弱く推定して補う。
 * bstore / rstore に依存するので建物と道路を組み立てたあとに呼ぶこと。
 */
function groundTexture() {
  const W = TOUCH ? 1024 : 2048;   // 生成は素のJSループなので端末に合わせる
  const s = W / size;                       // px / m
  const lot = document.createElement('canvas'); lot.width = lot.height = W;
  const lg = lot.getContext('2d', { willReadFrequently: true });
  lg.fillStyle = '#000'; lg.fillRect(0, 0, W, W);
  lg.fillStyle = lg.strokeStyle = '#fff';
  lg.lineJoin = 'round';
  lg.lineWidth = 4.5 * s;                   // 建物の外側 2.25m までを敷地とみなす
  for (const b of bstore) {
    lg.beginPath();
    lg.moveTo((b.ring[0].x + HALF) * s, (b.ring[0].y + HALF) * s);
    for (let i = 1; i < b.ring.length; i++) {
      lg.lineTo((b.ring[i].x + HALF) * s, (b.ring[i].y + HALF) * s);
    }
    lg.closePath(); lg.fill(); lg.stroke();
  }

  const den = document.createElement('canvas'); den.width = den.height = W;
  const dg = den.getContext('2d', { willReadFrequently: true });
  dg.filter = `blur(${14 * s}px)`;          // 14m ぼかし = 街区スケール
  dg.drawImage(lot, 0, 0);

  // 実データの道路面。輪郭のぼかし版を路肩(縁石まわり)の帯として使う
  const rd = document.createElement('canvas'); rd.width = rd.height = W;
  const rg = rd.getContext('2d', { willReadFrequently: true });
  rg.fillStyle = '#000'; rg.fillRect(0, 0, W, W);
  rg.fillStyle = '#fff';
  roadPath(rg, (x) => (x + HALF) * s, (z) => (z + HALF) * s);
  rg.fill();

  const rds = document.createElement('canvas'); rds.width = rds.height = W;
  const rsg = rds.getContext('2d', { willReadFrequently: true });
  rsg.filter = `blur(${1.8 * s}px)`;        // 1.8m ぼかし = 路肩の帯
  rsg.drawImage(rd, 0, 0);

  const A = lg.getImageData(0, 0, W, W), B = dg.getImageData(0, 0, W, W);
  const R = rg.getImageData(0, 0, W, W), RS = rsg.getImageData(0, 0, W, W);
  const a = A.data, b = B.data, rr = R.data, rs = RS.data;
  const PAVE = [154, 150, 142];             // 敷地(コンクリ)
  const ROAD = [110, 110, 114];             // 道路(アスファルト)
  const EDGE = [138, 134, 112];             // 路肩・未舗装
  const GREEN = [111, 147, 73];             // 緑地
  // 閾値で切ると色の帯ができるので、密度に沿って連続的に混ぜる
  const mix = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t,
                            p[2] + (q[2] - p[2]) * t];
  const sstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < a.length; i += 4) {
    const solid = a[i], dens = b[i], rc = rr[i] / 255, rsv = rs[i] / 255;
    let c;
    // 実データの道路が最優先。敷地の外周(建物から2.25m)と重なる帯は実際には路面
    if (rc > 0.5) c = ROAD;
    else if (solid > 128) c = PAVE;                       // 建物の敷地
    else {
      // 市街地なので、建物からよほど離れた所だけを緑地にする
      c = mix(GREEN, EDGE, sstep(2, 13, dens));           // 緑地 → 路肩
      // tran に入らない私道・路地は密度から弱く推定して補う
      c = mix(c, ROAD, 0.5 * sstep(15, 44, dens));
      c = mix(c, EDGE, sstep(0.04, 0.5, rsv));            // 実道路の際は路肩
      c = mix(c, ROAD, sstep(0.5, 0.95, rc));             // 縁のアンチエイリアス
    }
    const n = 0.88 + Math.random() * 0.24;                // ざらつき
    a[i] = c[0] * n; a[i + 1] = c[1] * n; a[i + 2] = c[2] * n;
  }
  lg.putImageData(A, 0, 0);

  const t = new THREE.CanvasTexture(lot);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAXANISO;
  return t;
}

/** 1枚テクスチャは 0.5m/px しかないので、足元用に細かい明暗を別途重ねる。 */
function detailTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = Math.random() < 0.5
      ? `rgba(0,0,0,${Math.random() * 0.22})` : `rgba(255,255,255,${Math.random() * 0.16})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = MAXANISO;
  return t;
}

// ---------------------------------------------------------------- 建物
// 全棟を1つのBufferGeometryに詰める(ドローコール1回)。
// 底面リングは build_world.py で CCW(符号付き面積>0)に揃えてある。
const bmap = new Map();          // 空間ハッシュ: "gx,gz" -> [建物index]
const bstore = [];               // 当たり判定用 {ring:[x,z,...], minx,maxx,minz,maxz}

{
  // 壁と屋根は別マテリアルにしたいので、頂点を2群に分けてから連結する
  const WV = [], WC = [], WU = [], RV = [], RC = [], RU = [];
  const wall = new THREE.Color(), roof = new THREE.Color();
  const pushW = (x, y, z, u, v) => { WV.push(x, y, z); WC.push(wall.r, wall.g, wall.b); WU.push(u, v); };
  const pushR = (x, y, z) => { RV.push(x, y, z); RC.push(roof.r, roof.g, roof.b); RU.push(x / 8, z / 8); };

  for (const b of world.buildings) {
    const f = b.f, m = f.length / 2;
    const ring = new Array(m);
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < m; i++) {
      const x = f[i * 2] - HALF, z = f[i * 2 + 1] - HALF;
      ring[i] = new THREE.Vector2(x, z);
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    // 斜面で建物が浮かないよう、底は地表より少し下まで伸ばす
    const gc = groundAt((minx + maxx) / 2, (minz + maxz) / 2);
    const base = Math.min(b.b, gc) - 2.5;
    const top = b.b + b.h;

    // 沖縄のRC造をイメージした白〜生成りの外壁。棟ごとに少し振る
    const t = (Math.sin(minx * 0.37 + minz * 0.71) * 0.5 + 0.5);
    wall.setHSL(0.09 + t * 0.05, 0.10 + t * 0.10, 0.56 + t * 0.16);
    // 低層の一部は赤瓦屋根に(俯瞰したときの沖縄らしさ)
    const tile = Math.sin(minx * 1.13 - minz * 0.61) * 0.5 + 0.5;
    if (b.h < 9.5 && tile < 0.38) roof.setHSL(0.045, 0.44, 0.36 + tile * 0.18);
    else roof.copy(wall).multiplyScalar(0.74);

    // 側面: 稜線 i→i+1 の外向き法線は (dz, 0, -dx)。
    // UV は横=外周の累積距離、縦=その建物の地面からの高さ(階が揃うように)
    let u = 0;
    const vLo = (base - b.b) / TILE_H, vHi = (top - b.b) / TILE_H;
    for (let i = 0; i < m; i++) {
      const p = ring[i], q = ring[(i + 1) % m];
      const u0 = u, u1 = u + Math.hypot(q.x - p.x, q.y - p.y) / TILE_W;
      u = u1;
      const A = [p.x, base, p.y, u0, vLo], B = [q.x, base, q.y, u1, vLo];
      const Cc = [q.x, top, q.y, u1, vHi], D = [p.x, top, p.y, u0, vHi];
      for (const v of [A, Cc, B]) pushW(...v);
      for (const v of [A, D, Cc]) pushW(...v);
    }
    // 屋根: CCW のまま貼ると法線が下を向くので三角形を反転する
    for (const [a, bb, cc] of THREE.ShapeUtils.triangulateShape(ring, [])) {
      for (const k of [cc, bb, a]) pushR(ring[k].x, top, ring[k].y);
    }

    // 当たり判定用の登録
    const idx = bstore.length;
    bstore.push({ ring, minx, maxx, minz, maxz, top });
    for (let gx = Math.floor(minx / HASH); gx <= Math.floor(maxx / HASH); gx++) {
      for (let gz = Math.floor(minz / HASH); gz <= Math.floor(maxz / HASH); gz++) {
        const k = `${gx},${gz}`;
        (bmap.get(k) ?? bmap.set(k, []).get(k)).push(idx);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(WV.concat(RV), 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(WC.concat(RC), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(WU.concat(RU), 2));
  geo.computeVertexNormals();
  const nWall = WV.length / 3;
  geo.addGroup(0, nWall, 0);
  geo.addGroup(nWall, RV.length / 3, 1);
  const mesh = new THREE.Mesh(geo, [
    new THREE.MeshLambertMaterial({ vertexColors: true, map: facadeTexture() }),
    new THREE.MeshLambertMaterial({ vertexColors: true }),
  ]);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  console.log(`建物 ${world.buildings.length} 棟 / 壁 ${nWall} + 屋根 ${RV.length / 3} 頂点`);
}

/** (x,z) が建物の壁から r 以内(または内部)か。r を広げれば「開けた場所」判定になる。 */
// ---------------------------------------------------------------- モノレール
// 沖縄都市モノレール(ゆいレール)。線形は国土数値情報由来の2D中心線なので、
// 跨座式の高架らしく地形から一定の高さに桁を浮かせ、橋脚で地面まで降ろす。
const RAIL_H = 10.5;        // 地表から桁の中心までの高さ(m)
const BEAM_W = 0.85;        // 桁の幅(m)
const BEAM_T = 1.6;         // 桁の高さ(m)
const PIER_EVERY = 26;      // 橋脚の間隔(m)
const railPaths = [];       // 描画・車両走行に使う {pts:[{x,y,z}], len, cum[]}

function buildMonorail() {
  const group = new THREE.Group();
  const beamMat = new THREE.MeshLambertMaterial({ color: 0xd8d5cc });
  const pierMat = new THREE.MeshLambertMaterial({ color: 0xc3c0b6 });
  const V = [], N = [], piers = [];

  const push = (p, nx, ny, nz) => { V.push(p[0], p[1], p[2]); N.push(nx, ny, nz); };
  const quad = (a, b, c, d, nx, ny, nz) => {
    push(a, nx, ny, nz); push(b, nx, ny, nz); push(c, nx, ny, nz);
    push(a, nx, ny, nz); push(c, nx, ny, nz); push(d, nx, ny, nz);
  };

  for (const flat of world.rail ?? []) {
    // 8m 間隔に打ち直す(元データは頂点が疎で、地形に沿わせるため)
    const raw = [];
    for (let i = 0; i < flat.length; i += 2) raw.push([flat[i] - HALF, flat[i + 1] - HALF]);
    const pts = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const [ax, az] = raw[i], [bx, bz] = raw[i + 1];
      const d = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.round(d / 8));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      }
    }
    pts.push(raw[raw.length - 1]);
    if (pts.length < 2) continue;

    // 桁の高さ: 地形+RAIL_H を移動平均でならす(実物ほど水平ではないが起伏は消える)
    const gy = pts.map(([x, z]) => groundAt(x, z) + RAIL_H);
    const y = gy.map((_, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - 6); k <= Math.min(gy.length - 1, i + 6); k++) { s += gy[k]; c++; }
      return s / c;
    });

    const path = { pts: pts.map(([x, z], i) => ({ x, y: y[i], z })), cum: [0], len: 0 };
    for (let i = 1; i < pts.length; i++) {
      path.len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      path.cum.push(path.len);
    }
    railPaths.push(path);

    // 桁を角断面のリボンとして張る
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const px = dz * BEAM_W, pz = -dx * BEAM_W;      // 断面の横方向
      const ay = y[i], by = y[i + 1];
      const c = (x, yy, z) => [x, yy, z];
      // 上面・下面・左右
      quad(c(ax - px, ay + BEAM_T / 2, az - pz), c(bx - px, by + BEAM_T / 2, bz - pz),
           c(bx + px, by + BEAM_T / 2, bz + pz), c(ax + px, ay + BEAM_T / 2, az + pz), 0, 1, 0);
      quad(c(ax + px, ay - BEAM_T / 2, az + pz), c(bx + px, by - BEAM_T / 2, bz + pz),
           c(bx - px, by - BEAM_T / 2, bz - pz), c(ax - px, ay - BEAM_T / 2, az - pz), 0, -1, 0);
      quad(c(ax - px, ay - BEAM_T / 2, az - pz), c(bx - px, by - BEAM_T / 2, bz - pz),
           c(bx - px, by + BEAM_T / 2, bz - pz), c(ax - px, ay + BEAM_T / 2, az - pz), -dz, 0, dx);
      quad(c(ax + px, ay + BEAM_T / 2, az + pz), c(bx + px, by + BEAM_T / 2, bz + pz),
           c(bx + px, by - BEAM_T / 2, bz + pz), c(ax + px, ay - BEAM_T / 2, az + pz), dz, 0, -dx);
    }

    // 橋脚(地形がある範囲だけ)。本数が多いので位置だけ溜めて後でまとめる
    let next = 0;
    for (let i = 0; i < pts.length; i++) {
      if (path.cum[i] < next) continue;
      next = path.cum[i] + PIER_EVERY;
      const [x, z] = pts[i];
      if (Math.abs(x) > HALF - 2 || Math.abs(z) > HALF - 2) continue;
      const g = groundAt(x, z);
      const h = y[i] - BEAM_T / 2 - g;
      if (h < 1) continue;
      piers.push([x, g + h / 2, z, h]);
    }
  }

  // 橋脚は1本のInstancedMeshにまとめる(高さは行列のYスケールで出す)
  if (piers.length) {
    const im = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.75, 0.95, 1, 8), pierMat, piers.length);
    const m = new THREE.Matrix4();
    piers.forEach(([x, y0, z, h], i) => {
      m.makeScale(1, h, 1); m.setPosition(x, y0, z);
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = im.receiveShadow = true;
    group.add(im);
  }

  if (V.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    const beam = new THREE.Mesh(geo, beamMat);
    beam.castShadow = beam.receiveShadow = true;
    group.add(beam);
  }
  scene.add(group);
  console.log(`モノレール 線形${railPaths.length}本 / 桁${V.length / 3}頂点 / 橋脚${piers.length}本`);
  return group;
}

/** (x,z) で足が乗る高さ。地表か、footprint 内なら建物の天端(=屋根に立てる)。 */
function supportY(x, z) {
  let h = groundAt(x, z);
  const ids = bmap.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`);
  if (!ids) return h;
  for (const id of ids) {
    const b = bstore[id];
    if (b.top <= h) continue;
    if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
    const g = b.ring, m = g.length;
    let inside = false;
    for (let k = 0, l = m - 1; k < m; l = k++) {
      const a = g[k], c = g[l];
      if ((a.y > z) !== (c.y > z) &&
          x < (c.x - a.x) * (z - a.y) / (c.y - a.y) + a.x) inside = !inside;
    }
    if (inside) h = b.top;
  }
  return h;
}

/**
 * (x,z) が壁に触れているか。y を渡すと、その建物の天端より上に居る場合は
 * 通り抜けられる(飛行で屋根を越える・屋根の上を歩くため)。
 */
function blocked(x, z, r = RADIUS, y = -Infinity) {
  const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const ids = bmap.get(`${gx + i},${gz + j}`);
      if (!ids) continue;
      for (const id of ids) {
        const b = bstore[id];
        if (y > b.top) continue;                 // 天端より上なら素通り
        if (x < b.minx - r || x > b.maxx + r ||
            z < b.minz - r || z > b.maxz + r) continue;
        const rg = b.ring, m = rg.length;
        let inside = false;
        for (let k = 0, l = m - 1; k < m; l = k++) {
          const a = rg[k], c = rg[l];
          if ((a.y > z) !== (c.y > z) &&
              x < (c.x - a.x) * (z - a.y) / (c.y - a.y) + a.x) inside = !inside;
          // 壁との距離(線分-点)
          const dx = c.x - a.x, dz = c.y - a.y;
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz || 1)));
          const ex = a.x + t * dx - x, ez = a.y + t * dz - z;
          if (ex * ex + ez * ez < r * r) return true;
        }
        if (inside) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- 地形
// 建物の分布が分かってから着色する(建物際=舗装、離れる=緑地)ので建物より後に置く。
/** (x,z) から最寄り建物の外接矩形までの距離。max を超えるものは max で打ち切る。 */
function distToBuilding(x, z, max = 20) {
  let best = max;
  const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const ids = bmap.get(`${gx + i},${gz + j}`);
      if (!ids) continue;
      for (const id of ids) {
        const b = bstore[id];
        const dx = Math.max(b.minx - x, 0, x - b.maxx);
        const dz = Math.max(b.minz - z, 0, z - b.maxz);
        const d = Math.hypot(dx, dz);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

{
  // UVは PlaneGeometry の既定(u=東 0→1, v=北で1)。groundTexture の画素配置と一致する。
  const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2);   // 頂点順: ix が東(+X)、iz が南(+Z)
  const pos = geo.attributes.position;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) pos.setY(iz * n + ix, terrain[ix * n + iz]);
  }
  geo.computeVertexNormals();
  const gmat = new THREE.MeshLambertMaterial({ map: groundTexture() });
  // 近景がぼけないよう、地面のUVを何度も繰り返す細かいノイズを乗算する
  const detail = detailTexture();
  gmat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detail };
    sh.fragmentShader = 'uniform sampler2D detailMap;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       diffuseColor.rgb *= texture2D(detailMap, vMapUv * ${(size / 3).toFixed(1)}).rgb;`
    );
  };
  const ground = new THREE.Mesh(geo, gmat);
  ground.receiveShadow = true;
  scene.add(ground);

  // 1km四方の外側。端が崖に見えないよう、平均標高の広い受け皿を敷く
  const skirt = new THREE.Mesh(
    new THREE.CircleGeometry(4000, 48),
    new THREE.MeshLambertMaterial({ color: 0x7d9159 })
  );
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.y = (world.meta.minZ + world.meta.maxZ) / 2 - 6;
  scene.add(skirt);
}

// ---------------------------------------------------------------- 電柱
// 垂直の目印が無いと街の奥行きが読めないので、道路際とおぼしき所に立てる
{
  const spots = [];
  for (let x = -HALF + 25; x < HALF - 25; x += 17) {
    for (let z = -HALF + 25; z < HALF - 25; z += 17) {
      const jx = x + Math.sin(x * 0.7 + z) * 5.5;   // 機械的な等間隔を崩す
      const jz = z + Math.cos(z * 0.9 - x) * 5.5;
      const d = distToBuilding(jx, jz, 12);
      if (d > 3.2 && d < 6.8) spots.push([jx, jz]);
    }
  }
  const geoP = new THREE.CylinderGeometry(0.13, 0.17, 9.5, 6);
  geoP.translate(0, 4.75, 0);
  const poles = new THREE.InstancedMesh(
    geoP, new THREE.MeshLambertMaterial({ color: 0xbdb8ac }), spots.length
  );
  const m4 = new THREE.Matrix4();
  spots.forEach(([x, z], i) => {
    m4.makeTranslation(x, groundAt(x, z), z);
    poles.setMatrixAt(i, m4);
  });
  poles.castShadow = true;
  scene.add(poles);
  console.log(`電柱 ${spots.length} 本`);
}

// ---------------------------------------------------------------- シーサー
function makeSeesaa() {
  const g = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: 0xd9c9a8 });
  const dark = new THREE.MeshLambertMaterial({ color: 0xa08a63 });
  const add = (geo, mat, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.scale.set(sx, sy, sz);
    m.castShadow = true; g.add(m); return m;
  };
  add(new THREE.BoxGeometry(1.1, 0.5, 1.1), dark, 0, 0.25, 0);            // 台座
  add(new THREE.SphereGeometry(0.42, 12, 10), stone, 0, 0.86, 0, 1, 1.05, 1.35); // 胴
  add(new THREE.SphereGeometry(0.33, 12, 10), stone, 0, 1.42, 0.16);      // 頭
  add(new THREE.ConeGeometry(0.13, 0.26, 6), stone, -0.19, 1.68, 0.1);    // 耳
  add(new THREE.ConeGeometry(0.13, 0.26, 6), stone, 0.19, 1.68, 0.1);
  add(new THREE.SphereGeometry(0.09, 8, 6), dark, -0.13, 1.44, 0.44);     // 目
  add(new THREE.SphereGeometry(0.09, 8, 6), dark, 0.13, 1.44, 0.44);
  add(new THREE.ConeGeometry(0.11, 0.6, 6), stone, 0, 1.15, -0.42).rotation.x = 0.9; // 尾
  for (const s of [-1, 1]) {                                              // 前足
    add(new THREE.CylinderGeometry(0.11, 0.13, 0.5, 6), stone, s * 0.24, 0.72, 0.38);
  }
  add(new THREE.SphereGeometry(0.17, 10, 8), stone, 0, 1.30, 0.36, 1, 0.75, 1);  // 鼻づら
  for (let i = 0; i < 9; i++) {                                           // たてがみ
    const a = (i / 8 - 0.5) * 2.2;
    add(new THREE.SphereGeometry(0.095, 7, 6), dark,
        Math.sin(a) * 0.33, 1.40 + Math.cos(a) * 0.29, -0.13);
  }

  // 遠くからでも見つけられる光の柱
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.62, 90, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffb066, transparent: true, opacity: 0.15,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    })
  );
  beam.position.y = 45;
  g.add(beam);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.07, 8, 30),
    new THREE.MeshBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0.85 })
  );
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.1;
  g.add(ring);
  g.userData.ring = ring;
  return g;
}

// 街のなかの、建物に当たらない場所へ散らす(擬似乱数=毎回同じ配置)
let seed = 20260805;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const seesaa = [];

/** 道路面の上から、互いに離れた設置点を選ぶ(道沿いに立つので必ず辿り着ける)。 */
function roadSpots(want) {
  const cand = [];
  for (const r of rstore) {
    let cx = 0, cz = 0;
    for (const p of r.ring) { cx += p.x; cz += p.y; }
    cx /= r.ring.length; cz /= r.ring.length;
    const d = Math.hypot(cx, cz);
    if (d < 50 || d > 400) continue;                 // 近すぎ・遠すぎを除く
    if (Math.abs(cx) > HALF - 30 || Math.abs(cz) > HALF - 30) continue;
    if (!onRoad(cx, cz)) continue;                   // 凹多角形の重心は外に出うる
    if (blocked(cx, cz, 2.4)) continue;              // 台座ぶんの余裕をとる
    cand.push([cx, cz]);
  }
  for (let i = cand.length - 1; i > 0; i--) {        // 擬似乱数でシャッフル
    const j = (rnd() * (i + 1)) | 0;
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  // まず十分離して選び、足りなければ間隔を詰めて補う
  const out = [];
  for (const sep of [110, 70, 40, 0]) {
    for (const c of cand) {
      if (out.length >= want) break;
      if (out.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) > sep) &&
          !out.includes(c)) out.push(c);
    }
    if (out.length >= want) break;
  }
  return out;
}

const spots = roadSpots(N_SEESAA);
for (let i = 0; i < N_SEESAA; i++) {
  let placed = spots[i] ?? null;
  if (!placed) {                                     // 道路が無い区画向けの保険
    const ang = (i / N_SEESAA) * Math.PI * 2 + rnd() * 0.55;
    for (let tries = 0; tries < 260 && !placed; tries++) {
      const rad = 55 + rnd() * 330;
      const x = Math.cos(ang + (rnd() - 0.5) * 0.5) * rad;
      const z = Math.sin(ang + (rnd() - 0.5) * 0.5) * rad;
      if (Math.abs(x) > HALF - 30 || Math.abs(z) > HALF - 30) continue;
      if (!blocked(x, z, 2.4)) placed = [x, z];
    }
  }
  if (!placed) continue;
  const [x, z] = placed;
  const g = makeSeesaa();
  g.position.set(x, groundAt(x, z), z);
  g.rotation.y = rnd() * Math.PI * 2;   // 以降 tick でゆっくり回る(どの向きから来ても顔が見える)
  g.userData.taken = false;
  scene.add(g);
  seesaa.push(g);
}

// ---------------------------------------------------------------- 城東小の目印
{
  const g = new THREE.Group();
  const y = groundAt(0, 0);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.16, 13, 8),
    new THREE.MeshLambertMaterial({ color: 0xe8e2d4 })
  );
  pole.position.y = 6.5; pole.castShadow = true; g.add(pole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 2.1),
    new THREE.MeshLambertMaterial({ color: 0xe8642f, side: THREE.DoubleSide })
  );
  flag.position.set(1.75, 11.4, 0); flag.castShadow = true; g.add(flag);

  // 校名の看板(canvasテクスチャ)
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#0d1b1e'; cx.fillRect(0, 0, 512, 128);
  cx.fillStyle = '#f6f3ea';
  cx.font = 'bold 62px "Hiragino Sans", sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText('城東小学校', 256, 66);
  const sign = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false, fog: false,
  }));
  sign.position.y = 16; sign.scale.set(13, 3.25, 1);
  g.add(sign);
  g.position.set(0, y, 0);
  scene.add(g);
}

// ---------------------------------------------------------------- モノレール設置
buildMonorail();

/** 折れ線の距離 d の地点と進行方位を返す。 */
function railAt(path, d) {
  d = Math.max(0, Math.min(path.len, d));
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i] < d) i++;
  const span = path.cum[i] - path.cum[i - 1] || 1;
  const t = (d - path.cum[i - 1]) / span;
  const a = path.pts[i - 1], b = path.pts[i];
  return {
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
    yaw: Math.atan2(b.x - a.x, b.z - a.z),
  };
}

/** 文字を描いた板(スプライト)。駅名の表示に使う。 */
function makeLabel(text, w = 9, h = 2.4) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#0d1b1e'; c.fillRect(0, 0, 512, 128);
  c.fillStyle = '#f6f3ea';
  c.font = 'bold 62px "Hiragino Sans", sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 256, 66);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false, fog: false,
  }));
  s.scale.set(w, h, 1);
  return s;
}

// 駅(ホーム＋屋根＋駅名)。線形上のいちばん近い点に合わせて向きを決める
for (const st of world.stations ?? []) {
  const sx = st.x - HALF, sz = st.z - HALF;
  let best = null;
  for (const p of railPaths) {
    for (let d = 0; d <= p.len; d += 4) {
      const q = railAt(p, d);
      const dist = Math.hypot(q.x - sx, q.z - sz);
      if (!best || dist < best.dist) best = { dist, q };
    }
  }
  if (!best || best.dist > 90) continue;
  const { q } = best;
  // 駅舎は PLATEAU の建物として既にある(石嶺駅=17x53m/高さ約16m)。
  // 高架はその中をホーム高さで通り抜けるのが実際の姿なので、
  // ホームを作らず駅名だけを建物の上に出す。
  const lab = makeLabel(`${st.name}駅`);
  lab.position.set(q.x, supportY(q.x, q.z) + 5.5, q.z);
  scene.add(lab);
  console.log(`駅名を設置: ${st.name} (${q.x.toFixed(0)}, ${q.z.toFixed(0)})`);
}

// ---------------------------------------------------------------- バス停
// 出典は OpenStreetMap(ODbL)。国土数値情報のバス停(P11)は「非商用」区分で
// 複製物の再配布が禁止なので、公開物には使えない。
const busSigns = [];
{
  const stops = world.bus ?? [];
  if (stops.length) {
    // 支柱はまとめて1ドローコール
    const poleGeo = new THREE.CylinderGeometry(0.055, 0.07, 2.75, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x8d9295 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, stops.length);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.3, 0.16, 8),
      new THREE.MeshLambertMaterial({ color: 0x76797b }));
    const bases = new THREE.InstancedMesh(base.geometry, base.material, stops.length);
    const m = new THREE.Matrix4();

    stops.forEach((s, i) => {
      const x = s.x - HALF, z = s.z - HALF;
      const g = groundAt(x, z);
      m.makeTranslation(x, g + 1.38, z);
      poles.setMatrixAt(i, m);
      m.makeTranslation(x, g + 0.08, z);
      bases.setMatrixAt(i, m);

      // 標識は板(スプライト)。名前が常に読めるのと、向きを持たなくて済む
      const cv = document.createElement('canvas');
      cv.width = 384; cv.height = 128;
      const c = cv.getContext('2d');
      c.fillStyle = '#f6f3ea';
      c.beginPath(); c.roundRect(4, 20, 376, 88, 14); c.fill();
      c.strokeStyle = '#2f8fc4'; c.lineWidth = 6;
      c.beginPath(); c.roundRect(4, 20, 376, 88, 14); c.stroke();
      c.fillStyle = '#1d5f7d';
      c.font = 'bold 20px "Hiragino Sans", sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      // 絵文字はフォント環境で崩れるので文字だけにする
      c.fillText('バスのりば', 192, 42);
      c.fillStyle = '#0d1b1e';
      const name = s.name || 'バス停';
      c.font = `bold ${name.length > 8 ? 30 : 38}px "Hiragino Sans", sans-serif`;
      c.fillText(name, 192, 80);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(cv), transparent: true,
      }));
      sp.scale.set(3.9, 1.3, 1);
      sp.position.set(x, g + 3.1, z);
      scene.add(sp);
      busSigns.push(sp);
    });
    poles.instanceMatrix.needsUpdate = true;
    bases.instanceMatrix.needsUpdate = true;
    poles.castShadow = bases.castShadow = true;
    scene.add(poles, bases);
    console.log(`バス停 ${stops.length}基`);
  }
}

// ---------------------------------------------------------------- 市議会の言及
// council.json は tools/link_council.py が作る。ワールド内の施設名で
// 那覇市議会の会議録(okinawa-civic-api)を検索し、地点に発言を結びつけたもの。
const council = await fetch('./data/council.json')
  .then((r) => (r.ok ? r.json() : { places: [] }))
  .catch(() => ({ places: [] }));
const councilPosts = [];
{
  const postMat = new THREE.MeshLambertMaterial({ color: 0xe8642f });
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x6b625c });
  for (const p of council.places ?? []) {
    const g = new THREE.Group();
    const y = groundAt(p.x, p.z);
    g.position.set(p.x, y, p.z);

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 6), poleMat);
    pole.position.y = 1.1; pole.castShadow = true; g.add(pole);
    // 掲示板(両面)。回転させて目立たせる
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.08), postMat);
    board.position.y = 2.5; board.castShadow = true; g.add(board);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.25, 0.05, 8, 26),
      new THREE.MeshBasicMaterial({ color: 0xe8642f, transparent: true, opacity: 0.8 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.12; g.add(ring);
    // 遠くからでも分かる細い光柱
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.5, 60, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xe8642f, transparent: true, opacity: 0.13,
        side: THREE.DoubleSide, depthWrite: false, fog: false,
      }));
    beam.position.y = 30; g.add(beam);

    const lab = makeLabel(`🏛 ${p.label}`, 8.4, 2.1);
    lab.position.y = 4.3;
    g.add(lab);

    g.userData = { place: p, board, ring, read: false };
    scene.add(g);
    councilPosts.push(g);
  }
  console.log(`市議会の言及 ${councilPosts.length}地点 / ` +
    `${(council.places ?? []).reduce((n, p) => n + p.speeches.length, 0)}発言`);
}

// 走る車両(2両)。線形を往復するので端で消えたり湧いたりしない
let train = null, trainPath = null, trainD = 0, trainDir = 1;
if (railPaths.length) {
  trainPath = railPaths.reduce((a, b) => (b.len > a.len ? b : a));
  train = new THREE.Group();
  for (const cz of [-7.2, 7.2]) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.1, 13.2),
      new THREE.MeshLambertMaterial({ color: 0xf4f2ec }));
    body.castShadow = true;
    car.add(body);
    const band = new THREE.Mesh(new THREE.BoxGeometry(2.68, 1.05, 12.4),
      new THREE.MeshLambertMaterial({ color: 0x2b3b46 }));
    band.position.y = 0.55;
    car.add(band);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.28, 12.8),
      new THREE.MeshLambertMaterial({ color: 0x2f8fc4 }));
    stripe.position.y = -0.55;
    car.add(stripe);
    car.position.z = cz;
    train.add(car);
  }
  train.position.y = -9999;                   // 初回 tick で正しい位置に移す
  scene.add(train);
  trainD = trainPath.len * 0.25;
}

// ---------------------------------------------------------------- 操作
const player = {
  x: 0, z: 0, y: 0, vy: 0, yaw: Math.PI * 0.15, pitch: 0.10, onGround: true,
};
// 校旗の周り120m で最も開けた地点(=校庭や公園)に降ろす
{
  // 開けすぎ(郊外の草地)でも狭すぎ(建物の隙間)でもない、
  // 建物から11mほど離れた地点 = 広めの道路や校庭の端を狙う
  let best = -Infinity;
  for (let r = 8; r <= 95; r += 3) {
    for (let a = 0; a < 32; a++) {
      const x = Math.cos(a / 32 * Math.PI * 2) * r, z = Math.sin(a / 32 * Math.PI * 2) * r;
      const score = -Math.abs(distToBuilding(x, z, 40) - 11) - r * 0.06;
      if (score > best) { best = score; player.x = x; player.z = z; }
    }
  }
  // 壁を向いて始まると何も見えないので、遠くまで開けている方向へ顔を向ける。
  // ただし校旗(原点)から離れた向きは割り引き、なるべく学校が視界に入るようにする。
  const toFlag = Math.atan2(-player.x, -player.z);   // 原点を指す方位
  let bestDir = toFlag, bestScore = -Infinity;
  for (let a = 0; a < 24; a++) {
    const th = a / 24 * Math.PI * 2;
    let d = 2;
    while (d < 80 && !blocked(player.x + Math.sin(th) * d, player.z + Math.cos(th) * d, 1.5)) d += 2;
    let diff = Math.abs(((th - toFlag) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    const score = d - diff * 11;
    if (score > bestScore) { bestScore = score; bestDir = th; }
  }
  // 前方は (-sin yaw, -cos yaw) なので、方位 th を向くには yaw = th + π
  player.yaw = bestDir + Math.PI;
}
player.y = groundAt(player.x, player.z) + EYE;

const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) jumpDown(); }
  keys.add(e.code);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') jumpUp();
  keys.delete(e.code);
});
addEventListener('blur', () => { keys.clear(); jumpUp(); });

// ポインタロックが使えない環境でも遊べるよう、開始状態は自前のフラグで持つ。
// ロックが取れていればマウス移動で、取れなければ左ドラッグで視点を回す。
const overlay = $('overlay');
let started = false, dragging = false;
const locked = () => document.pointerLockElement === renderer.domElement;

function start() {
  started = true;
  overlay.classList.add('hide');
  if (TOUCH) {
    // 全画面にするとURLバーが隠れて画面が広がる(非対応端末では黙って無視される)
    document.documentElement.requestFullscreen?.().catch?.(() => {});
  } else {
    try { renderer.domElement.requestPointerLock()?.catch?.(() => {}); } catch {}
  }
}
function pause() {
  started = false;
  keys.clear();
  stick = null; look = null; stickShow(false);   // 触っていた指の状態も捨てる
  overlay.classList.remove('hide');
  $('go').textContent = '再開する';
  $('meta').textContent = `シーサー ${taken} / ${seesaa.length} 体を保護ずみ`;
  if (locked()) document.exitPointerLock();
}
renderer.domElement.addEventListener('click', () => { if (!started) start(); });
$('go').addEventListener('click', start);
document.addEventListener('pointerlockchange', () => { if (!locked()) dragging = false; });
addEventListener('keydown', (e) => { if (e.code === 'Escape' && started) pause(); });
// 着信やホーム画面に戻ったときに走りっぱなしにしない
addEventListener('visibilitychange', () => { if (document.hidden && started) pause(); });

renderer.domElement.addEventListener('mousedown', () => { if (started) dragging = true; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (!started || (!locked() && !dragging)) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - e.movementY * 0.0022));
});
// 縦持ちだと垂直FOVそのままでは水平方向が極端に狭くなるので画角を広げる
function fitCamera() {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = camera.aspect < 0.85 ? 88 : 72;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', fitCamera);
addEventListener('orientationchange', () => setTimeout(fitCamera, 120));
fitCamera();

// ---------------------------------------------------------------- タッチ操作
// 画面左半分 = 移動スティック(触れた所が中心)、右半分 = 視点ドラッグ。
// 指ごとに identifier で追跡するので、移動しながら視点も回せる。
const STICK_R = 54;              // スティックの最大振れ幅(px)
let stick = null;                // {id, cx, cy, dx, dy}
let look = null;                 // {id, x, y}
let jumpTap = false;
const knob = $('knob'), stickUI = $('stick');

// ---------------------------------------------------------------- 飛行
// マイクラのクリエイティブと同じ操作感: ジャンプを長押しすると飛行に入り、
// 以降は押しっぱなしで上昇。もう一度長押しすると解除して落ちる。
let flying = false;
let jumpHeld = false, jumpSince = 0, holdUsed = false;
let descend = false;                       // 下降(PCはShift、スマホは専用ボタン)

function setFly(on) {
  flying = on;
  document.body.classList.toggle('flying', on);
  if (on) player.vy = 0;
  say(on ? '飛行モード ON（長押しで解除）' : '飛行モード OFF');
}

function jumpDown() {
  if (jumpHeld) return;
  jumpHeld = true; jumpSince = performance.now(); holdUsed = false;
  jumpTap = true;                          // 短押しはその場でジャンプ
}
function jumpUp() { jumpHeld = false; }

function stickShow(on, cx, cy) {
  if (!stickUI) return;
  stickUI.style.display = on ? 'block' : 'none';
  if (on) { stickUI.style.left = `${cx}px`; stickUI.style.top = `${cy}px`; }
  if (!on && knob) knob.style.transform = 'translate(-50%,-50%)';
}

if (TOUCH) {
  const el = renderer.domElement;
  el.addEventListener('touchstart', (e) => {
    if (!started) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.45) {
        if (stick) continue;
        stick = { id: t.identifier, cx: t.clientX, cy: t.clientY, dx: 0, dy: 0 };
        stickShow(true, t.clientX, t.clientY);
      } else if (!look) {
        look = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (!started) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (stick && t.identifier === stick.id) {
        let dx = t.clientX - stick.cx, dy = t.clientY - stick.cy;
        const m = Math.hypot(dx, dy);
        if (m > STICK_R) { dx = dx / m * STICK_R; dy = dy / m * STICK_R; }
        stick.dx = dx; stick.dy = dy;
        if (knob) knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      } else if (look && t.identifier === look.id) {
        player.yaw -= (t.clientX - look.x) * 0.0045;
        player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - (t.clientY - look.y) * 0.0045));
        look.x = t.clientX; look.y = t.clientY;
      }
    }
  }, { passive: false });

  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (stick && t.identifier === stick.id) { stick = null; stickShow(false); }
      if (look && t.identifier === look.id) look = null;
    }
  };
  el.addEventListener('touchend', endTouch);
  el.addEventListener('touchcancel', endTouch);

  $('jump')?.addEventListener('touchstart', (e) => { e.preventDefault(); jumpDown(); },
    { passive: false });
  for (const ev of ['touchend', 'touchcancel']) {
    $('jump')?.addEventListener(ev, (e) => { e.preventDefault(); jumpUp(); }, { passive: false });
  }
  // 下降ボタンは飛行中だけ出る
  $('down')?.addEventListener('touchstart', (e) => { e.preventDefault(); descend = true; },
    { passive: false });
  for (const ev of ['touchend', 'touchcancel']) {
    $('down')?.addEventListener(ev, (e) => { e.preventDefault(); descend = false; },
      { passive: false });
  }
  $('pause')?.addEventListener('touchstart', (e) => { e.preventDefault(); pause(); },
    { passive: false });
  $('pause')?.addEventListener('click', () => { if (started) pause(); });
}

// ---------------------------------------------------------------- ミニマップ
const map = $('map'), mctx = map.getContext('2d');
const MS = map.width;
const w2m = (v) => (v + HALF) / size * MS;
const base = document.createElement('canvas');
base.width = base.height = MS;
{
  const b = base.getContext('2d');
  b.fillStyle = '#16302f'; b.fillRect(0, 0, MS, MS);
  // 道路を先に敷く(街路の骨格が見えると現在地を掴みやすい)
  b.fillStyle = 'rgba(190,205,205,.30)';
  roadPath(b, w2m, w2m);
  b.fill();
  // モノレール(街の骨格として道路より目立たせる)
  b.strokeStyle = 'rgba(120,190,235,.85)';
  b.lineWidth = Math.max(2, 3 * (MS / 188));
  b.lineCap = 'round';
  for (const p of railPaths) {
    b.beginPath();
    p.pts.forEach((q, i) => (i ? b.lineTo(w2m(q.x), w2m(q.z)) : b.moveTo(w2m(q.x), w2m(q.z))));
    b.stroke();
  }
  // バス停
  b.fillStyle = 'rgba(120,200,235,.9)';
  const bs = Math.max(2, 2.2 * (MS / 188));
  for (const s of world.bus ?? []) {
    b.fillRect(w2m(s.x - HALF) - bs / 2, w2m(s.z - HALF) - bs / 2, bs, bs);
  }
  b.fillStyle = 'rgba(246,243,234,.42)';
  for (const bd of bstore) {
    b.beginPath();
    b.moveTo(w2m(bd.ring[0].x), w2m(bd.ring[0].y));
    for (let i = 1; i < bd.ring.length; i++) b.lineTo(w2m(bd.ring[i].x), w2m(bd.ring[i].y));
    b.closePath(); b.fill();
  }
}

// マーカーは 188px 表示を基準に描いていたので、実解像度に合わせて拡大する
const MK = MS / 188;

function drawMap() {
  mctx.drawImage(base, 0, 0);
  // 城東小
  mctx.fillStyle = '#e8642f';
  mctx.beginPath(); mctx.arc(w2m(0), w2m(0), 3.4 * MK, 0, 7); mctx.fill();
  // シーサー
  for (const s of seesaa) {
    if (s.userData.taken) continue;
    mctx.fillStyle = '#ffc27a';
    mctx.beginPath(); mctx.arc(w2m(s.position.x), w2m(s.position.z), 2.6 * MK, 0, 7); mctx.fill();
  }
  // 市議会の言及(未読は塗り、既読は輪郭だけ)
  for (const g of councilPosts) {
    const x = w2m(g.position.x), z = w2m(g.position.z), r = 3.2 * MK;
    mctx.beginPath(); mctx.arc(x, z, r, 0, 7);
    if (g.userData.read) {
      mctx.strokeStyle = '#e8642f'; mctx.lineWidth = 1.6 * MK; mctx.stroke();
    } else {
      mctx.fillStyle = '#e8642f'; mctx.fill();
      mctx.strokeStyle = '#f6f3ea'; mctx.lineWidth = 1.2 * MK; mctx.stroke();
    }
  }

  // 自分(視線方向つき)
  const px = w2m(player.x), pz = w2m(player.z);
  mctx.save(); mctx.translate(px, pz); mctx.rotate(-player.yaw);
  mctx.fillStyle = '#7fe0ff';
  mctx.beginPath();
  mctx.moveTo(0, -6 * MK); mctx.lineTo(4 * MK, 4 * MK); mctx.lineTo(-4 * MK, 4 * MK);
  mctx.closePath(); mctx.fill();
  mctx.restore();
}

// 地図をタップ/クリックすると拡大表示に切り替える
{
  const radar = $('radar'), cap = $('mapcap');
  const toggle = (e) => {
    e.preventDefault(); e.stopPropagation();
    const big = radar.classList.toggle('big');
    cap.textContent = big ? '城東小 周辺 1km ・ タップで戻す' : '城東小 周辺 1km ・ タップで拡大';
    drawMap();
  };
  radar.addEventListener('click', toggle);
  radar.addEventListener('touchstart', toggle, { passive: false });
}

// ---------------------------------------------------------------- コンパス
const tape = $('tape');
{
  let html = '';
  for (let d = -180; d <= 540; d += 15) {
    const lbl = { 0: '北', 90: '東', 180: '南', 270: '西' }[((d % 360) + 360) % 360];
    html += `<span style="display:inline-block;width:40px;text-align:center;opacity:${lbl ? 1 : .4}">${lbl ?? '·'}</span>`;
  }
  tape.innerHTML = html;
}

// ---------------------------------------------------------------- 議会パネル
const COUNCIL_R = 16;          // この距離まで近づくと出る(m)
let councilNear = null, councilIdx = 0, councilRead = 0;
const cvEl = $('council');

function showCouncil(g) {
  if (!g) { cvEl.classList.remove('on'); return; }
  const p = g.userData.place;
  const s = p.speeches[councilIdx % p.speeches.length];
  $('cv-place').textContent = p.label;
  $('cv-speaker').textContent = s.speaker || '(発言者不明)';
  $('cv-date').textContent = `${s.date}　${s.meeting}`;
  $('cv-quote').textContent = s.excerpt;
  const a = $('cv-link');
  a.href = s.url || '#';
  a.style.visibility = s.url ? 'visible' : 'hidden';
  $('cv-nav').textContent = p.speeches.length > 1
    ? `${councilIdx % p.speeches.length + 1} / ${p.speeches.length}　[Q]で次へ`
    : `この場所の言及 ${p.hits}件中1件`;
  cvEl.classList.add('on');
}

// 同じ地点に複数の発言があるときは Q で送る(スマホはパネルのタップ)
addEventListener('keydown', (e) => {
  if (e.code === 'KeyQ' && councilNear) { councilIdx++; showCouncil(councilNear); }
});
cvEl.addEventListener('click', (e) => {
  if (e.target.id === 'cv-link') return;   // リンクはそのまま開かせる
  if (councilNear) { councilIdx++; showCouncil(councilNear); }
});

// ---------------------------------------------------------------- HUD状態
let taken = 0, t0 = performance.now(), running = false;
const toast = $('toast');
let toastT = 0;
function say(msg) {
  toast.textContent = msg;
  toast.classList.add('on');
  toastT = performance.now() + 2100;
}

// ---------------------------------------------------------------- ループ
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();

// ---------------------------------------------------------------- 画質の自動調整
// 端末の性能は事前に分からないので、実測fpsが足りなければ段階的に軽くする。
let qLevel = 0, fpsAcc = 0, fpsN = 0, qCool = 0;
function degrade() {
  if (qLevel >= 3) return qLevel;
  qLevel++;
  if (qLevel === 1) {
    // 影の解像度を落とす(mapを捨てると次のフレームで作り直される)
    sun.shadow.mapSize.set(512, 512);
    sun.shadow.map?.dispose(); sun.shadow.map = null;
  } else if (qLevel === 2) {
    renderer.setPixelRatio(1);
  } else {
    // 影そのものを止める。シェーダを組み直す必要があるので全マテリアルに通知する
    renderer.shadowMap.enabled = false;
    scene.traverse((o) => {
      if (!o.material) return;
      for (const m of [].concat(o.material)) m.needsUpdate = true;
    });
  }
  console.log(`画質を段階${qLevel}へ`);
  return qLevel;
}

function autoQuality(dt, now) {
  if (qLevel >= 3 || now < qCool) return;
  fpsAcc += dt; fpsN++;
  if (fpsN < 90) return;                       // 1.5秒ぶんで判断
  const fps = fpsN / fpsAcc;
  fpsAcc = 0; fpsN = 0;
  if (fps >= 40) return;
  degrade();
  qCool = now + 4000;                          // 効果が出るまで様子を見る
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();
  const active = started;
  if (active && !running) { running = true; t0 = now - elapsed * 1000; }
  if (!active) running = false;
  if (active) autoQuality(dt, now);

  if (active) {
    // 入力を「前後(fb)・左右(lr)」にまとめてから向きに乗せる
    let fb = 0, lr = 0, throttle = 1, run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    if (keys.has('KeyW') || keys.has('ArrowUp')) fb += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fb -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) lr += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) lr -= 1;
    if (stick) {
      // スティックは倒した量が速度。目一杯倒すと走る
      const m = Math.min(1, Math.hypot(stick.dx, stick.dy) / STICK_R);
      if (m > 0.12) {
        fb += -stick.dy / STICK_R; lr += stick.dx / STICK_R;
        throttle = m;
        if (m > 0.86) run = true;
      }
    }

    // 進行方向。歩きは水平だけ、飛行は視線の上下にも進む
    // (見上げながら前進で上昇、見下ろせば降下。pitch は上を向くと正)
    if (flying) {
      const cp = Math.cos(player.pitch);
      fwd.set(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp);
    } else {
      fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    }
    right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    let mx = fwd.x * fb + right.x * lr;
    let mz = fwd.z * fb + right.z * lr;
    let my = flying ? fwd.y * fb : 0;   // 飛行時の垂直成分(この後 dt を掛ける)
    // 足元(地表 or 屋根)の高さ。飛行中の当たり判定にも使う
    const feet = player.y - EYE;
    const len = flying ? Math.hypot(mx, my, mz) : Math.hypot(mx, mz);
    if (len > 0) {
      const sp = (flying ? FLY : run ? RUN : WALK) * dt * throttle;
      mx = mx / len * sp; mz = mz / len * sp; my = my / len * sp;
      // 軸ごとに試して壁ずりを効かせる(天端より上なら素通りできる)
      if (!blocked(player.x + mx, player.z, RADIUS, feet)) player.x += mx;
      if (!blocked(player.x, player.z + mz, RADIUS, feet)) player.z += mz;
      player.x = Math.max(-HALF + 2, Math.min(HALF - 2, player.x));
      player.z = Math.max(-HALF + 2, Math.min(HALF - 2, player.z));
    }

    // ジャンプの長押しで飛行を切り替える(押している間に1回だけ発火)
    if (jumpHeld && !holdUsed && now - jumpSince > HOLD_MS) {
      holdUsed = true;
      setFly(!flying);
    }

    // 上下。屋根の上にも立てるので接地面は supportY で取る
    const gy = supportY(player.x, player.z) + EYE;
    if (flying) {
      const up = (jumpHeld ? 1 : 0) -
                 (descend || keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0);
      player.vy = up * FLY_V;
      // 明示的な上下(ボタン)と、視線に沿った上下(my)の両方で高度が動く
      player.y += player.vy * dt + my;
      const ceil = groundAt(player.x, player.z) + FLY_CEIL;
      if (player.y > ceil) { player.y = ceil; player.vy = 0; }
      if (player.y < gy) { player.y = gy; player.vy = 0; }   // 地面は突き抜けない
      player.onGround = false;
    } else {
      if (player.onGround && (jumpHeld || jumpTap)) {
        player.vy = JUMP; player.onGround = false;
      }
      player.vy -= GRAVITY * dt;
      player.y += player.vy * dt;
      if (player.y <= gy) { player.y = gy; player.vy = 0; player.onGround = true; }
    }
    jumpTap = false;
  }

  camera.position.set(player.x, player.y, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');

  // 太陽(影のカメラ)をプレイヤーに追従させる
  sun.target.position.set(player.x, groundAt(player.x, player.z), player.z);
  sun.position.set(player.x + 150, groundAt(player.x, player.z) + 260, player.z + 110);
  sun.target.updateMatrixWorld();

  // モノレールの車両(端に着いたら折り返す)
  if (train && trainPath) {
    trainD += trainDir * 11 * dt;             // 約40km/h
    if (trainD > trainPath.len) { trainD = trainPath.len; trainDir = -1; }
    if (trainD < 0) { trainD = 0; trainDir = 1; }
    const q = railAt(trainPath, trainD);
    train.position.set(q.x, q.y + 0.9, q.z);  // 桁をまたぐので少し上に乗せる
    train.rotation.y = q.yaw + (trainDir < 0 ? Math.PI : 0);
  }

  // 市議会の言及。近づいた地点のパネルを出す
  {
    let near = null, nd = Infinity;
    for (const g of councilPosts) {
      const d = Math.hypot(g.position.x - player.x, g.position.z - player.z);
      if (d < nd) { nd = d; near = g; }
      g.userData.ring.rotation.z += dt * 0.8;
      g.userData.board.rotation.y += dt * 0.35;
    }
    const hit = nd < COUNCIL_R ? near : null;
    if (hit !== councilNear) {
      councilNear = hit;
      councilIdx = 0;
      showCouncil(hit);
      if (hit && !hit.userData.read) {
        hit.userData.read = true;
        councilRead++;
        say(`議会の記録を見つけた（${councilRead}/${councilPosts.length}）`);
      }
    }
  }

  // バス停の名札は近くだけ(20枚が常時見えると画面が埋まる)
  for (const s of busSigns) {
    s.visible = Math.hypot(s.position.x - player.x, s.position.z - player.z) < 135;
  }

  // シーサーの回収
  let nearest = Infinity;
  for (const s of seesaa) {
    if (s.userData.taken) continue;
    const d = Math.hypot(s.position.x - player.x, s.position.z - player.z);
    if (d < nearest) nearest = d;
    s.rotation.y += dt * 0.42;                    // 台座ごとゆっくり回す
    s.userData.ring.rotation.z += dt * 1.1;
    s.userData.ring.position.y = 0.1 + Math.sin(now * 0.003 + s.position.x) * 0.25;
    if (d < PICKUP && active) {
      s.userData.taken = true;
      s.visible = false;
      taken++;
      say(taken >= seesaa.length ? '🎉 ぜんぶ保護できた！' : `シーサーを保護した（${taken}/${seesaa.length}）`);
    }
  }

  // HUD
  elapsed = running ? (now - t0) / 1000 : elapsed;
  $('found').textContent = `${taken} / ${seesaa.length}`;
  $('dist').textContent = taken >= seesaa.length ? 'ぜんぶ発見' :
    (nearest === Infinity ? '—' : `${nearest.toFixed(0)} m`);
  $('alt').textContent = `${(player.y - EYE).toFixed(1)} m`;
  const mm = (elapsed / 60) | 0, ss = (elapsed % 60) | 0;
  $('time').textContent = `${mm}:${String(ss).padStart(2, '0')}`;
  // コンパス: yaw=0 が北(-Z)。yaw増加=反時計回りなので方位は 360-yaw。
  // テープは -180°から15°=40px 刻み、窓の中央(115px)に現在方位を合わせる。
  const deg = ((player.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const heading = (360 - deg) % 360;
  tape.style.transform = `translateX(${95 - ((heading + 180) / 15) * 40}px)`;

  if (toastT && now > toastT) { toast.classList.remove('on'); toastT = 0; }
  if ((frame++ & 3) === 0) drawMap();

  renderer.render(scene, camera);
}
let elapsed = 0, frame = 0;

// 動作確認用(コンソールから位置や視点を動かせる)
window.dbg = { player, seesaa, groundAt, supportY, blocked, onRoad, rstore, scene, camera,
  world, renderer, degrade, quality: () => qLevel, setFly, railPaths, railAt,
  council, councilPosts, showCouncil,
  flyState: () => ({ flying, jumpHeld, holdUsed, held: performance.now() - jumpSince }) };

// ---------------------------------------------------------------- 起動
$('go').disabled = false;
$('go').textContent = TOUCH ? 'タップして歩きだす' : 'クリックして歩きだす';
// 出典表示は #credit に常設してあるので、ここは規模の説明だけにする
$('meta').textContent =
  `建物 ${world.buildings.length.toLocaleString()} 棟 ／ 地形 ${n}×${n} (${cell}m格子) ／ ` +
  `標高 ${world.meta.minZ}〜${world.meta.maxZ}m`;
drawMap();
tick();
