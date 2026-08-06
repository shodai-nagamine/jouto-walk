// 城東小あるき — PLATEAU那覇の実測データを歩く
// world.json: tools/build_world.py が CityGML(建物LOD1)+DEM(地形) から生成
import * as THREE from './lib/three.module.js';

const EYE = 1.62;          // 目線の高さ(m)
const WALK = 4.6, RUN = 9.4;
const GRAVITY = 22, JUMP = 7.2;
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
    bstore.push({ ring, minx, maxx, minz, maxz });
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
function blocked(x, z, r = RADIUS) {
  const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const ids = bmap.get(`${gx + i},${gz + j}`);
      if (!ids) continue;
      for (const id of ids) {
        const b = bstore[id];
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
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

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

  $('jump')?.addEventListener('touchstart', (e) => { e.preventDefault(); jumpTap = true; },
    { passive: false });
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
  b.fillStyle = 'rgba(246,243,234,.42)';
  for (const bd of bstore) {
    b.beginPath();
    b.moveTo(w2m(bd.ring[0].x), w2m(bd.ring[0].y));
    for (let i = 1; i < bd.ring.length; i++) b.lineTo(w2m(bd.ring[i].x), w2m(bd.ring[i].y));
    b.closePath(); b.fill();
  }
}

function drawMap() {
  mctx.drawImage(base, 0, 0);
  // 城東小
  mctx.fillStyle = '#e8642f';
  mctx.beginPath(); mctx.arc(w2m(0), w2m(0), 3.4, 0, 7); mctx.fill();
  // シーサー
  for (const s of seesaa) {
    if (s.userData.taken) continue;
    mctx.fillStyle = '#ffc27a';
    mctx.beginPath(); mctx.arc(w2m(s.position.x), w2m(s.position.z), 2.6, 0, 7); mctx.fill();
  }
  // 自分(視線方向つき)
  const px = w2m(player.x), pz = w2m(player.z);
  mctx.save(); mctx.translate(px, pz); mctx.rotate(-player.yaw);
  mctx.fillStyle = '#7fe0ff';
  mctx.beginPath(); mctx.moveTo(0, -6); mctx.lineTo(4, 4); mctx.lineTo(-4, 4);
  mctx.closePath(); mctx.fill();
  mctx.restore();
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

    // 進行方向(水平のみ)
    fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    let mx = fwd.x * fb + right.x * lr;
    let mz = fwd.z * fb + right.z * lr;
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      const sp = (run ? RUN : WALK) * dt * throttle;
      mx = mx / len * sp; mz = mz / len * sp;
      // 軸ごとに試して壁ずりを効かせる
      if (!blocked(player.x + mx, player.z)) player.x += mx;
      if (!blocked(player.x, player.z + mz)) player.z += mz;
      player.x = Math.max(-HALF + 2, Math.min(HALF - 2, player.x));
      player.z = Math.max(-HALF + 2, Math.min(HALF - 2, player.z));
    }

    // 上下(重力とジャンプ)
    const gy = groundAt(player.x, player.z) + EYE;
    if (player.onGround && (keys.has('Space') || jumpTap)) {
      player.vy = JUMP; player.onGround = false;
    }
    jumpTap = false;
    player.vy -= GRAVITY * dt;
    player.y += player.vy * dt;
    if (player.y <= gy) { player.y = gy; player.vy = 0; player.onGround = true; }
  }

  camera.position.set(player.x, player.y, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');

  // 太陽(影のカメラ)をプレイヤーに追従させる
  sun.target.position.set(player.x, groundAt(player.x, player.z), player.z);
  sun.position.set(player.x + 150, groundAt(player.x, player.z) + 260, player.z + 110);
  sun.target.updateMatrixWorld();

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
window.dbg = { player, seesaa, groundAt, blocked, onRoad, rstore, scene, camera, world,
  renderer, degrade, quality: () => qLevel };

// ---------------------------------------------------------------- 起動
$('go').disabled = false;
$('go').textContent = TOUCH ? 'タップして歩きだす' : 'クリックして歩きだす';
// 出典表示は #credit に常設してあるので、ここは規模の説明だけにする
$('meta').textContent =
  `建物 ${world.buildings.length.toLocaleString()} 棟 ／ 地形 ${n}×${n} (${cell}m格子) ／ ` +
  `標高 ${world.meta.minZ}〜${world.meta.maxZ}m`;
drawMap();
tick();
