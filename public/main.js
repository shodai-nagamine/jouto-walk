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
const STEP = 0.55;         // 乗り越えられる段差(m)。階段・ホームの昇降に使う

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 端末
// ?touch=1 でPCでもタッチUIを確認できる(?touch=0 で強制的に切る)
const qs = new URLSearchParams(location.search);
const TOUCH = qs.has('touch')
  ? qs.get('touch') !== '0'
  : (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
if (TOUCH) document.body.classList.add('touch');

// ---------------------------------------------------------------- タイル
// 世界は 1km 角のタイルに分かれている。タイル内の座標は 0..TILE なので
//   ワールド座標 = タイル内座標 - HALF + meta.offset
// オフセットは全タイル共通の原点から測ってあるので、タイルを足しても
// 縮尺はずれない(緯度経度→メートルの換算を原点の緯度で統一してある)。
//
// タイルごとに持つもの: 地形・道路・建物・電柱・信号・バス停・店舗看板・
//                       公園(面/木/遊具)・シーサー
// 世界に1つのもの:     モノレール線形と列車・バス経路と車両・歩行者・
//                       市議会マーカー(council.json は最初からワールド座標)
const TILE = 1000;                 // タイル1辺(m)
const HALF = TILE / 2;
const tiles = new Map();           // "tx,tz" -> タイル

/** タイルの JSON の場所。 */
function tileUrl(tx, tz) {
  // tiles/t_0_0.json は --parks 以前の生成物なので、公園を持つ world.json を
  // タイル(0,0)の中身として使う。41タイルを作り直したら差し替える。
  return (tx === 0 && tz === 0)
    ? './data/world.json' : `./data/tiles/t_${tx}_${tz}.json`;
}

/** タイルを読んで登録簿に入れる(まだ何も建てない)。 */
async function fetchTile(tx, tz) {
  const key = `${tx},${tz}`;
  if (tiles.has(key)) return tiles.get(key);
  const data = await fetch(tileUrl(tx, tz)).then((r) => {
    if (!r.ok) throw new Error(`タイル ${key} が読めません (${r.status})`);
    return r.json();
  });
  const [offX, offZ] = data.meta.offset ?? [0, 0];
  const t = {
    key, tx, tz, data, offX, offZ,
    n: data.meta.n, cell: data.meta.cell, terrain: data.terrain,
    group: new THREE.Group(),      // このタイルの描画物。破棄はここを畳めばよい
    X: (v) => v - HALF + offX,     // タイル内座標 -> ワールド座標
    Z: (v) => v - HALF + offZ,
  };
  tiles.set(key, t);
  return t;
}

/** (x,z) を含むタイル。読み込んでいなければ null。 */
function tileOf(x, z) {
  return tiles.get(`${Math.round(x / TILE)},${Math.round(z / TILE)}`) ?? null;
}

/** 読み込み済みタイルが覆う範囲 {minx,maxx,minz,maxz}。移動の制限と地図に使う。 */
function worldBounds() {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const t of tiles.values()) {
    minx = Math.min(minx, t.offX - HALF); maxx = Math.max(maxx, t.offX + HALF);
    minz = Math.min(minz, t.offZ - HALF); maxz = Math.max(maxz, t.offZ + HALF);
  }
  return { minx, maxx, minz, maxz };
}

/** 世界座標(x,z) の地表標高。そのタイルのグリッドを双一次補間する。 */
function groundAt(x, z) {
  let t = tileOf(x, z);
  if (!t) {
    // タイルの外。いちばん近いタイルの縁の値で埋める(穴を開けない)
    let bd = Infinity;
    for (const q of tiles.values()) {
      const d = Math.hypot(q.offX - x, q.offZ - z);
      if (d < bd) { bd = d; t = q; }
    }
    if (!t) return 0;
  }
  const { terrain, n, cell } = t;
  const fx = Math.min(n - 1.001, Math.max(0, (x - t.offX + HALF) / cell));
  const fz = Math.min(n - 1.001, Math.max(0, (z - t.offZ + HALF) / cell));
  const i = fx | 0, j = fz | 0, sx = fx - i, sz = fz - j;
  const a = terrain[i * n + j],       b = terrain[(i + 1) * n + j];
  const c = terrain[i * n + j + 1],   d = terrain[(i + 1) * n + j + 1];
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

// いま読むタイル。既定は1枚(=従来と同じ1km四方)。
// tiles/*.json は .gitignore してあり公開物には含まれないので、
// 複数タイルは手元で `?tiles=0,0;-1,0` のように指定して試す。
const TILE_LIST = (qs.get('tiles') || '0,0').split(';')
  .map((s) => s.split(',').map(Number))
  .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
for (const [tx, tz] of TILE_LIST) await fetchTile(tx, tz);
const tile0 = tiles.get('0,0') ?? tiles.values().next().value;
// モノレール・駅・バス経路・歩道はまだタイル(0,0)のデータを使う
// (corridor.json への切り替えは次の段)。
const world = tile0.data;
const wx = tile0.X, wz = tile0.Z;

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

// ------------------------------------------------ 当たり判定の空間ハッシュ
// 升目 "gx,gz" -> [レコードの参照]。index ではなく参照を入れるのが要点。
// index を入れると、タイルを破棄して store の途中が消えた瞬間に以降の
// index が全部ずれ、当たり判定が音もなく壊れる(誤った建物を指すだけで
// 例外は出ないので気づけない)。対象は外接矩形 minx/maxx/minz/maxz を
// 持つレコード = 道路面・建物・ホーム。

/** レコードを、その外接矩形が跨ぐ升目すべてに登録する。 */
function hashInsert(map, rec) {
  for (let gx = Math.floor(rec.minx / HASH); gx <= Math.floor(rec.maxx / HASH); gx++) {
    for (let gz = Math.floor(rec.minz / HASH); gz <= Math.floor(rec.maxz / HASH); gz++) {
      const k = `${gx},${gz}`;
      (map.get(k) ?? map.set(k, []).get(k)).push(rec);
    }
  }
}

/** pred が真になるレコードを全升目から取り除く。空になった升目は消す。 */
function hashRemove(map, pred) {
  for (const [k, a] of map) {
    const b = a.filter((r) => !pred(r));
    if (b.length === a.length) continue;
    if (b.length) map.set(k, b);
    else map.delete(k);
  }
}

// ---------------------------------------------------------------- 道路
// PLATEAU の交通モデル(tran LOD1)の道路「面」。中心線ではなく実際の路面形状で、
// 高さは持たない(一律0)ため平面として扱い、地面テクスチャに焼いて地形へ伏せる。
const rstore = [];
const rmap = new Map();

/** タイル t の道路面を当たり判定と地面テクスチャ用に登録する。 */
function addRoads(t) {
  let count = 0;
  for (const r of t.data.roads ?? []) {
    const f = r.f, m = f.length / 2;
    const ring = new Array(m);
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < m; i++) {
      const x = t.X(f[i * 2]), z = t.Z(f[i * 2 + 1]);
      ring[i] = new THREE.Vector2(x, z);
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    // tile を持たせておくと、タイル破棄のとき filter 一発で外せる
    const rec = { ring, minx, maxx, minz, maxz, tile: t.key };
    rstore.push(rec);
    hashInsert(rmap, rec);
    count++;
  }
  console.log(`[${t.key}] 道路面 ${count}`);
}

/** (x,z) が道路面の上か。シーサーの設置場所選びに使う。 */
function onRoad(x, z) {
  const hits = rmap.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`);
  if (!hits) return false;
  for (const r of hits) {
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
function groundTexture(t) {
  const W = TOUCH ? 1024 : 2048;   // 生成は素のJSループなので端末に合わせる
  const s = W / TILE;                       // px / m
  // ワールド座標 -> このタイルの canvas 画素。範囲外は canvas 側で切られる。
  const pxX = (x) => (x - t.offX + HALF) * s;
  const pxZ = (z) => (z - t.offZ + HALF) * s;
  const lot = document.createElement('canvas'); lot.width = lot.height = W;
  const lg = lot.getContext('2d', { willReadFrequently: true });
  lg.fillStyle = '#000'; lg.fillRect(0, 0, W, W);
  lg.fillStyle = lg.strokeStyle = '#fff';
  lg.lineJoin = 'round';
  lg.lineWidth = 4.5 * s;                   // 建物の外側 2.25m までを敷地とみなす
  // 隣のタイルの建物も焼く(縁で敷地色が切れないように)。範囲外は canvas が切る
  for (const b of bstore) {
    lg.beginPath();
    lg.moveTo(pxX(b.ring[0].x), pxZ(b.ring[0].y));
    for (let i = 1; i < b.ring.length; i++) {
      lg.lineTo(pxX(b.ring[i].x), pxZ(b.ring[i].y));
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
  roadPath(rg, pxX, pxZ);
  rg.fill();

  const rds = document.createElement('canvas'); rds.width = rds.height = W;
  const rsg = rds.getContext('2d', { willReadFrequently: true });
  rsg.filter = `blur(${1.8 * s}px)`;        // 1.8m ぼかし = 路肩の帯
  rsg.drawImage(rd, 0, 0);

  // 歩道・階段(OSM)。PLATEAU の tran は那覇では LOD1 のみで
  // TrafficArea を持たない = 歩道と車道の区別が無いので、ここは OSM から取る。
  const wk = document.createElement('canvas'); wk.width = wk.height = W;
  const wg = wk.getContext('2d', { willReadFrequently: true });
  wg.fillStyle = '#000'; wg.fillRect(0, 0, W, W);
  wg.lineCap = 'round'; wg.lineJoin = 'round';
  const strokeWays = (kinds, widthM, style) => {
    wg.strokeStyle = style;
    wg.lineWidth = widthM * s;
    for (const f of t.data.footways ?? []) {
      if (!kinds.includes(f.k)) continue;
      wg.beginPath();
      for (let i = 0; i < f.f.length; i += 2) {
        const x = pxX(t.X(f.f[i])), z = pxZ(t.Z(f.f[i + 1]));
        i ? wg.lineTo(x, z) : wg.moveTo(x, z);
      }
      wg.stroke();
    }
  };
  strokeWays(['sidewalk', 'path'], 2.6, '#fff');   // 歩道
  strokeWays(['steps'], 2.0, '#888');              // 階段(あとで縞にする)

  // 公園・広場・グラウンド(OSM)。地面の緑は「建物からどれだけ離れているか」で
  // 推定しているだけなので実際の公園と一致しない。ここだけは実データで塗る。
  // canvas を2枚持つと重いので、1枚の R=芝(公園・庭園・遊び場) /
  // G=土(グラウンド) に分けて入れる。縁のアンチエイリアスも混ざらない。
  const pk = document.createElement('canvas'); pk.width = pk.height = W;
  const pg = pk.getContext('2d', { willReadFrequently: true });
  pg.fillStyle = '#000'; pg.fillRect(0, 0, W, W);
  for (const p of t.data.parks ?? []) {
    pg.fillStyle = p.k === 'pitch' ? '#0f0' : '#f00';
    pg.beginPath();
    for (let i = 0; i < p.f.length; i += 2) {
      const x = pxX(t.X(p.f[i])), z = pxZ(t.Z(p.f[i + 1]));
      i ? pg.lineTo(x, z) : pg.moveTo(x, z);
    }
    pg.closePath(); pg.fill();
  }

  const A = lg.getImageData(0, 0, W, W), B = dg.getImageData(0, 0, W, W);
  const R = rg.getImageData(0, 0, W, W), RS = rsg.getImageData(0, 0, W, W);
  const WK = wg.getImageData(0, 0, W, W), PK = pg.getImageData(0, 0, W, W);
  const a = A.data, b = B.data, rr = R.data, rs = RS.data, wv = WK.data;
  const pv = PK.data;
  const PAVE = [154, 150, 142];             // 敷地(コンクリ)
  const ROAD = [110, 110, 114];             // 道路(アスファルト)
  const EDGE = [138, 134, 112];             // 路肩・未舗装
  const GREEN = [111, 147, 73];             // 緑地(建物からの距離で推定したもの)
  const PARK = [92, 137, 60];               // 公園の芝(実データ)
  const DIRT = [156, 130, 96];              // グラウンドの土(那覇の校庭は土が多い)
  // 閾値で切ると色の帯ができるので、密度に沿って連続的に混ぜる
  const mix = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t,
                            p[2] + (q[2] - p[2]) * t];
  const sstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const WALK = [176, 172, 163];             // 歩道(平板ブロック)
  const STEPS = [150, 146, 138];            // 階段
  for (let i = 0; i < a.length; i += 4) {
    const solid = a[i], dens = b[i], rc = rr[i] / 255, rsv = rs[i] / 255;
    const w = wv[i];
    let c;
    // 歩道・階段は車道より上に描く(車道の縁に沿って通っているため)
    if (w > 200) c = WALK;
    else if (w > 60) c = STEPS;
    // 実データの道路が最優先。敷地の外周(建物から2.25m)と重なる帯は実際には路面
    else if (rc > 0.5) c = ROAD;
    else if (solid > 128) c = PAVE;                       // 建物の敷地
    else {
      // 市街地なので、建物からよほど離れた所だけを緑地にする
      c = mix(GREEN, EDGE, sstep(2, 13, dens));           // 緑地 → 路肩
      // tran に入らない私道・路地は密度から弱く推定して補う
      c = mix(c, ROAD, 0.5 * sstep(15, 44, dens));
      c = mix(c, EDGE, sstep(0.04, 0.5, rsv));            // 実道路の際は路肩
      c = mix(c, ROAD, sstep(0.5, 0.95, rc));             // 縁のアンチエイリアス
      // 実データの公園が最後に来る(推定の緑より優先)。道路・歩道の下には敷かない
      const pgv = pv[i] / 255, pdv = pv[i + 1] / 255;
      if (pgv > 0.01) c = mix(c, PARK, pgv);
      if (pdv > 0.01) c = mix(c, DIRT, pdv);
    }
    const n = 0.88 + Math.random() * 0.24;                // ざらつき
    a[i] = c[0] * n; a[i + 1] = c[1] * n; a[i + 2] = c[2] * n;
  }
  lg.putImageData(A, 0, 0);

  // 横断歩道は最後に白い縞として重ねる。縞は歩行者の進む向きと平行な帯を
  // 横に並べたものなので、way に沿う線を左右にずらして引く。
  lg.lineCap = 'butt';
  lg.strokeStyle = 'rgba(238,236,228,0.82)';
  lg.lineWidth = 0.42 * s;
  for (const f of t.data.footways ?? []) {
    if (f.k !== 'crossing') continue;
    for (let i = 0; i + 3 < f.f.length; i += 2) {
      const ax = t.X(f.f[i]), az = t.Z(f.f[i + 1]);
      const bx = t.X(f.f[i + 2]), bz = t.Z(f.f[i + 3]);
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const px = dz, pz = -dx;                    // 進行方向に直交する向き
      for (let o = -2.2; o <= 2.2; o += 0.9) {    // 縞を横に並べる
        lg.beginPath();
        lg.moveTo(pxX(ax + px * o), pxZ(az + pz * o));
        lg.lineTo(pxX(bx + px * o), pxZ(bz + pz * o));
        lg.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(lot);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAXANISO;
  return tex;
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
const bmap = new Map();          // 空間ハッシュ: "gx,gz" -> [建物レコードの参照]
const bstore = [];               // 当たり判定用 {ring:[x,z,...], minx,maxx,minz,maxz}

/** タイル t の建物を1つの BufferGeometry に詰めて建てる。 */
function addBuildings(t) {
  // 壁と屋根は別マテリアルにしたいので、頂点を2群に分けてから連結する
  const WV = [], WC = [], WU = [], RV = [], RC = [], RU = [];
  const wall = new THREE.Color(), roof = new THREE.Color();
  const pushW = (x, y, z, u, v) => { WV.push(x, y, z); WC.push(wall.r, wall.g, wall.b); WU.push(u, v); };
  const pushR = (x, y, z) => { RV.push(x, y, z); RC.push(roof.r, roof.g, roof.b); RU.push(x / 8, z / 8); };

  // 駅の位置を含む建物は、この後ホーム・階段を自前で建てるので除く。
  // PLATEAU の駅舎は中身のない箱なので、残すとホームが壁の中に閉じ込められる。
  const stationPts = (t.data.stations ?? []).map((s) => [t.X(s.x), t.Z(s.z)]);
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
      const a = ring[k], c = ring[l];
      if ((a.y > z) !== (c.y > z) &&
          x < (c.x - a.x) * (z - a.y) / (c.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  let skipped = 0;

  for (const b of t.data.buildings) {
    const f = b.f, m = f.length / 2;
    const ring = new Array(m);
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < m; i++) {
      const x = t.X(f[i * 2]), z = t.Z(f[i * 2 + 1]);
      ring[i] = new THREE.Vector2(x, z);
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    // 駅を含む建物は自前のホームに置き換えるので飛ばす
    if (stationPts.some(([sx, sz]) =>
        sx >= minx - 6 && sx <= maxx + 6 && sz >= minz - 6 && sz <= maxz + 6 &&
        inRing(ring, sx, sz))) {
      skipped++;
      continue;
    }

    // 斜面で建物が浮かないよう、底は地表より少し下まで伸ばす
    const gc = groundAt((minx + maxx) / 2, (minz + maxz) / 2);
    const base = Math.min(b.b, gc) - 2.5;
    const top = b.b + b.h;

    // 沖縄のRC造をイメージした白〜生成りの外壁。棟ごとに少し振る
    const tone = (Math.sin(minx * 0.37 + minz * 0.71) * 0.5 + 0.5);
    wall.setHSL(0.09 + tone * 0.05, 0.10 + tone * 0.10, 0.56 + tone * 0.16);
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
    const rec = { ring, minx, maxx, minz, maxz, top, tile: t.key };
    bstore.push(rec);
    hashInsert(bmap, rec);
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
  t.group.add(mesh);
  console.log(`[${t.key}] 建物 ${t.data.buildings.length} 棟(駅舎 ${skipped} 棟は除外) / ` +
    `壁 ${nWall} + 屋根 ${RV.length / 3} 頂点`);
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
    for (let i = 0; i < flat.length; i += 2) raw.push([wx(flat[i]), wz(flat[i + 1])]);
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
      if (!tileOf(x, z)) continue;             // 読み込み済みタイルの上だけ
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
  const hits = bmap.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`);
  if (!hits) return h;
  for (const b of hits) {
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
      const hits = bmap.get(`${gx + i},${gz + j}`);
      if (!hits) continue;
      for (const b of hits) {
        // 天端より上、または段差ぶん(STEP)以内なら通れる。
        // 階段やホームを bstore に足すだけで昇り降りできるようにするための許容。
        if (y + STEP > b.top) continue;
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
      const hits = bmap.get(`${gx + i},${gz + j}`);
      if (!hits) continue;
      for (const b of hits) {
        const dx = Math.max(b.minx - x, 0, x - b.maxx);
        const dz = Math.max(b.minz - z, 0, z - b.maxz);
        const d = Math.hypot(dx, dz);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// 細かいノイズは全タイルで共用する(1枚を繰り返し貼るだけなので)
let detailMap = null;

/** タイル t の地形メッシュ。地面テクスチャは建物・道路の後でないと焼けない。 */
function addTerrain(t) {
  // UVは PlaneGeometry の既定(u=東 0→1, v=北で1)。groundTexture の画素配置と一致する。
  const { n, cell } = t;
  const geo = new THREE.PlaneGeometry(TILE, TILE, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2);   // 頂点順: ix が東(+X)、iz が南(+Z)
  const pos = geo.attributes.position;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) pos.setY(iz * n + ix, t.terrain[ix * n + iz]);
  }
  geo.computeVertexNormals();
  const gmat = new THREE.MeshLambertMaterial({ map: groundTexture(t) });
  // 近景がぼけないよう、地面のUVを何度も繰り返す細かいノイズを乗算する
  detailMap ??= detailTexture();
  gmat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detailMap };
    sh.fragmentShader = 'uniform sampler2D detailMap;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       diffuseColor.rgb *= texture2D(detailMap, vMapUv * ${(TILE / 3).toFixed(1)}).rgb;`
    );
  };
  const ground = new THREE.Mesh(geo, gmat);
  // 地形の頂点Yは標高そのものなので、載せるのは水平位置だけ
  ground.position.set(t.offX, 0, t.offZ);
  ground.receiveShadow = true;
  t.group.add(ground);
  console.log(`[${t.key}] 地形 ${n}×${n} (${cell}m格子)`);
}

// タイルの外側。端が崖に見えないよう、平均標高の広い受け皿を敷く(世界に1枚)
{
  const skirt = new THREE.Mesh(
    new THREE.CircleGeometry(4000, 48),
    new THREE.MeshLambertMaterial({ color: 0x7d9159 })
  );
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.y = (tile0.data.meta.minZ + tile0.data.meta.maxZ) / 2 - 6;
  scene.add(skirt);
}

// ---------------------------------------------------------------- 電柱
// 垂直の目印が無いと街の奥行きが読めないので、道路際とおぼしき所に立てる
function addPoles(t) {
  const spots = [];
  for (let x = t.offX - HALF + 25; x < t.offX + HALF - 25; x += 17) {
    for (let z = t.offZ - HALF + 25; z < t.offZ + HALF - 25; z += 17) {
      const jx = x + Math.sin(x * 0.7 + z) * 5.5;   // 機械的な等間隔を崩す
      const jz = z + Math.cos(z * 0.9 - x) * 5.5;
      const d = distToBuilding(jx, jz, 12);
      if (d > 3.2 && d < 6.8) spots.push([jx, jz]);
    }
  }
  if (!spots.length) return;
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
  t.group.add(poles);
  console.log(`[${t.key}] 電柱 ${spots.length} 本`);
}

// ---------------------------------------------------------------- シーサー
// シーサーの造形は Antigravity(agy)に契約を渡して書かせたものを検分して取り込んだ。
// 契約: 原点=足の裏 / 前方=-Z / 体高1.0〜1.2m / 基本ジオメトリのみ /
//       マテリアル使い回し / メッシュ30個以内 / userData.parts に可動部を出す。
// 光の柱と足元のリングは歩くと邪魔になる位置が変わるので、呼び出し側で足す。
function makeSeesaa() {
  const g = new THREE.Group();

  // 素焼き・赤瓦のシーサーらしい配色とドローコール削減のためのマテリアル定義
  const matBody = new THREE.MeshLambertMaterial({ color: 0xd45b38 });
  const matMane = new THREE.MeshLambertMaterial({ color: 0x5c2612 });
  const matWhite = new THREE.MeshLambertMaterial({ color: 0xfff9e6 });
  const matDark = new THREE.MeshLambertMaterial({ color: 0x1a110e });

  const add = (geo, mat, parent, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (rx || ry || rz) m.rotation.set(rx, ry, rz);
    if (sx !== 1 || sy !== 1 || sz !== 1) m.scale.set(sx, sy, sz);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // 1. 胴体
  add(new THREE.CapsuleGeometry(0.2, 0.32, 8, 12), matBody, g, 0, 0.52, 0, Math.PI / 2, 0, 0);
  add(new THREE.SphereGeometry(0.24, 10, 8), matMane, g, 0, 0.54, -0.18, 0, 0, 0, 1, 1.1, 1);

  // 2. 脚（付け根を原点にして歩行回転を容易にする）
  const makeLeg = (x, z, isFront) => {
    const leg = new THREE.Group();
    leg.position.set(x, 0.52, z);
    g.add(leg);
    add(new THREE.CylinderGeometry(0.07, 0.05, 0.32, 8), matBody, leg, 0, -0.16, 0);
    add(new THREE.BoxGeometry(0.12, 0.2, 0.16), matBody, leg, 0, -0.42, isFront ? -0.02 : 0.02);
    return leg;
  };
  const legFL = makeLeg(-0.24, -0.22, true);
  const legFR = makeLeg(0.24, -0.22, true);
  const legBL = makeLeg(-0.24, 0.22, false);
  const legBR = makeLeg(0.24, 0.22, false);

  // 3. 頭部（首付け根を原点にし、左右の見回しに対応）
  const head = new THREE.Group();
  head.position.set(0, 0.62, -0.28);
  g.add(head);

  // 頭部ベース
  add(new THREE.SphereGeometry(0.19, 12, 10), matBody, head, 0, 0.18, -0.05);

  // 大きく開けた口（上顎・下顎・口内の暗がり）
  add(new THREE.BoxGeometry(0.2, 0.08, 0.18), matBody, head, 0, 0.15, -0.19);
  add(new THREE.BoxGeometry(0.18, 0.06, 0.18), matBody, head, 0, 0.01, -0.19);
  add(new THREE.BoxGeometry(0.16, 0.08, 0.12), matDark, head, 0, 0.08, -0.17);

  // 上下の牙（暗がりを背景にして遠くからでも視認可能に）
  add(new THREE.ConeGeometry(0.02, 0.06, 6), matWhite, head, -0.05, 0.1, -0.23, Math.PI, 0, 0);
  add(new THREE.ConeGeometry(0.02, 0.06, 6), matWhite, head, 0.05, 0.1, -0.23, Math.PI, 0, 0);
  add(new THREE.ConeGeometry(0.02, 0.06, 6), matWhite, head, -0.04, 0.05, -0.23, 0, 0, 0);
  add(new THREE.ConeGeometry(0.02, 0.06, 6), matWhite, head, 0.04, 0.05, -0.23, 0, 0, 0);

  // 獅子鼻
  add(new THREE.SphereGeometry(0.055, 8, 8), matMane, head, 0, 0.19, -0.26);

  // 正面寄りの愛嬌のある目（白目・黒目）
  add(new THREE.SphereGeometry(0.045, 8, 8), matWhite, head, -0.075, 0.23, -0.19);
  add(new THREE.SphereGeometry(0.045, 8, 8), matWhite, head, 0.075, 0.23, -0.19);
  add(new THREE.SphereGeometry(0.028, 8, 8), matDark, head, -0.075, 0.235, -0.22);
  add(new THREE.SphereGeometry(0.028, 8, 8), matDark, head, 0.075, 0.235, -0.22);

  // 眉毛パーツ（顔の立体感・表情強化）
  add(new THREE.SphereGeometry(0.045, 8, 6), matMane, head, -0.08, 0.28, -0.17);
  add(new THREE.SphereGeometry(0.045, 8, 6), matMane, head, 0.08, 0.28, -0.17);

  // 耳
  add(new THREE.ConeGeometry(0.055, 0.15, 6), matMane, head, -0.16, 0.31, -0.06, -0.1, 0, 0.4);
  add(new THREE.ConeGeometry(0.055, 0.15, 6), matMane, head, 0.16, 0.31, -0.06, -0.1, 0, -0.4);

  // たてがみ（顔の正面を空け、外周のシルエットとして配置）
  const maneGeo = new THREE.SphereGeometry(0.07, 8, 6);
  add(new THREE.SphereGeometry(0.075, 8, 6), matMane, head, 0, 0.36, -0.04);
  add(maneGeo, matMane, head, -0.15, 0.33, 0);
  add(maneGeo, matMane, head, 0.15, 0.33, 0);
  add(maneGeo, matMane, head, -0.18, 0.2, 0.02);
  add(maneGeo, matMane, head, 0.18, 0.2, 0.02);

  // 4. 尻尾
  const tail = new THREE.Group();
  tail.position.set(0, 0.58, 0.3);
  g.add(tail);
  add(new THREE.CylinderGeometry(0.03, 0.02, 0.35, 6), matBody, tail, 0, 0.15, 0.1, 0.8, 0, 0);
  add(new THREE.ConeGeometry(0.09, 0.22, 8), matMane, tail, 0, 0.3, 0.22, 1.2, 0, 0);

  g.userData.parts = { legFL, legFR, legBL, legBR, head, tail };
  return g;
}

/**
 * 遠くからでも見つけられる光の柱と足元のリング。
 * 造形とは別にしてあるのは、歩くようになって「像の台座」が無くなったため。
 */
function addAura(g) {
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
}

// 街のなかの、建物に当たらない場所へ散らす(擬似乱数=毎回同じ配置)
let seed = 20260805;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const seesaa = [];

/** タイル t の道路面から、互いに離れた設置点を選ぶ(道沿いなので必ず辿り着ける)。 */
function roadSpots(t, want) {
  const cand = [];
  for (const r of rstore) {
    if (r.tile !== t.key) continue;
    let cx = 0, cz = 0;
    for (const p of r.ring) { cx += p.x; cz += p.y; }
    cx /= r.ring.length; cz /= r.ring.length;
    const d = Math.hypot(cx - t.offX, cz - t.offZ);  // タイル中心からの距離
    if (d < 50 || d > 400) continue;                 // 近すぎ・遠すぎを除く
    if (Math.abs(cx - t.offX) > HALF - 30 || Math.abs(cz - t.offZ) > HALF - 30) continue;
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

/** タイル t にシーサーを散らす。 */
function addSeesaa(t) {
  const spots = roadSpots(t, N_SEESAA);
  let n = 0;
  for (let i = 0; i < N_SEESAA; i++) {
    let placed = spots[i] ?? null;
    if (!placed) {                                   // 道路が無い区画向けの保険
      const ang = (i / N_SEESAA) * Math.PI * 2 + rnd() * 0.55;
      for (let tries = 0; tries < 260 && !placed; tries++) {
        const rad = 55 + rnd() * 330;
        const x = t.offX + Math.cos(ang + (rnd() - 0.5) * 0.5) * rad;
        const z = t.offZ + Math.sin(ang + (rnd() - 0.5) * 0.5) * rad;
        if (Math.abs(x - t.offX) > HALF - 30 || Math.abs(z - t.offZ) > HALF - 30) continue;
        if (!blocked(x, z, 2.4)) placed = [x, z];
      }
    }
    if (!placed) continue;
    const [x, z] = placed;
    const g = makeSeesaa();
    addAura(g);
    g.position.set(x, groundAt(x, z), z);
    g.rotation.y = rnd() * Math.PI * 2;
    g.userData.taken = false;
    // 歩道網に乗せ替えるのは walkLines が揃ってから(seatSeesaa)。ここは仮置き
    t.group.add(g);
    seesaa.push(g);
    n++;
  }
  console.log(`[${t.key}] シーサー ${n} 体`);
}

// ---------------------------------------------------------------- タイルを建てる
// 2段に分かれているのは、後半で使う入れ物(busSigns / shopSigns / signals など)が
// ファイルの下の方で宣言されているため。順序そのものに意味があるのは
//   道路・建物 → 地形(ここで地面テクスチャを焼く) → addSolid を使うもの
// の3点だけで、README の「addSolid は groundTexture より後」を守っている。

/** タイル t の地形と、当たり判定に関わるものを建てる(道路・建物は登録済み)。 */
function buildTileCore(t) {
  addTerrain(t);        // 地面テクスチャは道路・建物の後でないと焼けない
  addPoles(t);
  addSeesaa(t);         // 木より先に置く(幹が固体になると設置点が減るため)
  scene.add(t.group);
}

/** タイル t の付属物(当たり判定に影響しないもの)を建てる。 */
function buildTileProps(t) {
  addBusStops(t);
  addSignals(t);
  addShopSigns(t);
  const playSites = playSitesOf(t);
  addTrees(t, playSites);   // 幹は addSolid で固体にする(groundTexture の後)
  addPlayground(t, playSites);
}

// 道路・建物を全タイルぶん先に入れてから地形を焼くと、隣のタイルの建物が
// 縁の敷地色に効いて継ぎ目が目立たない。なので2周に分ける。
for (const t of tiles.values()) { addRoads(t); addBuildings(t); }
for (const t of tiles.values()) buildTileCore(t);
const BOUNDS = worldBounds();

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

// ---------------------------------------------------------------- 駅のホーム
// 当たり判定は建物と同じ仕組み(footprint+天端)に足すだけでよい。
// STEP(0.55m)以内の段差は登れるので、階段は箱を積むだけで昇れる。
let stationStop = null;

/**
 * 中心(cx,cz)・向きyawの長方形を、天端topの固体として登録する。
 * tag は当たり判定から外すときの目印(hashRemove の述語で使う)。
 */
function addSolid(cx, cz, w, d, yaw, top, tag) {
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const ring = [];
  for (const [ox, oz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    ring.push(new THREE.Vector2(cx + ox * cos + oz * sin, cz - ox * sin + oz * cos));
  }
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const p of ring) {
    if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
    if (p.y < minz) minz = p.y; if (p.y > maxz) maxz = p.y;
  }
  const rec = { ring, minx, maxx, minz, maxz, top, tile: tag };
  bstore.push(rec);
  hashInsert(bmap, rec);
}

/** 石嶺駅のホームと階段。桁の高さから床を決めるので数字は自動で合う。 */
function buildPlatform(q) {
  const g = new THREE.Group();
  const yaw = q.yaw;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  // 桁からの相対位置(ox=横, oz=線路方向)をワールド座標へ
  const at = (ox, oz) => [q.x + ox * cos + oz * sin, q.z - ox * sin + oz * cos];

  const floorY = q.y - 0.7;            // 車両の床に合わせる
  const PW = 4.2, PL = 42;             // ホームの幅と長さ
  const SIDE = 3.4;                    // 桁中心からホーム中心までの距離

  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const box = (w, h, d, ox, oy, oz, color) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    const [x, z] = at(ox, oz);
    m.position.set(x, oy, z);
    m.rotation.y = yaw;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // ホーム(床板)。厚み1mの板の上面が floorY になるように置く
  box(PW, 1.0, PL, SIDE, floorY - 0.5, 0, 0xcfcabc);
  addSolid(...at(SIDE, 0), PW, PL, yaw, floorY);
  // ホーム端の白線
  box(0.25, 0.06, PL, SIDE - PW / 2 + 0.35, floorY + 0.03, 0, 0xf1ede2);

  // 上屋と柱
  box(PW + 1.2, 0.3, PL - 4, SIDE, floorY + 3.9, 0, 0xe4e0d6);
  for (const oz of [-16, -5.5, 5.5, 16]) {
    for (const ox of [SIDE - PW / 2 + 0.4, SIDE + PW / 2 - 0.4]) {
      box(0.22, 3.9, 0.22, ox, floorY + 1.95, oz, 0xbdb9ae);
    }
  }
  // 転落防止の柵(線路と反対側)
  box(0.12, 1.1, PL, SIDE + PW / 2 - 0.06, floorY + 0.55, 0, 0x9fa6a8);

  // 階段(ホーム南端から地上へ)。1段0.45m×踏面0.62m
  const gnd = groundAt(...at(SIDE, PL / 2 + 8));
  const rise = 0.45, tread = 0.62;
  const steps = Math.max(2, Math.round((floorY - gnd) / rise));
  for (let i = 0; i < steps; i++) {
    const top = gnd + rise * (i + 1);
    const oz = PL / 2 + 0.4 + tread * (steps - 1 - i);
    box(2.6, top - gnd + 0.1, tread, SIDE, (gnd + top) / 2 - 0.05, oz, 0xc6c2b6);
    addSolid(...at(SIDE, oz), 2.6, tread, yaw, top);
  }
  // 階段の手すり
  for (const ox of [SIDE - 1.45, SIDE + 1.45]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, tread * steps + 1),
      mat(0x9fa6a8));
    const [x, z] = at(ox, PL / 2 + 0.4 + tread * steps / 2);
    m.position.set(x, (gnd + floorY) / 2 + 1.0, z);
    m.rotation.y = yaw;
    m.rotation.x = -Math.atan2(floorY - gnd, tread * steps);
    g.add(m);
  }

  scene.add(g);
  console.log(`ホーム: 床 ${floorY.toFixed(1)}m / 地上 ${gnd.toFixed(1)}m / 階段${steps}段`);
}

// 駅(ホーム＋屋根＋駅名)。線形上のいちばん近い点に合わせて向きを決める
for (const st of world.stations ?? []) {
  const sx = wx(st.x), sz = wz(st.z);
  let best = null;
  for (const p of railPaths) {
    for (let d = 0; d <= p.len; d += 4) {
      const q = railAt(p, d);
      const dist = Math.hypot(q.x - sx, q.z - sz);
      if (!best || dist < best.dist) best = { dist, q, d, p };
    }
  }
  if (!best || best.dist > 90) continue;
  const { q } = best;
  stationStop = { q, d: best.d, p: best.p };
  buildPlatform(q);
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
function addBusStops(t) {
  const stops = t.data.bus ?? [];
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
      const x = t.X(s.x), z = t.Z(s.z);
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
      t.group.add(sp);
      busSigns.push(sp);
    });
    poles.instanceMatrix.needsUpdate = true;
    bases.instanceMatrix.needsUpdate = true;
    poles.castShadow = bases.castShadow = true;
    t.group.add(poles, bases);
    console.log(`[${t.key}] バス停 ${stops.length}基`);
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

// ---------------------------------------------------------------- 遊具の位置
// 先に決めておく。木より後に決めると、木の生えた真上に滑り台が出てしまう。
// OSM の leisure=playground だけを見ると那覇ではほぼ空になる(街区公園は
// leisure=park で登録され playground が付かない)ので、児童公園サイズの
// park も対象にする。広すぎる公園の真ん中に遊具1組だけ置いても嘘になるので
// 上限を切る。
function playSitesOf(t) {
  const out = [];
  for (const p of t.data.parks ?? []) {
    if (p.k !== 'playground' && p.k !== 'park') continue;
    let cx = 0, cz = 0, a2 = 0;
    const m = p.f.length / 2;
    const pts = [];
    for (let i = 0; i < p.f.length; i += 2) {
      const x = t.X(p.f[i]), z = t.Z(p.f[i + 1]);
      pts.push([x, z]); cx += x; cz += z;
    }
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i], [nx, nz] = pts[(i + 1) % pts.length];
      a2 += x * nz - nx * z;
    }
    const area = Math.abs(a2) / 2;
    cx /= m; cz /= m;
    if (p.k === 'park' && (area < 260 || area > 2600)) continue;
    if (Math.abs(cx - t.offX) > HALF - 6 || Math.abs(cz - t.offZ) > HALF - 6) continue;
    if (blocked(cx, cz, 3.0)) continue;          // 建物に埋まる場所は避ける
    out.push([cx, cz]);
  }
  return out;
}

// ---------------------------------------------------------------- 公園の木
// 公園・庭園の面の中に木を散らす。1本ずつ Mesh にすると数百ドローコールに
// なるので、幹と樹冠をそれぞれ InstancedMesh 1つに畳む(計2回)。
// グラウンド(pitch)には生やさない。競技面に木が立つと嘘になる。
// 幹だけ addSolid で固体にする(樹冠まで固くすると枝の下を歩けない)。
// 地面テクスチャは既に焼き終わっているので、ここで足しても敷地色にはならない。
function addTrees(t, playSites) {
  const spots = [];
  for (const p of t.data.parks ?? []) {
    if (p.k === 'pitch') continue;
    const pts = [];
    for (let i = 0; i < p.f.length; i += 2) pts.push([t.X(p.f[i]), t.Z(p.f[i + 1])]);
    if (pts.length < 3) continue;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity, a2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i], [nx, nz] = pts[(i + 1) % pts.length];
      a2 += x * nz - nx * z;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    const inside = (x, z) => {
      let s = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[j];
        if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) s = !s;
      }
      return s;
    };
    // 90m2 に1本。小さな児童公園でも木が無いと寂しいので最低1本は試す
    const want = Math.max(1, Math.min(40, Math.round(Math.abs(a2) / 2 / 90)));
    for (let k = 0, guard = 0; k < want && guard < want * 40; guard++) {
      const x = minx + Math.random() * (maxx - minx);
      const z = minz + Math.random() * (maxz - minz);
      if (Math.abs(x - t.offX) > HALF - 5 || Math.abs(z - t.offZ) > HALF - 5) continue;
      if (!inside(x, z)) continue;
      if (blocked(x, z, 2.2)) continue;          // 建物際は避ける
      if (onRoad(x, z)) continue;                // 園内の車路も避ける
      if (playSites.some(([px, pz]) => Math.hypot(px - x, pz - z) < 5.5)) continue;
      spots.push([x, z]);
      k++;
    }
  }

  if (spots.length) {
    const trunkG = new THREE.CylinderGeometry(0.15, 0.23, 1, 5);
    trunkG.translate(0, 0.5, 0);                 // 原点を根元に(Yスケール=幹の高さ)
    const trunks = new THREE.InstancedMesh(
      trunkG, new THREE.MeshLambertMaterial({ color: 0x6d573d }), spots.length);
    const leaves = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), spots.length);
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pv3 = new THREE.Vector3(), sv3 = new THREE.Vector3();
    const col = new THREE.Color();
    spots.forEach(([x, z], i) => {
      const y = groundAt(x, z);
      const h = 3.2 + Math.random() * 3.0;
      const r = 1.4 + Math.random() * 1.2;
      qt.setFromAxisAngle(up, Math.random() * Math.PI * 2);
      m4.compose(pv3.set(x, y, z), qt, sv3.set(1, h, 1));
      trunks.setMatrixAt(i, m4);
      m4.compose(pv3.set(x, y + h + r * 0.4, z), qt, sv3.set(r, r * 0.85, r));
      leaves.setMatrixAt(i, m4);
      // 亜熱帯の照葉樹。濃い緑から明るい黄緑まで振って単調さを消す
      col.setHSL(0.25 + Math.random() * 0.06, 0.30 + Math.random() * 0.20,
                 0.24 + Math.random() * 0.13);
      leaves.setColorAt(i, col);
      addSolid(x, z, 0.55, 0.55, 0, y + h);      // 幹だけ固体にする
    });
    trunks.castShadow = leaves.castShadow = leaves.receiveShadow = true;
    t.group.add(trunks); t.group.add(leaves);
    console.log(`[${t.key}] 公園の木 ${spots.length} 本`);
  }
}

// ---------------------------------------------------------------- 遊具
// 滑り台とブランコを1組ずつ置く。数が少ないので InstancedMesh にはしない。
// 当たり判定には入れない(すり抜けても実害が無く、細い支柱を固体にすると
// 園内で引っかかって歩きにくくなるため)。
function addPlayground(t, playSites) {
  const mk = (w, h, d, color) => new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  let n = 0;
  for (const [cx, cz] of playSites) {
    const g = new THREE.Group();
    g.position.set(cx, groundAt(cx, cz), cz);
    g.rotation.y = Math.random() * Math.PI * 2;

    // 滑り台: 踊り場・斜面・脚
    const deck = mk(1.1, 0.14, 1.1, 0xd8b13a); deck.position.set(-1.5, 1.45, 0);
    const ramp = mk(0.12, 3.0, 0.95, 0xe8642f);
    ramp.position.set(-0.1, 0.78, 0); ramp.rotation.z = Math.PI / 2 - 0.58;
    g.add(deck, ramp);
    for (const ox of [-0.45, 0.45]) for (const oz of [-0.45, 0.45]) {
      const leg = mk(0.09, 1.45, 0.09, 0x9aa3a6);
      leg.position.set(-1.5 + ox, 0.72, oz); g.add(leg);
    }
    // ブランコ: 門型の枠と座面2つ
    const bar = mk(2.4, 0.1, 0.1, 0x4fb477); bar.position.set(2.4, 2.2, 0); g.add(bar);
    for (const ox of [-1.1, 1.1]) for (const oz of [-0.7, 0.7]) {
      const leg = mk(0.09, 2.2, 0.09, 0x4fb477);
      leg.position.set(2.4 + ox, 1.1, oz); g.add(leg);
    }
    for (const ox of [-0.55, 0.55]) {
      const seat = mk(0.5, 0.07, 0.22, 0x2f8fc4);
      seat.position.set(2.4 + ox, 0.95, 0); g.add(seat);
      for (const oz of [-0.09, 0.09]) {
        const rope = mk(0.04, 1.25, 0.04, 0xbdb8ac);
        rope.position.set(2.4 + ox, 1.58, oz); g.add(rope);
      }
    }
    for (const o of g.children) o.castShadow = true;
    t.group.add(g); n++;
  }
  if (n) console.log(`[${t.key}] 遊具 ${n}組`);
}

// ---------------------------------------------------------------- 店舗の看板
// OSM の名前付き地物から店舗系だけを拾って、建物の前に小さな看板を出す。
// 数が増えても重くならないよう、表示は SHOP_R 以内に限る(距離バジェット)。
const SHOP_R = 62;
const SHOP_CATS = [
  ['食', 0xe8642f, ['restaurant', 'fast_food', 'cafe', 'pub', 'bar', 'confectionery',
                    'pastry', 'bakery', 'ice_cream', 'greengrocer', 'butcher']],
  ['買', 0x2f8fc4, ['supermarket', 'convenience', 'alcohol', 'clothes', 'shoes',
                    'books', 'florist', 'hardware', 'furniture', 'variety_store',
                    'department_store', 'mobile_phone', 'electronics', 'optician']],
  ['医', 0x4fb477, ['pharmacy', 'doctors', 'dentist', 'clinic', 'hospital',
                    'veterinary', 'chemist', 'rehabilitation', 'physiotherapist']],
  ['金', 0xb98cd4, ['bank', 'post_office', 'atm', 'insurance']],
  ['学', 0xd8b13a, ['prep_school', 'school', 'music_school', 'driving_school',
                    'language_school']],
  ['公', 0x5f9e57, ['park', 'garden', 'playground', 'pitch', 'sports_centre',
                    'fitness_centre', 'stadium', 'swimming_pool', 'dance',
                    'nature_reserve']],
  ['他', 0x9aa3a6, []],
];
const shopSigns = [];

/** 点が多角形リングの内側か。あちこちで書いていたので1つにまとめる。 */
function pointInRing(ring, x, z) {
  let inside = false;
  for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
    const a = ring[k], c = ring[l];
    if ((a.y > z) !== (c.y > z) &&
        x < (c.x - a.x) * (z - a.y) / (c.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** (x,z) の周りの建物レコード。ホームや木の幹(tile を持たない)は除く。 */
function nearbyBuildings(x, z, r) {
  const out = new Set();
  const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
  const n = Math.ceil(r / HASH);
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      for (const b of bmap.get(`${gx + i},${gz + j}`) ?? []) {
        if (b.tile && b.tile !== SOLID_SHOP) out.add(b);
      }
    }
  }
  return [...out];
}

/**
 * 店が入っている建物を探し、街に面した外壁に入口の位置を決める。
 *
 * OSM の地物は建物の重心あたりに落ちるので、48件中41件は建物の輪郭の内側にある。
 * そのまま看板を出すと supportY() が屋根の天端を返し、40件が屋根の上に浮いた
 * (実測)。街の側から入口が見えないので、外壁のどの辺が街に開いているかを
 * 自分で決めて、そこに扉を付ける。PLATEAU の LOD1 に開口は無いので自前で足すしかない。
 *
 * @returns {{x,z,yaw,gy,host:boolean}} 扉の位置・向き・足元の高さ
 */
function findDoor(x, z) {
  const cands = nearbyBuildings(x, z, 26);
  let host = null, hostD = Infinity;
  for (const b of cands) {
    if (pointInRing(b.ring, x, z)) { host = b; hostD = 0; break; }
    const dx = Math.max(b.minx - x, 0, x - b.maxx);
    const dz = Math.max(b.minz - z, 0, z - b.maxz);
    const d = Math.hypot(dx, dz);
    if (d < hostD && d < 12) { hostD = d; host = b; }
  }
  // 建物が見つからない(屋外の施設など)ときは、その場を入口にする
  if (!host) return { x, z, yaw: 0, gy: groundAt(x, z), host: false, scale: 1 };

  const ring = host.ring, m = ring.length;
  let best = null;
  for (let i = 0; i < m; i++) {
    const a = ring[i], c = ring[(i + 1) % m];
    const ex = c.x - a.x, ez = c.y - a.y;
    const L = Math.hypot(ex, ez);
    if (L < 2.0) continue;                       // 扉が入らない短い辺は使わない
    const nx = ez / L, nz = -ex / L;             // 辺の法線。外向きがどちらかは試して決める
    for (const u of [0.35, 0.5, 0.65]) {
      const ax = a.x + ex * u, az = a.y + ez * u;
      for (const s of [1, -1]) {
        const ox = nx * s, oz = nz * s;
        const px = ax + ox * 1.4, pz = az + oz * 1.4;   // 扉の前に立つ場所
        if (pointInRing(ring, px, pz)) continue;        // 内側を向いていた
        const gy = groundAt(px, pz);
        if (blocked(px, pz, 0.6, gy)) continue;         // 隣の建物に埋まる
        // 街に開いているほど良い。道路に面していれば最優先
        const score = (onRoad(px, pz) ? 40 : 0) + distToBuilding(px, pz, 14) * 2 + L * 0.25;
        if (!best || score > best.score) {
          const dy = groundAt(ax + ox * 0.3, az + oz * 0.3);
          best = { score, x: ax + ox * 0.3, z: az + oz * 0.3,
                   yaw: Math.atan2(ox, oz), gy: dy, host: true,
                   // 平屋より低い建物では扉が屋根を突き抜けるので縮める
                   scale: Math.min(1, Math.max(0.55, (host.top - dy) / 3.2)) };
        }
      }
    }
  }
  // どの辺も塞がっていたら諦めて地物の位置に置く(地表の高さにはする)
  return best ?? { x, z, yaw: 0, gy: groundAt(x, z), host: false, scale: 1 };
}

function addShopSigns(t) {
  const skip = new Set(['school', 'library', 'community_centre', 'townhall',
    'fire_station', 'parking', 'bicycle_rental', 'shelter', 'bench', 'toilets',
    'waste_basket', 'vending_machine', 'post_box', 'drinking_water',
    'kindergarten', 'social_facility', 'place_of_worship', 'train_station']);
  const catOf = (v) => SHOP_CATS.find((c) => c[2].includes(v)) ?? SHOP_CATS.at(-1);

  // まず対象を集めて入口を決める。扉は InstancedMesh に畳むので数が先に要る
  const list = [];
  for (const l of t.data.landmarks ?? []) {
    const [key, val] = (l.kind || '').split('=');
    if (!['shop', 'amenity', 'office', 'craft', 'healthcare',
          'leisure'].includes(key)) continue;
    if (skip.has(val)) continue;
    const [mark, color] = catOf(val);
    const x = t.X(l.x), z = t.Z(l.z);
    list.push({ l, mark, color, val, x, z, door: findDoor(x, z) });
  }
  if (!list.length) { console.log(`[${t.key}] 店舗 0件`); return; }

  // 扉一式。1軒につき Mesh を並べると 48軒で 300 近いドローコールになるので、
  // 部品ごとに1つの InstancedMesh へ畳む(この街の他の反復物と同じやり方)。
  const piece = (geo, mat) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.castShadow = im.receiveShadow = true;
    return im;
  };
  const gStep = new THREE.BoxGeometry(1.9, 0.1, 0.8); gStep.translate(0, 0.05, 0.4);
  const gFrame = new THREE.BoxGeometry(1.7, 2.45, 0.14); gFrame.translate(0, 1.22, 0.03);
  const gPanel = new THREE.BoxGeometry(1.34, 2.05, 0.07); gPanel.translate(0, 1.04, 0.1);
  const gBar = new THREE.BoxGeometry(0.07, 0.62, 0.07); gBar.translate(0.46, 1.06, 0.16);
  const gAwn = new THREE.BoxGeometry(2.3, 0.13, 0.95); gAwn.translate(0, 2.66, 0.48);
  const steps = piece(gStep, new THREE.MeshLambertMaterial({ color: 0xb3aa9a }));
  const frames = piece(gFrame, new THREE.MeshLambertMaterial({ color: 0x6f6a60 }));
  const panels = piece(gPanel, new THREE.MeshLambertMaterial({ color: 0x5d7a86 }));
  const bars = piece(gBar, new THREE.MeshLambertMaterial({ color: 0xd8d3c6 }));
  const awns = piece(gAwn, new THREE.MeshLambertMaterial({ color: 0xffffff }));
  awns.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(list.length * 3), 3);

  const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0), pv = new THREE.Vector3();
  const sv = new THREE.Vector3(), col = new THREE.Color();

  let n = 0;
  for (const s of list) {
    const { l, mark, color, door } = s;
    // 扉は地表に立てる。yaw は外向き(+Z が街を向く)
    qt.setFromAxisAngle(up, door.yaw);
    m4.compose(pv.set(door.x, door.gy, door.z), qt,
               sv.set(door.scale, door.scale, door.scale));
    for (const im of [steps, frames, panels, bars, awns]) im.setMatrixAt(n, m4);
    awns.setColorAt(n, col.setHex(color));      // 庇を分類の色にする

    const cv = document.createElement('canvas');
    cv.width = 384; cv.height = 96;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(13,27,30,0.9)';
    c.beginPath(); c.roundRect(2, 8, 380, 80, 10); c.fill();
    // 分類の色帯
    c.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    c.beginPath(); c.roundRect(2, 8, 62, 80, 10); c.fill();
    c.fillStyle = '#160c06';
    c.font = 'bold 40px "Hiragino Sans", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(mark, 33, 49);
    c.fillStyle = '#f6f3ea';
    const nm = l.name.length > 11 ? l.name.slice(0, 10) + '…' : l.name;
    c.font = `bold ${nm.length > 8 ? 26 : 31}px "Hiragino Sans", sans-serif`;
    c.textAlign = 'left';
    c.fillText(nm, 78, l.oh ? 40 : 49);
    if (l.oh) {
      c.fillStyle = 'rgba(246,243,234,0.62)';
      c.font = '19px "Hiragino Sans", sans-serif';
      c.fillText(l.oh.length > 22 ? l.oh.slice(0, 21) + '…' : l.oh, 78, 68);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false,
    }));
    sp.scale.set(4.3, 1.08, 1);
    // 看板は入口の庇の上。地物の座標(建物の重心あたり)に出すと屋根に載る
    sp.position.set(door.x, door.gy + 3.28 * door.scale, door.z);
    sp.visible = false;
    // 中に入れるようにするので、店の素性と入口を看板に持たせておく
    sp.userData = { name: l.name, mark, color, kind: s.val, oh: l.oh || '',
                    x: s.x, z: s.z, door };
    t.group.add(sp);
    shopSigns.push(sp);
    n++;
  }
  for (const im of [steps, frames, panels, bars, awns]) {
    im.instanceMatrix.needsUpdate = true;
    t.group.add(im);
  }
  awns.instanceColor.needsUpdate = true;
  const attached = list.filter((s) => s.door.host).length;
  console.log(`[${t.key}] 店舗 ${n}件(うち建物の外壁に入口 ${attached}件)`);
}

// ---------------------------------------------------------------- 店の中
// PLATEAU の建物は LOD1(足元の輪郭を高さぶん押し出しただけの箱)で、床も内部も
// 1階の店舗区画も持たない。実測データから店内を起こすことは原理的にできないので、
// 外は本物・中は作り物と割り切って、分類ごとの部屋を手続き的に建てる。
//
// 部屋は街から遠く離した「舞台」に建てて、そこへ移動する。街の真上に建てないのは
// supportY が「footprint に入っていれば天端に立たせる」仕組みなので、上空に床を
// 置くと、その真下の路上まで床の高さに持ち上がってしまうため(実際に踏んだ)。
const STAGE = { x: 8000, z: 8000, y: 400 };   // タイルの外。当たり判定が街と混ざらない
const ROOM = { w: 8.4, d: 6.4, h: 3.0 };      // 間口・奥行き・天井高(m)
const ENTER_R = 6.0;                          // 看板にこの距離まで近づくと入れる(m)
const SOLID_SHOP = 'shop';                    // 店内の固体につける目印

let shopRoom = null;          // 建っている部屋 { group, sign }

/**
 * 壁に掛ける板。makeLabel(スプライト)と違って奥行きを見るので、
 * 什器の後ろに回れば隠れる。店内では手前に抜けないことのほうが大事。
 */
function makePlate(text, w, h, bg = '#0d1b1e', fg = '#f6f3ea') {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = bg; c.fillRect(0, 0, 512, 128);
  c.fillStyle = fg;
  c.font = 'bold 62px "Hiragino Sans", sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 256, 66, 480);            // はみ出す長い名前は詰めて収める
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
}

/** 店内を建てる。看板のスプライト sp が持つ素性から中身を決める。 */
function buildRoom(sp) {
  const g = new THREE.Group();
  const { w, d, h } = ROOM;
  const P = sp.userData;
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

  // 舞台の中心を原点として置く。ox は右(+X)、oz は奥(-Z)が正
  const box = (bw, bh, bd, ox, oy, oz, color) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat(color));
    m.position.set(STAGE.x + ox, STAGE.y + oy, STAGE.z + oz);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };

  const FLOOR = 0xb8ae9c, WALL = 0xe6e1d5, CEIL = 0xf2eee4;
  const WOOD = 0x9a7550, METAL = 0xa8adb0;
  const accent = P.color;

  // 床・天井・4枚の壁。密閉した箱にする(外は見えないので背景を気にしなくてよい)
  box(w, 0.2, d, 0, -0.1, 0, FLOOR);
  box(w, 0.12, d, 0, h + 0.06, 0, CEIL);
  box(w, h, 0.2, 0, h / 2, -d / 2, WALL);          // 奥
  box(w, h, 0.2, 0, h / 2, d / 2, WALL);           // 手前(入口側)
  box(0.2, h, d, -w / 2, h / 2, 0, WALL);          // 左
  box(0.2, h, d, w / 2, h / 2, 0, WALL);           // 右
  // 当たり判定。床は天端=舞台の高さ、壁は天井まで(段差許容で越えられない高さ)
  addSolid(STAGE.x, STAGE.z, w, d, 0, STAGE.y, SOLID_SHOP);
  for (const [cx, cz, sw, sd] of [
    [0, -d / 2, w, 0.2], [0, d / 2, w, 0.2],
    [-w / 2, 0, 0.2, d], [w / 2, 0, 0.2, d],
  ]) addSolid(STAGE.x + cx, STAGE.z + cz, sw, sd, 0, STAGE.y + h, SOLID_SHOP);

  // 入口(手前の壁)。開かないので見た目だけ。出口の案内を添える
  box(1.5, 2.1, 0.06, 0, 1.05, d / 2 - 0.14, 0x6f7d84);
  box(0.09, 0.09, 0.06, 0.55, 1.05, d / 2 - 0.2, METAL);
  const exit = makePlate('でぐち', 1.3, 0.34);
  exit.position.set(STAGE.x, STAGE.y + 2.42, STAGE.z + d / 2 - 0.13);
  exit.rotation.y = Math.PI;                 // 手前の壁は室内側が -Z を向く
  g.add(exit);

  // 店名(奥の壁に掛ける)
  const nameTag = makePlate(`${P.mark}　${P.name}`, 3.4, 0.85);
  nameTag.position.set(STAGE.x, STAGE.y + 2.42, STAGE.z - d / 2 + 0.12);
  g.add(nameTag);

  // 照明。密閉した箱なので太陽は届かない。天井の面光源に見えるよう板と点光源を置く
  const panel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xfff6e0 }));
  panel.position.set(STAGE.x, STAGE.y + h - 0.12, STAGE.z - 0.6);
  g.add(panel);
  const lamp = new THREE.PointLight(0xffe9c4, 16, 16, 2);
  lamp.position.set(STAGE.x, STAGE.y + h - 0.35, STAGE.z - 0.4);
  g.add(lamp);
  const fill = new THREE.PointLight(0xdfe8ee, 7, 14, 2);
  fill.position.set(STAGE.x, STAGE.y + h - 0.5, STAGE.z + d / 2 - 1.2);
  g.add(fill);

  // ---- 分類ごとの什器 -------------------------------------------------
  // 大きいものだけ固体にする。細い脚や椅子まで固くすると 8.4×6.4m の部屋で
  // 引っかかって歩けなくなる(屋外の遊具を当たり判定に入れていないのと同じ理由)。
  // 天端が STEP(0.55m)以内のもの(長椅子など)は、登録しても跨げるので入れない。
  const solid = (w2, d2, ox, oz, topH) =>
    addSolid(STAGE.x + ox, STAGE.z + oz, w2, d2, 0, STAGE.y + topH, SOLID_SHOP);
  // 商品棚。壁と同系色だと白く飛んで一枚の板に見えるので、本体は暗めにして
  // 段を切り、商品を段ごとに並べる(のっぺりした塊に見えないように)
  const shelf = (ox, oz, len) => {
    const dep = 0.55;
    box(len, 1.45, 0.07, ox, 0.72, oz - dep / 2 + 0.035, 0x8f887a);   // 背板
    for (const sx of [-len / 2 + 0.04, len / 2 - 0.04]) {
      box(0.08, 1.45, dep, ox + sx, 0.72, oz, 0x8f887a);              // 側板
    }
    box(len, 0.06, dep, ox, 1.45, oz, 0x6d675c);                      // 天板
    for (const oy of [0.42, 0.87, 1.32]) {
      box(len, 0.05, dep, ox, oy, oz, 0x6d675c);                      // 棚板
      const cols = Math.max(2, Math.round(len / 0.42));
      for (let i = 0; i < cols; i++) {
        const c = new THREE.Color().setHSL(((i * 0.19) + oy) % 1, 0.5, 0.42);
        box(0.3, 0.3, 0.32, ox - len / 2 + 0.3 + i * (len - 0.6) / (cols - 1),
            oy + 0.18, oz, c.getHex());
      }
    }
    solid(len, dep, ox, oz, 1.45);
  };
  const counter = (ox, oz, len, dep = 0.7) => {
    box(len, 1.05, dep, ox, 0.52, oz, WOOD);
    box(len + 0.1, 0.06, dep + 0.1, ox, 1.08, oz, 0x6f5a41);
    solid(len, dep, ox, oz, 1.08);
  };
  const chair = (ox, oz) => {
    box(0.42, 0.08, 0.42, ox, 0.45, oz, WOOD);
    box(0.42, 0.5, 0.07, ox, 0.72, oz - 0.18, WOOD);
    for (const sx of [-0.16, 0.16]) for (const sz of [-0.16, 0.16]) {
      box(0.05, 0.45, 0.05, ox + sx, 0.22, oz + sz, METAL);
    }
  };
  const bench = (ox, oz, len) => {
    box(len, 0.08, 0.42, ox, 0.44, oz, WOOD);
    box(len, 0.42, 0.07, ox, 0.68, oz - 0.18, WOOD);
    for (const sx of [-len / 2 + 0.2, len / 2 - 0.2]) {
      box(0.07, 0.42, 0.38, ox + sx, 0.21, oz, METAL);
    }
  };

  // 入口(oz = +2.1)に立って店の奥を向くので、oz > 1.2 の帯は空けておく。
  // ここを埋めると、入った瞬間に什器の中に立つことになる(実際にそうなった)。
  if (P.mark === '食') {
    for (const [tx, tz] of [[-2.4, -1.9], [-2.4, 0.3], [0.4, -1.9], [0.4, 0.3]]) {
      box(1.0, 0.07, 0.9, tx, 0.74, tz, WOOD);          // 天板
      box(0.1, 0.72, 0.1, tx, 0.36, tz, METAL);         // 脚
      box(0.55, 0.05, 0.55, tx, 0.03, tz, METAL);
      chair(tx, tz + 0.72); chair(tx, tz - 0.72);
      solid(1.0, 0.9, tx, tz, 0.78);            // 椅子は跨げるので卓だけ
    }
    counter(3.0, -1.0, 3.4, 0.75);                      // 厨房カウンター
    box(0.9, 1.5, 0.55, 3.3, 0.75, -2.5, METAL);        // 冷蔵庫
    solid(0.9, 0.55, 3.3, -2.5, 1.5);
    box(1.8, 0.44, 0.12, 1.6, 1.62, -2.98, accent);     // 品書き
  } else if (P.mark === '買') {
    // 全幅の棚を2列並べると、間も両端も半径 0.55m のプレイヤーが通れず、
    // 手前半分しか歩けなくなる(実測で到達奥行き 2.7m。他の分類は 5.4m)。
    // 奥は全幅1列にして、もう1列は左半分だけにし、右から奥へ回れるようにする
    shelf(-0.5, -2.5, 5.6);                             // 奥の棚
    shelf(-2.2, -0.9, 2.2);                             // 左の棚
    counter(2.6, 0.9, 2.2);                             // レジ(右手前)
    box(0.42, 0.3, 0.34, 2.9, 1.25, 0.9, 0x2f3338);     // レジ機
  } else if (P.mark === '医') {
    counter(0, -2.2, 4.4, 0.8);                         // 受付
    box(1.4, 0.5, 0.12, 0, 1.7, -2.98, accent);         // 受付表示
    bench(-2.6, 0.8, 2.8);
    bench(2.6, 0.8, 2.8);
    box(0.08, 1.7, 2.2, 2.7, 0.85, -0.9, 0xdfe7ea);     // 間仕切り
    solid(0.2, 2.2, 2.7, -0.9, 1.7);
    box(0.5, 0.9, 0.4, -3.5, 0.45, -1.2, 0xd8d3c6);     // 観葉鉢
  } else if (P.mark === '金') {
    counter(0, -2.2, 5.2, 0.8);
    for (const ox of [-1.7, 0, 1.7]) {                  // 窓口の仕切り
      box(0.06, 0.9, 0.75, ox, 1.55, -2.2, 0xdfe7ea);
    }
    for (const ox of [-3.2, -1.9]) {                    // ATM
      box(0.85, 1.9, 0.7, ox, 0.95, 0.6, 0xcdd3d6);
      box(0.5, 0.35, 0.06, ox, 1.45, 0.22, 0x22303a);
      box(0.6, 0.12, 0.06, ox, 1.02, 0.22, accent);
      solid(0.85, 0.7, ox, 0.6, 1.9);
    }
    box(2.0, 0.45, 0.75, 2.6, 0.4, 0.4, 0x59636b);      // 長椅子
    box(2.0, 0.5, 0.12, 2.6, 0.85, 0.7, 0x59636b);
  } else if (P.mark === '学') {
    for (const row of [0, 1]) for (const col of [-1, 0, 1]) {
      const tx = col * 1.7, tz = -1.5 + row * 1.5;
      box(1.15, 0.06, 0.55, tx, 0.72, tz, WOOD);
      for (const sx of [-0.5, 0.5]) box(0.06, 0.7, 0.06, tx + sx, 0.35, tz, METAL);
      chair(tx, tz + 0.6);
      solid(1.15, 0.55, tx, tz, 0.75);
    }
    // 白板は店名の板(oy 2.42)に掛からない高さに収める
    box(4.6, 1.3, 0.08, 0, 1.32, -d / 2 + 0.2, 0xf6f5ef);
    box(4.6, 0.1, 0.16, 0, 0.64, -d / 2 + 0.26, WOOD);
    box(0.95, 0.06, 0.9, 3.3, 0.9, -2.2, WOOD);             // 教卓
    for (const sx of [-0.4, 0.4]) box(0.07, 0.87, 0.07, 3.3 + sx, 0.44, -2.2, METAL);
    solid(0.95, 0.9, 3.3, -2.2, 0.93);
  } else if (P.mark === '公') {
    // 公園・運動施設は「管理棟」に見立てる(屋外そのものには入れない)
    counter(0, -2.2, 3.0, 0.75);
    bench(-2.8, 0.4, 2.4);
    bench(2.8, 0.4, 2.4);
    box(2.6, 1.5, 0.1, 0, 1.6, -d / 2 + 0.2, 0x3d4a3a);     // 掲示板
    box(2.3, 1.2, 0.03, 0, 1.6, -d / 2 + 0.27, 0xe8e4d6);
    for (const ox of [3.3, 3.9]) {                          // ロッカー
      box(0.5, 1.8, 0.5, ox, 0.9, -1.9, METAL);
      solid(0.5, 0.5, ox, -1.9, 1.8);
    }
  } else {
    counter(0, -2.2, 3.4);
    shelf(-2.9, 0.3, 2.2);
    shelf(2.9, 0.3, 2.2);
  }

  scene.add(g);
  shopRoom = { group: g, sign: sp };
  return shopRoom;
}

/** 店内を畳む。描画物も当たり判定も残さない。 */
function disposeRoom() {
  if (!shopRoom) return;
  shopRoom.group.traverse((o) => {
    o.geometry?.dispose();
    // テクスチャはマテリアルを捨てる前に外す(捨てた後では辿れない)
    for (const m of [o.material].flat().filter(Boolean)) {
      m.map?.dispose();
      m.dispose();
    }
  });
  scene.remove(shopRoom.group);
  hashRemove(bmap, (r) => r.tile === SOLID_SHOP);
  for (let i = bstore.length - 1; i >= 0; i--) {
    if (bstore[i].tile === SOLID_SHOP) bstore.splice(i, 1);
  }
  shopRoom = null;
}

// ---------------------------------------------------------------- 歩行者
// 取り込んだ歩道網(OSM)の上を歩かせる。世界をモノレール沿いに広げても
// 重くならないよう、数は固定で、遠ざかったら手前の歩道へ湧かし直す。
const PED_N = 36;              // 同時に居る人数(固定)
const PED_FAR = 165;           // これより遠い人は使い回す(m)
const PED_NEAR = [30, 130];    // 湧かし直す距離の範囲(m)
const peds = [];
let pedBody = null, pedHead = null, pedHair = null, pedLimb = null;
// 人体の寸法(m)。地面を 0 とした高さで、身長は約1.75m になる。
const PED_HIP = 0.86, PED_SHOULDER = 1.34, PED_HEAD = 1.60;
const PED_ARM = 0.60, PED_LEG = PED_HIP;
const walkLines = [];

{
  for (const f of world.footways ?? []) {
    if (f.k !== 'sidewalk' && f.k !== 'path') continue;
    const pts = [];
    for (let i = 0; i < f.f.length; i += 2) pts.push({ x: wx(f.f[i]), z: wz(f.f[i + 1]) });
    if (pts.length < 2) continue;
    const cum = [0];
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      cum.push(len);
    }
    if (len < 6) continue;                 // 短すぎる断片は使わない
    walkLines.push({ pts, cum, len });
  }

  if (walkLines.length) {
    // 胴・頭・髪・四肢の4つの InstancedMesh に畳む(描画4回)。
    // 四肢は1つの InstancedMesh に 1人4本(腕2・脚2)ぶんを詰めるので、
    // 本数が増えてもドローコールは増えない。
    // カプセル1本だった頃は手足が無く、それが「人に見えない」最大の原因だった。
    const torsoGeo = new THREE.BoxGeometry(0.38, 0.54, 0.22);
    const headGeo = new THREE.SphereGeometry(0.145, 8, 6);
    // 頭の上半分だけの殻。これだけで髪型に見え、頭を1つ増やすより軽い
    const hairGeo = new THREE.SphereGeometry(0.152, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.62);
    const limbGeo = new THREE.BoxGeometry(1, 1, 1);
    limbGeo.translate(0, -0.5, 0);       // 原点を上端(関節)に置く。Yスケール=長さ
    const mat = () => new THREE.MeshLambertMaterial({ vertexColors: false });
    pedBody = new THREE.InstancedMesh(torsoGeo, mat(), PED_N);
    pedHead = new THREE.InstancedMesh(headGeo, mat(), PED_N);
    pedHair = new THREE.InstancedMesh(hairGeo, mat(), PED_N);
    pedLimb = new THREE.InstancedMesh(limbGeo, mat(), PED_N * 4);
    for (const [im, n] of [[pedBody, PED_N], [pedHead, PED_N], [pedHair, PED_N],
                           [pedLimb, PED_N * 4]]) {
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      im.castShadow = true;
      im.frustumCulled = false;          // 毎フレーム行列を書き換えるので境界球が当てにならない
      scene.add(im);
    }

    const shirt = [0x4a6fa5, 0xb5563f, 0x4f7d5a, 0xd0c08a, 0x7a5f8c, 0x3f5560,
                   0xc98b5e, 0x8a9aa3];
    const skin = [0xe8c9a8, 0xdbb489, 0xf0d6bb];
    const hair = [0x2b2320, 0x3a2e26, 0x1d1a18, 0x4a3a2c];
    const pants = [0x38414d, 0x2f3338, 0x5a5346, 0x46403a, 0x6b6257];
    for (let i = 0; i < PED_N; i++) {
      peds.push({
        line: 0, d: 0, dir: 1,
        speed: 1.0 + rnd() * 0.5,          // 1.0〜1.5 m/s
        phase: rnd() * Math.PI * 2,
        shirt: new THREE.Color(shirt[(rnd() * shirt.length) | 0]),
        skin: new THREE.Color(skin[(rnd() * skin.length) | 0]),
        hair: new THREE.Color(hair[(rnd() * hair.length) | 0]),
        pants: new THREE.Color(pants[(rnd() * pants.length) | 0]),
        alive: false,
      });
    }
    // 色は人ごとに固定なので最初に1回だけ入れる(毎フレーム書き直す必要がない)。
    // 腕は肌色=半袖。沖縄なので長袖にはしない。
    peds.forEach((p, i) => {
      pedBody.setColorAt(i, p.shirt);
      pedHead.setColorAt(i, p.skin);
      pedHair.setColorAt(i, p.hair);
      pedLimb.setColorAt(i * 4, p.skin);
      pedLimb.setColorAt(i * 4 + 1, p.skin);
      pedLimb.setColorAt(i * 4 + 2, p.pants);
      pedLimb.setColorAt(i * 4 + 3, p.pants);
    });
    for (const im of [pedBody, pedHead, pedHair, pedLimb]) im.instanceColor.needsUpdate = true;
    console.log(`歩行者 ${PED_N}人 / 歩道 ${walkLines.length}本`);
  }
}

// ---------------------------------------------------------------- シーサーが歩く
// 像だった頃はその場でゆっくり回っていた。歩道網の上を歩かせ、近づかれると
// 早足になる。ただし直線では逃げ切らせない: 早足(1.45m/s)はプレイヤーの歩き
// (4.6m/s)よりずっと遅いので、追いつけないのではなく「曲がり角で回り込む」遊びになる。
const SEESAA_WALK = 0.75;      // ふだんの速さ(m/s)。人(1.0〜1.5)より遅い
const SEESAA_TROT = 1.45;      // 早足
const SEESAA_NEAR = 16;        // この距離まで近づかれると早足になる(m)
const SEESAA_PAUSE = 4.5;      // 立ち止まる秒数の上限

/** シーサーを歩道網に乗せる。walkLines が揃ってから呼ぶこと。 */
function seatSeesaa() {
  if (!walkLines.length) return;
  const used = [];
  for (const g of seesaa) {
    // 互いになるべく離れた歩道を選ぶ。固まって湧くと探す楽しみが無くなる
    let best = null, bestSep = -1;
    for (let k = 0; k < 60; k++) {
      const L = walkLines[(rnd() * walkLines.length) | 0];
      if (L.len < 12) continue;              // 短い断片では歩いているように見えない
      const d = rnd() * L.len;
      const q = walkAt(L, d);
      const sep = used.length
        ? Math.min(...used.map((u) => Math.hypot(u[0] - q.x, u[1] - q.z))) : 1e9;
      if (sep > bestSep) { bestSep = sep; best = { L, d, q }; }
    }
    if (!best) continue;
    used.push([best.q.x, best.q.z]);
    Object.assign(g.userData, {
      line: walkLines.indexOf(best.L), d: best.d,
      dir: rnd() < 0.5 ? 1 : -1,
      phase: rnd() * Math.PI * 2,
      pause: rnd() * SEESAA_PAUSE,
      trot: 0,
    });
    g.position.set(best.q.x, groundAt(best.q.x, best.q.z), best.q.z);
  }
  console.log(`シーサー ${seesaa.length} 体を歩道に乗せた`);
}

seatSeesaa();

/** 1体ぶんの歩きと脚の振り。dist はプレイヤーとの距離。 */
function stepSeesaa(g, dist, dt, now) {
  const u = g.userData;
  // 近づかれると早足。急に切り替わると不自然なので、なまして寄せる
  const want = dist < SEESAA_NEAR ? 1 : 0;
  u.trot += (want - u.trot) * Math.min(1, dt * 1.8);
  const speed = SEESAA_WALK + (SEESAA_TROT - SEESAA_WALK) * u.trot;

  if (u.line !== undefined && walkLines.length) {
    if (u.pause > 0 && u.trot < 0.25) {
      u.pause -= dt;                         // 追われている間は立ち止まらない
    } else {
      const L = walkLines[u.line];
      u.d += u.dir * speed * dt;
      // 端で折り返す。歩道は途中で曲がるので、これだけで角を曲がって見える
      if (u.d > L.len) { u.d = L.len; u.dir = -1; u.pause = 1 + rnd() * SEESAA_PAUSE; }
      if (u.d < 0) { u.d = 0; u.dir = 1; u.pause = 1 + rnd() * SEESAA_PAUSE; }
      const q = walkAt(L, u.d);
      const bob = Math.sin(u.phase * 2) * 0.025;
      g.position.set(q.x, groundAt(q.x, q.z) + bob, q.z);
      // 造形の前方は -Z なので、進行方向へ向けるには π 足す
      g.rotation.y = q.yaw + (u.dir > 0 ? Math.PI : 0);
      u.phase += speed * 3.4 * dt;
    }
  }
  const P = u.parts;
  if (!P) return;
  // 四つ足は対角が同時に出る(速歩)。脚は付け根が原点なので rotation.x だけで振れる
  const sw = Math.sin(u.phase) * (0.30 + u.trot * 0.20);
  P.legFL.rotation.x = sw;  P.legBR.rotation.x = sw;
  P.legFR.rotation.x = -sw; P.legBL.rotation.x = -sw;
  P.tail.rotation.x = Math.sin(u.phase * 2) * 0.28 - 0.1;
  // 首を振るのは止まっている間だけ。歩いている間は進む先を見る
  P.head.rotation.y = u.pause > 0 ? Math.sin(now * 0.0012 + u.phase) * 0.45 : 0;
}

/** 歩道上の距離 d の地点。 */
function walkAt(L, d) {
  d = Math.max(0, Math.min(L.len, d));
  let i = 1;
  while (i < L.cum.length - 1 && L.cum[i] < d) i++;
  const span = L.cum[i] - L.cum[i - 1] || 1;
  const t = (d - L.cum[i - 1]) / span;
  const a = L.pts[i - 1], b = L.pts[i];
  return {
    x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
    yaw: Math.atan2(b.x - a.x, b.z - a.z),
  };
}

/** プレイヤーの手前の歩道へ湧かし直す。見つからなければ諦めて休ませる。 */
function respawnPed(p) {
  for (let tries = 0; tries < 24; tries++) {
    const L = walkLines[(Math.random() * walkLines.length) | 0];
    const d = Math.random() * L.len;
    const q = walkAt(L, d);
    const dist = Math.hypot(q.x - player.x, q.z - player.z);
    if (dist < PED_NEAR[0] || dist > PED_NEAR[1]) continue;
    p.line = walkLines.indexOf(L); p.d = d;
    p.dir = Math.random() < 0.5 ? 1 : -1;
    p.alive = true;
    return;
  }
  p.alive = false;
}

// ---------------------------------------------------------------- 信号
// OSM の信号ノード。交差点ごとに束ねてあり、直交する系統(axis 0/1)が交互に青になる。
// 灯火は InstancedMesh の per-instance color を書き換えるだけなので描画は1回。
const SIG_GREEN = 9, SIG_YELLOW = 2.5, SIG_RED_GAP = 1.5;   // 各相の秒数
const SIG_CYCLE = (SIG_GREEN + SIG_YELLOW + SIG_RED_GAP) * 2;
// 交差点の番号(s.g)はタイルごとの通し番号なので、そのまま使うと離れた
// 交差点どうしが同じ位相で一斉に変わる。タイルごとに 1000 ずつずらして通し番号にする。
const signals = [];                        // 全タイル分。座標はワールド系
let sigGidBase = 0;

const OFF = { r: 0x3a1416, y: 0x3a3216, g: 0x14321f };
const ON = { r: 0xff3b30, y: 0xffcc00, g: 0x2fd158 };

/** タイル t の信号機。灯火はタイルごとの InstancedMesh に持たせる。 */
function addSignals(t) {
  const list = t.data.signals ?? [];
  if (!list.length) return;
  const gidBase = sigGidBase;
  sigGidBase += 1000;

  const poleMat = new THREE.MeshLambertMaterial({ color: 0x6f7679 });
  const caseMat = new THREE.MeshLambertMaterial({ color: 0x3c4448 });
  const poles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.075, 0.1, 1, 6), poleMat, list.length);
  const cases = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 0.22), caseMat, list.length);
  // 灯火は1基3つ(歩行者用は上2つだけ使う)
  const lamps = new THREE.InstancedMesh(
    new THREE.CircleGeometry(0.15, 12),
    new THREE.MeshBasicMaterial({ toneMapped: false }), list.length * 3);
  lamps.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(list.length * 3 * 3), 3);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const e = new THREE.Euler();

  list.forEach((s, i) => {
    const x = t.X(s.x), z = t.Z(s.z);
    const g = groundAt(x, z);
    const car = s.k === 'car';
    const h = car ? 5.0 : 3.1;            // 車両用は高く、歩行者用は低く
    // 支柱
    e.set(0, 0, 0); q.setFromEuler(e);
    pos.set(x, g + h / 2, z); scl.set(1, h, 1);
    m.compose(pos, q, scl); poles.setMatrixAt(i, m);

    // 灯器(交差点の中心を向く)
    e.set(0, s.r, 0); q.setFromEuler(e);
    const cw = car ? 1.15 : 0.5, ch = car ? 0.42 : 0.78;
    pos.set(x, g + h - 0.35, z); scl.set(cw, ch, 1);
    m.compose(pos, q, scl); cases.setMatrixAt(i, m);

    // 灯火を灯器の前面に並べる(車両用は横3つ、歩行者用は縦2つ)
    const fx = Math.sin(s.r) * 0.13, fz = Math.cos(s.r) * 0.13;
    for (let k = 0; k < 3; k++) {
      let ox = 0, oy = 0;
      if (car) ox = (k - 1) * 0.34; else oy = k === 2 ? 0 : (k === 0 ? 0.19 : -0.19);
      const lx = x + Math.cos(s.r) * ox + fx;
      const lz = z - Math.sin(s.r) * ox + fz;
      pos.set(lx, g + h - 0.35 + oy, lz);
      scl.set(car ? 1 : (k === 2 ? 0.001 : 1), 1, 1);   // 歩行者用は3つ目を消す
      m.compose(pos, q, scl);
      lamps.setMatrixAt(i * 3 + k, m);
    }
    // 灯火の書き換え先(どのメッシュの何番目か)を持たせておく
    signals.push({ x, z, r: s.r, k: s.k, a: s.a, g: gidBase + s.g, lamps, li: i * 3 });
  });
  poles.instanceMatrix.needsUpdate = true;
  cases.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  poles.castShadow = cases.castShadow = true;
  t.group.add(poles, cases, lamps);
  console.log(`[${t.key}] 信号 ${list.length}基 / ` +
    `交差点 ${new Set(list.map((s) => s.g)).size}箇所`);
}

/** 交差点 g の、系統 axis から見た現在の灯色を返す。 */
function sigPhase(g, axis, t) {
  // 交差点ごとに位相をずらして、街全体が一斉に変わらないようにする
  const p = (t + g * 6.3) % SIG_CYCLE;
  const halfC = SIG_CYCLE / 2;
  const mine = axis === 0 ? p : (p + halfC) % SIG_CYCLE;
  if (mine < SIG_GREEN) return 'g';
  if (mine < SIG_GREEN + SIG_YELLOW) return 'y';
  return 'r';
}

function updateSignals(t) {
  if (!signals.length) return;
  const c = new THREE.Color();
  const dirty = new Set();
  for (const s of signals) {
    const ph = sigPhase(s.g, s.a, t);
    // 歩行者用は青と赤の2灯(黄は赤扱い)
    const lit = s.k === 'car' ? ph : (ph === 'g' ? 'g' : 'r');
    // 車両用は運転者から見て左から青・黄・赤(日本の並び)。
    // 灯器は交差点の中心を向いているので、この視点がそのまま運転者の視点になる。
    // 歩行者用は上が赤、下が青。
    const cols = s.k === 'car'
      ? [lit === 'g' ? ON.g : OFF.g, lit === 'y' ? ON.y : OFF.y, lit === 'r' ? ON.r : OFF.r]
      : [lit === 'r' ? ON.r : OFF.r, lit === 'g' ? ON.g : OFF.g, OFF.r];
    for (let k = 0; k < 3; k++) {
      c.setHex(cols[k]);
      s.lamps.setColorAt(s.li + k, c);
    }
    dirty.add(s.lamps);
  }
  for (const im of dirty) if (im.instanceColor) im.instanceColor.needsUpdate = true;
}

// タイルの付属物(バス停・信号・看板・公園)。バスは信号を見るのでその前に建てる
for (const t of tiles.values()) buildTileProps(t);

// ---------------------------------------------------------------- 走るバス
// 経路は OSM のバス路線リレーション(那覇バスの実系統)。時刻表は持たないので
// 走行は任意のタイミングだが、経路と停留所は実在のもの。
const buses = [];
{
  const LIVERY = [0xf2f0ea, 0xe8642f];   // 白地にオレンジ帯(那覇バスのイメージ)
  for (const [i, r] of (world.busRoutes ?? []).entries()) {
    const pts = [];
    for (let k = 0; k < r.f.length; k += 2) pts.push([wx(r.f[k]), wz(r.f[k + 1])]);
    if (pts.length < 2) continue;
    const path = { pts: pts.map(([x, z]) => ({ x, z })), cum: [0], len: 0 };
    for (let k = 1; k < pts.length; k++) {
      path.len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      path.cum.push(path.len);
    }

    // 経路上でバス停に近づく地点(そこで少し停まる)
    const stops = [];
    for (let d = 0; d < path.len; d += 5) {
      const q = pathAt(path, d);
      for (const b of world.bus ?? []) {
        if (Math.hypot(wx(b.x) - q.x, wz(b.z) - q.z) < 13) {
          if (!stops.length || d - stops[stops.length - 1] > 45) stops.push(d);
          break;
        }
      }
    }

    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.9, 9.2),
      new THREE.MeshLambertMaterial({ color: LIVERY[0] }));
    body.position.y = 1.75; body.castShadow = true; g.add(body);
    const band = new THREE.Mesh(new THREE.BoxGeometry(2.56, 0.5, 9.0),
      new THREE.MeshLambertMaterial({ color: LIVERY[1] }));
    band.position.y = 1.15; g.add(band);
    const win = new THREE.Mesh(new THREE.BoxGeometry(2.58, 0.95, 8.4),
      new THREE.MeshLambertMaterial({ color: 0x33424c }));
    win.position.y = 2.35; g.add(win);
    for (const [wx, wz] of [[-1.15, 3.0], [1.15, 3.0], [-1.15, -2.6], [1.15, -2.6]]) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.34, 10),
        new THREE.MeshLambertMaterial({ color: 0x24282a }));
      t.rotation.z = Math.PI / 2; t.position.set(wx, 0.45, wz); g.add(t);
    }
    const lab = makeLabel(`${r.ref}  ${r.name.split('(')[0].trim()}`, 7.6, 1.9);
    lab.position.y = 4.4;
    g.add(lab);
    scene.add(g);

    // 経路上で信号に差しかかる地点(停止線)。進行方向から見る系統も決めておく
    const sigs = [];
    for (let d = 0; d < path.len; d += 4) {
      const q = pathAt(path, d);
      for (const s of signals) {
        if (s.k !== 'car') continue;
        if (Math.hypot(s.x - q.x, s.z - q.z) > 11) continue;
        if (sigs.length && Math.abs(d - sigs[sigs.length - 1].d) < 30) break;
        // 東西に進むなら axis 0、南北なら axis 1 の系統を見る
        const axis = Math.abs(Math.sin(q.yaw)) >= Math.abs(Math.cos(q.yaw)) ? 0 : 1;
        sigs.push({ d, g: s.g, axis });
        break;
      }
    }

    buses.push({
      g, path, stops, sigs, label: lab,
      ref: r.ref, name: r.name.split('(')[0].split('（')[0].trim(),
      d: path.len * (0.13 + 0.21 * i), dir: 1, wait: 0,
    });
  }
  console.log(`バス ${buses.length}台 / 経路 ` +
    (world.busRoutes ?? []).map((r) => r.ref).join('、'));
}

/** 折れ線の距離 d の地点と方位(バス用。高さは地形から取る)。 */
function pathAt(path, d) {
  d = Math.max(0, Math.min(path.len, d));
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i] < d) i++;
  const span = path.cum[i] - path.cum[i - 1] || 1;
  const t = (d - path.cum[i - 1]) / span;
  const a = path.pts[i - 1], b = path.pts[i];
  return {
    x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
    yaw: Math.atan2(b.x - a.x, b.z - a.z),
  };
}

// 走る車両(2両)。線形を往復するので端で消えたり湧いたりしない
let train = null, trainPath = null, trainD = 0, trainDir = 1;
let trainStopD = null, trainWait = 0;
if (railPaths.length) {
  // 駅のある線形を走らせる(無ければいちばん長い線形)。
  // 長さで選ぶと駅が別の線形に乗っていて永久に停まらないことがある。
  trainPath = stationStop?.p ?? railPaths.reduce((a, b) => (b.len > a.len ? b : a));
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

  // 駅での停車位置(線形上の距離)
  if (stationStop && stationStop.p === trainPath) trainStopD = stationStop.d;
  console.log(`列車の線形 ${Math.round(trainPath.len)}m / 停車位置 ` +
    (trainStopD === null ? 'なし' : `${Math.round(trainStopD)}m`));
}

// 乗り物としてのモノレール(バスと同じ扱いにして乗降処理を共通化する)
const trainRide = train ? {
  g: train, ref: 'ゆいレール', name: '沖縄都市モノレール線',
  seat: { x: 0, y: 0.15, z: 7.2 },          // 前寄りの車両の中ほど
  isTrain: true, wait: 0,
} : null;

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
// 読み込み済みタイル全体を収める正方形に載せる(タイルが増えても縮尺だけが変わる)
const MB = worldBounds();
const MSPAN = Math.max(MB.maxx - MB.minx, MB.maxz - MB.minz);
const MCX = (MB.minx + MB.maxx) / 2, MCZ = (MB.minz + MB.maxz) / 2;
const mx = (v) => (v - MCX + MSPAN / 2) / MSPAN * MS;
const mz = (v) => (v - MCZ + MSPAN / 2) / MSPAN * MS;
const base = document.createElement('canvas');
base.width = base.height = MS;
{
  const b = base.getContext('2d');
  b.fillStyle = '#16302f'; b.fillRect(0, 0, MS, MS);
  // 道路を先に敷く(街路の骨格が見えると現在地を掴みやすい)
  b.fillStyle = 'rgba(190,205,205,.30)';
  roadPath(b, mx, mz);
  b.fill();
  // モノレール(街の骨格として道路より目立たせる)
  b.strokeStyle = 'rgba(120,190,235,.85)';
  b.lineWidth = Math.max(2, 3 * (MS / 188));
  b.lineCap = 'round';
  for (const p of railPaths) {
    b.beginPath();
    p.pts.forEach((q, i) => (i ? b.lineTo(mx(q.x), mz(q.z)) : b.moveTo(mx(q.x), mz(q.z))));
    b.stroke();
  }
  // バス停
  b.fillStyle = 'rgba(120,200,235,.9)';
  const bs = Math.max(2, 2.2 * (MS / 188));
  for (const s of busSigns) {
    b.fillRect(mx(s.position.x) - bs / 2, mz(s.position.z) - bs / 2, bs, bs);
  }
  b.fillStyle = 'rgba(246,243,234,.42)';
  for (const bd of bstore) {
    b.beginPath();
    b.moveTo(mx(bd.ring[0].x), mz(bd.ring[0].y));
    for (let i = 1; i < bd.ring.length; i++) b.lineTo(mx(bd.ring[i].x), mz(bd.ring[i].y));
    b.closePath(); b.fill();
  }
}

// マーカーは 188px 表示を基準に描いていたので、実解像度に合わせて拡大する
const MK = MS / 188;

function drawMap() {
  mctx.drawImage(base, 0, 0);
  // 城東小
  mctx.fillStyle = '#e8642f';
  mctx.beginPath(); mctx.arc(mx(0), mz(0), 3.4 * MK, 0, 7); mctx.fill();
  // シーサー
  for (const s of seesaa) {
    if (s.userData.taken) continue;
    mctx.fillStyle = '#ffc27a';
    mctx.beginPath(); mctx.arc(mx(s.position.x), mz(s.position.z), 2.6 * MK, 0, 7); mctx.fill();
  }
  // 市議会の言及(未読は塗り、既読は輪郭だけ)
  for (const g of councilPosts) {
    const x = mx(g.position.x), z = mz(g.position.z), r = 3.2 * MK;
    mctx.beginPath(); mctx.arc(x, z, r, 0, 7);
    if (g.userData.read) {
      mctx.strokeStyle = '#e8642f'; mctx.lineWidth = 1.6 * MK; mctx.stroke();
    } else {
      mctx.fillStyle = '#e8642f'; mctx.fill();
      mctx.strokeStyle = '#f6f3ea'; mctx.lineWidth = 1.2 * MK; mctx.stroke();
    }
  }

  // 自分(視線方向つき)
  const px = mx(hereX()), pz = mz(hereZ());
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

// ---------------------------------------------------------------- バスに乗る
// バス停に停まっているバスへ近づくと乗れる。乗車中は移動入力を切り、
// 座席の位置にプレイヤーを貼り付ける(見回しは自由)。
const BOARD_R = 6.5;           // この距離まで近づくと乗れる(m)
const SEAT = { x: -0.75, y: 2.15, z: 1.6 };   // バス内の座席(左の窓側)
const seatOf = (v) => v.seat ?? SEAT;
let riding = null, boardable = null;
const rideEl = $('ride');

// 店の出入り。乗り物と同じ「近づく → 入る → 出る」なので UI も共用する
let inShop = null, enterable = null, shopReturn = null;

/** 地図やHUDで使う街での現在地。店内に居るあいだは入る前の位置を指す。 */
const hereX = () => (inShop ? shopReturn.x : player.x);
const hereZ = () => (inShop ? shopReturn.z : player.z);

function updateRideUI() {
  const set = (t, m, b) => {
    $('rd-route').textContent = t;
    $('rd-msg').textContent = m;
    $('rd-btn').textContent = TOUCH ? b : `${b} [E]`;
    rideEl.classList.add('on');
  };
  if (inShop) {
    set(`${inShop.userData.mark}　${inShop.userData.name}`,
        inShop.userData.oh || '店内', '出る');
  } else if (riding) {
    set(`${riding.ref}　${riding.name}`, '乗車中 — 景色をどうぞ', '降りる');
  } else if (boardable) {
    set(`${boardable.ref}　${boardable.name}`,
        boardable.isTrain ? 'が到着しています' : 'が停まっています', '乗る');
  } else if (enterable) {
    set(`${enterable.userData.mark}　${enterable.userData.name}`,
        enterable.userData.oh || '入れます', '入る');
  } else {
    rideEl.classList.remove('on');
  }
}

function enterShop() {
  if (inShop || riding || !enterable) return;
  const sp = enterable;
  shopReturn = { x: player.x, z: player.z, y: player.y, yaw: player.yaw, pitch: player.pitch };
  setFly(false);
  buildRoom(sp);
  inShop = sp;
  enterable = null;
  stick = null; stickShow(false);
  // 入口(手前の壁)の内側に立って店の奥を向く。yaw=0 の前方は -Z
  player.x = STAGE.x;
  player.z = STAGE.z + ROOM.d / 2 - 1.1;
  player.y = STAGE.y + EYE;
  player.yaw = 0; player.pitch = 0;
  player.vy = 0; player.onGround = true;
  say(`${sp.userData.name} に入った`);
  updateRideUI();
}

function exitShop() {
  if (!inShop) return;
  const name = inShop.userData.name;
  const back = shopReturn;
  inShop = null; shopReturn = null;
  disposeRoom();
  player.x = back.x; player.z = back.z;
  player.y = supportY(back.x, back.z) + EYE;
  player.yaw = back.yaw; player.pitch = back.pitch;
  player.vy = 0; player.onGround = true;
  say(`${name} を出た`);
  updateRideUI();
}

function board() {
  if (riding || !boardable) return;
  riding = boardable;
  boardable = null;
  setFly(false);
  player.vy = 0; player.onGround = true;
  document.body.classList.add('riding');
  stick = null; stickShow(false);
  say(`${riding.ref} ${riding.name} に乗車`);
  updateRideUI();
}

function alight() {
  if (!riding) return;
  const b = riding;
  // バスは歩道側、モノレールはホーム側へ降ろす。塞がっていたら順に試す
  const yaw = b.g.rotation.y;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const cands = b.isTrain
    ? [[3.4, 0], [3.4, 6], [3.4, -6], [-3.4, 0], [3.4, 12]]
    : [[2.6, 0], [3.4, 0], [2.6, 3], [2.6, -3], [-2.6, 0], [0, 5]];
  let done = false;
  for (const [ox, oz] of cands) {
    const x = b.g.position.x + ox * cos + oz * sin;
    const z = b.g.position.z - ox * sin + oz * cos;
    // 降りた先の足場(ホームの天端も含む)で判定する
    const s = supportY(x, z);
    if (!blocked(x, z, RADIUS, s)) { player.x = x; player.z = z; done = true; break; }
  }
  if (!done) { player.x = b.g.position.x + 3; player.z = b.g.position.z; }
  player.y = supportY(player.x, player.z) + EYE;
  player.vy = 0; player.onGround = true;
  riding = null;
  document.body.classList.remove('riding');
  say('降車');
  updateRideUI();
}

/** [E] とボタンの共通処理。出入りは1つのボタンで賄う。 */
function rideAction() {
  if (inShop) exitShop();
  else if (riding) alight();
  else if (boardable) board();
  else if (enterable) enterShop();
}

$('rd-btn').addEventListener('click', rideAction);
$('rd-btn').addEventListener('touchstart', (e) => {
  e.preventDefault();
  rideAction();
}, { passive: false });
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyE' || !started) return;
  rideAction();
});

// ---------------------------------------------------------------- 議会パネル
const COUNCIL_R = 16;          // この距離まで近づくと出る(m)
let councilNear = null, councilIdx = 0, councilRead = 0;
let councilClosed = false;     // ✕で閉じた。離れるまで出し直さない
const cvEl = $('council');

function showCouncil(g) {
  if (!g || councilClosed) { cvEl.classList.remove('on'); return; }
  const p = g.userData.place;
  const s = p.speeches[councilIdx % p.speeches.length];
  $('cv-place').textContent = p.label;
  $('cv-speaker').textContent = s.speaker || '(発言者不明)';
  $('cv-date').textContent = `${s.date}　${s.meeting}`;
  $('cv-quote').textContent = s.excerpt;
  const a = $('cv-link');
  a.href = s.url || '#';
  a.style.visibility = s.url ? 'visible' : 'hidden';
  const multi = p.speeches.length > 1;
  $('cv-next').hidden = !multi;
  $('cv-nav').textContent = multi
    ? `${councilIdx % p.speeches.length + 1} / ${p.speeches.length}`
    : `この場所の言及 ${p.hits}件中1件`;
  cvEl.classList.add('on');
}

function closeCouncil() {
  councilClosed = true;
  cvEl.classList.remove('on');
}
function nextCouncil() {
  if (!councilNear) return;
  councilIdx++;
  showCouncil(councilNear);
}

$('cv-close').addEventListener('click', closeCouncil);
$('cv-next').addEventListener('click', nextCouncil);
// タッチはクリック合成を待たずに反応させる(押しても反応しないと感じさせない)
$('cv-close').addEventListener('touchstart', (e) => { e.preventDefault(); closeCouncil(); },
  { passive: false });
$('cv-next').addEventListener('touchstart', (e) => { e.preventDefault(); nextCouncil(); },
  { passive: false });

addEventListener('keydown', (e) => {
  if (!councilNear) return;
  if (e.code === 'KeyQ') nextCouncil();
  if (e.code === 'KeyX') closeCouncil();
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
let sigLast = -1;              // 信号の灯火を書き換えた最後の時刻(秒)

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

  // バス(バス停で少し停まる。端まで行ったら折り返す=上り下り)。
  // 乗車中はプレイヤーを座席へ貼り付けるので、必ずプレイヤー更新より先に動かす。
  const sigT = now / 1000;
  if (sigT - sigLast > 0.15) { sigLast = sigT; updateSignals(sigT); }

  for (const b of buses) {
    // 停止線の手前で赤(と黄)なら進まない
    let hold = false;
    if (b.wait <= 0) {
      for (const s of b.sigs) {
        const ahead = b.dir > 0 ? s.d - b.d : b.d - s.d;
        if (ahead >= 0 && ahead < 3.5 && sigPhase(s.g, s.axis, sigT) !== 'g') {
          hold = true; break;
        }
      }
    }
    if (b.wait > 0) {
      b.wait -= dt;
    } else if (!hold) {
      const prev = b.d;
      b.d += b.dir * 8.5 * dt;              // 約30km/h
      if (b.d > b.path.len) { b.d = b.path.len; b.dir = -1; b.wait = 2.5; }
      if (b.d < 0) { b.d = 0; b.dir = 1; b.wait = 2.5; }
      for (const s of b.stops) {
        if ((prev < s && b.d >= s) || (prev > s && b.d <= s)) {
          // そばに人が居るバス停では長めに停まる(乗り込む余裕をつくる)
          const q0 = pathAt(b.path, s);
          const near = Math.hypot(q0.x - player.x, q0.z - player.z) < 22;
          b.wait = near ? 7 : 2.2;
          break;
        }
      }
    }
    const q = pathAt(b.path, b.d);
    b.g.position.set(q.x, groundAt(q.x, q.z), q.z);
    b.g.rotation.y = q.yaw + (b.dir < 0 ? Math.PI : 0);
    b.label.visible = !riding &&
      Math.hypot(q.x - player.x, q.z - player.z) < 110;
  }

  // 乗車中は座席に貼り付ける(見回しは自由)
  if (riding) {
    const s = seatOf(riding);
    const yaw = riding.g.rotation.y;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    player.x = riding.g.position.x + s.x * cos + s.z * sin;
    player.z = riding.g.position.z - s.x * sin + s.z * cos;
    player.y = riding.g.position.y + s.y;
    player.vy = 0; player.onGround = true;
  }

  // 乗れる車両を探す(停車中で、十分近いもの)
  {
    const prev = boardable;
    boardable = null;
    if (active && !riding) {
      let best = Infinity;
      const cands = trainRide ? [...buses, trainRide] : buses;
      for (const v of cands) {
        if (v.wait <= 0) continue;
        const d = Math.hypot(v.g.position.x - player.x, v.g.position.z - player.z);
        // 高さも見る。モノレールは高架なので地上から乗り込めてはいけない
        const dy = Math.abs(player.y - (v.g.position.y + seatOf(v).y));
        if (d < (v.isTrain ? 11 : BOARD_R) && dy < 3.5 && d < best) {
          best = d; boardable = v;
        }
      }
    }
    if (prev !== boardable) updateRideUI();
  }

  // 入れる店を探す(乗り物が優先。バス停の前の店で取り合いにならないように)
  {
    const prev = enterable;
    enterable = null;
    if (active && !riding && !inShop && !boardable) {
      let best = Infinity;
      const feet = player.y - EYE;
      for (const s of shopSigns) {
        const D = s.userData.door;
        const d = Math.hypot(D.x - player.x, D.z - player.z);
        if (d >= ENTER_R || d >= best) continue;
        // 高さも見る。屋根の上や飛行中に入れてしまわないように
        if (Math.abs(feet - D.gy) > 2.5) continue;
        best = d; enterable = s;
      }
    }
    if (prev !== enterable) updateRideUI();
  }

  if (active && !riding) {
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
      // 読み込み済みタイルの外へは出さない(地形が無く落ちるため)。
      // 店内は街の外に建てた舞台なので、この制限をかけない
      if (!inShop) {
        player.x = Math.max(BOUNDS.minx + 2, Math.min(BOUNDS.maxx - 2, player.x));
        player.z = Math.max(BOUNDS.minz + 2, Math.min(BOUNDS.maxz - 2, player.z));
      }
    }

    // ジャンプの長押しで飛行を切り替える(押している間に1回だけ発火)
    // 店内では飛べない(天井を抜けて舞台の外へ出てしまうため)
    if (jumpHeld && !holdUsed && now - jumpSince > HOLD_MS) {
      holdUsed = true;
      if (!inShop) setFly(!flying);
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

  // モノレールの車両(駅で停車し、端に着いたら折り返す)
  if (train && trainPath) {
    if (trainWait > 0) {
      trainWait -= dt;
    } else {
      const prev = trainD;
      trainD += trainDir * 11 * dt;             // 約40km/h
      if (trainD > trainPath.len) { trainD = trainPath.len; trainDir = -1; trainWait = 3; }
      if (trainD < 0) { trainD = 0; trainDir = 1; trainWait = 3; }
      if (trainStopD !== null &&
          ((prev < trainStopD && trainD >= trainStopD) ||
           (prev > trainStopD && trainD <= trainStopD))) {
        trainD = trainStopD;
        trainWait = 9;                          // 乗り降りできる長さ
      }
    }
    const q = railAt(trainPath, trainD);
    train.position.set(q.x, q.y + 0.9, q.z);  // 桁をまたぐので少し上に乗せる
    train.rotation.y = q.yaw + (trainDir < 0 ? Math.PI : 0);
    if (trainRide) trainRide.wait = trainWait;
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
      councilClosed = false;      // 別の地点(や圏外)に移ったら閉じた状態は解除
      showCouncil(hit);
      if (hit && !hit.userData.read) {
        hit.userData.read = true;
        councilRead++;
        say(`議会の記録を見つけた（${councilRead}/${councilPosts.length}）`);
      }
    }
  }

  // 歩行者(数は固定。遠ざかったら手前へ湧かし直すので広げても重くならない)
  if (pedBody && walkLines.length) {
    const m = new THREE.Matrix4(), q4 = new THREE.Quaternion();
    const pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const scl = new THREE.Vector3(), eu = new THREE.Euler();
    const away = new THREE.Matrix4().makeTranslation(0, -9999, 0);
    // 四肢: [左右のずれ, 関節の高さ, 太さ, 長さ, 振りの大きさ, 位相のずれ]
    // 腕と脚は逆位相で振る(右足が前なら左手が前)。
    const LIMB = [
      [-0.19, PED_SHOULDER, 0.085, PED_ARM, 0.42, Math.PI],
      [0.19, PED_SHOULDER, 0.085, PED_ARM, 0.42, 0],
      [-0.10, PED_HIP, 0.115, PED_LEG, 0.55, 0],
      [0.10, PED_HIP, 0.115, PED_LEG, 0.55, Math.PI],
    ];
    peds.forEach((p, i) => {
      if (!p.alive) { if ((frame + i) % 30 === 0) respawnPed(p); }
      if (!p.alive) {                       // 湧けなかった人は画面外へ置く
        pedBody.setMatrixAt(i, away); pedHead.setMatrixAt(i, away);
        pedHair.setMatrixAt(i, away);
        for (let k = 0; k < 4; k++) pedLimb.setMatrixAt(i * 4 + k, away);
        return;
      }
      const L = walkLines[p.line];
      p.d += p.dir * p.speed * dt;
      if (p.d > L.len) { p.d = L.len; p.dir = -1; }
      if (p.d < 0) { p.d = 0; p.dir = 1; }
      const w = walkAt(L, p.d);
      if (Math.hypot(w.x - player.x, w.z - player.z) > PED_FAR) {
        respawnPed(p);
        return;
      }
      const g = groundAt(w.x, w.z);
      // 歩調は速さに比例させる。1.2m/s でおよそ 0.9Hz(=毎秒1.8歩)
      const ph = now * 0.0047 * p.speed + p.phase;
      const bob = Math.sin(ph * 2) * 0.03;  // 上下動は歩調の2倍(1歩ごとに沈む)
      const yaw = w.yaw + (p.dir < 0 ? Math.PI : 0);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);

      eu.set(0, yaw, 0);
      q4.setFromEuler(eu);
      pos.set(w.x, g + 1.13 + bob, w.z);
      m.compose(pos, q4, one); pedBody.setMatrixAt(i, m);
      pos.set(w.x, g + PED_HEAD + bob, w.z);
      m.compose(pos, q4, one); pedHead.setMatrixAt(i, m);
      pedHair.setMatrixAt(i, m);            // 髪は頭と同じ位置・向き

      for (let k = 0; k < 4; k++) {
        const [ox, jy, th, len, amp, off] = LIMB[k];
        // 関節は体の横にあるので、左右のずれを向きで回してから足す。
        // 三次元のオイラー角は YXZ 順にすると「向いてから前後に振る」になる。
        eu.set(Math.sin(ph + off) * amp, yaw, 0, 'YXZ');
        q4.setFromEuler(eu);
        pos.set(w.x + ox * cy, g + jy + bob, w.z - ox * sy);
        scl.set(th, len, th);
        m.compose(pos, q4, scl); pedLimb.setMatrixAt(i * 4 + k, m);
      }
    });
    for (const im of [pedBody, pedHead, pedHair, pedLimb]) im.instanceMatrix.needsUpdate = true;
  }

  // 店舗の看板も近くだけ(距離バジェット)
  for (const s of shopSigns) {
    s.visible = Math.hypot(s.position.x - player.x, s.position.z - player.z) < SHOP_R;
  }

  // バス停の名札は近くだけ(20枚が常時見えると画面が埋まる)
  for (const s of busSigns) {
    s.visible = Math.hypot(s.position.x - player.x, s.position.z - player.z) < 135;
  }

  // シーサーの回収
  let nearest = Infinity;
  for (const s of seesaa) {
    if (s.userData.taken) continue;
    // 店内に居るあいだは入る前の位置で測る(街から離れた舞台に居るため)
    const d = Math.hypot(s.position.x - hereX(), s.position.z - hereZ());
    if (d < nearest) nearest = d;
    stepSeesaa(s, d, dt, now);                    // 歩く・脚を振る・近いと早足
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
  // 店内の舞台は街の外にあるので、標高は入る前の値のまま見せる
  $('alt').textContent = `${((inShop ? shopReturn.y : player.y) - EYE).toFixed(1)} m`;
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
  council, councilPosts, showCouncil, buses, trainRide, bstore, sigPhase, signals,
  rmap, bmap, hashInsert, hashRemove, distToBuilding,
  // タイル関係(検証用)
  tiles, tileOf, worldBounds, fetchTile, buildTileCore, buildTileProps, TILE, HALF,
  // シーサー(検証用)。tick を待たずに歩きだけ回せる
  stepSeesaa, seatSeesaa, walkLines, walkAt,
  // 店の中(検証用)。看板の前まで歩かずに寄れる
  shopSigns, shopState: () => ({ inShop: inShop?.userData ?? null,
    enterable: enterable?.userData ?? null, solids: bstore.filter((r) => r.tile === 'shop').length }),
  gotoShop: (i) => {
    const s = shopSigns[i];
    if (!s) return null;
    // 扉の正面 2m に立ち、扉を向く
    const D = s.userData.door;
    player.x = D.x + Math.sin(D.yaw) * 2.0;
    player.z = D.z + Math.cos(D.yaw) * 2.0;
    player.y = supportY(player.x, player.z) + EYE;
    // 前方は (-sin yaw, -cos yaw)。扉は外向き(sin,cos)にあるので yaw はそのままで振り向く
    player.yaw = D.yaw; player.pitch = 0;
    return { ...s.userData, standGround: +groundAt(player.x, player.z).toFixed(1) };
  },
  // tick を待たずに出入りする(ペインが隠れていると rAF が止まって検証できないため)
  visitShop: (i) => { enterable = shopSigns[i] ?? null; enterShop(); },
  leaveShop: () => exitShop(),
  // 検証用: 列車を駅に着けて長く停める
  trainToStation: (sec = 60) => {
    if (trainStopD === null) return false;
    trainD = trainStopD; trainWait = sec;
    return true;
  },
  flyState: () => ({ flying, jumpHeld, holdUsed, held: performance.now() - jumpSince }) };

// ---------------------------------------------------------------- 開発ログ
// changelog.json は tools/build_changelog.py が git log から作る(手書きではない)
{
  const view = $('logview'), list = $('loglist');
  let loaded = false;

  async function openLog() {
    view.classList.add('on');
    if (loaded) return;
    loaded = true;
    let data;
    try {
      const r = await fetch('./data/changelog.json');
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
    } catch {
      list.innerHTML = '<div class="lg"><div class="t">ログを読み込めませんでした</div>' +
        '<ul><li>tools/build_changelog.py が生成する data/changelog.json が要ります</li></ul></div>';
      return;
    }
    $('logsub').textContent =
      `${data.items.length}件のコミット（実際の git 履歴から生成）`;
    list.innerHTML = data.items.map((it) => {
      const k = it.kind
        ? `<span class="k ${it.tag}">${it.kind}</span>` : '';
      const body = it.body.length
        ? `<ul>${it.body.map((l) =>
            `<li>${esc(l.replace(/^[-*]\s*/, ''))}</li>`).join('')}</ul>` : '';
      return `<div class="lg"><div class="top">${k}` +
        `<span class="t">${esc(it.title)}</span>` +
        `<span class="d">${esc(it.date)}</span></div>${body}` +
        `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.sha)} ↗</a></div>`;
    }).join('');
  }
  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  $('logbtn').addEventListener('click', openLog);
  $('logclose').addEventListener('click', () => view.classList.remove('on'));
  view.addEventListener('click', (e) => {
    if (e.target === view) view.classList.remove('on');   // 外側を押しても閉じる
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && view.classList.contains('on')) {
      e.stopPropagation();
      view.classList.remove('on');
    }
  }, true);
}

// ---------------------------------------------------------------- 起動
$('go').disabled = false;
$('go').textContent = TOUCH ? 'タップして歩きだす' : 'クリックして歩きだす';
// 出典表示は #credit に常設してあるので、ここは規模の説明だけにする
// bstore はホーム・階段・木の幹も含むので、棟数はタイルのデータから数える
const nBuildings = [...tiles.values()].reduce((s, t) => s + t.data.buildings.length, 0);
$('meta').textContent =
  `建物 ${nBuildings.toLocaleString()} 棟 ／ ` +
  `地形 ${tile0.n}×${tile0.n} (${tile0.cell}m格子) × ${tiles.size}タイル ／ ` +
  `標高 ${tile0.data.meta.minZ}〜${tile0.data.meta.maxZ}m`;
drawMap();
tick();
