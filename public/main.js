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
// シーサーは **全線で この数** を散らす。タイルごとに固定数にすると、
// 37タイルで370体になって集めきれない。世界が広がっても分母は動かさない。
const N_SEESAA = 30;
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
  return `./data/tiles/t_${tx}_${tz}.json`;
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
  // タイルごとの擬似乱数。タイルは出し入れするので、全タイル共通の乱数を使うと
  // 同じタイルに戻るたびに木や遊具の位置が変わる(実測で固体の数が 2630→2640→2639
  // と揺れた)。鍵から種を作れば、何度捨てて読み直しても同じ街になる。
  let seed = ((tx * 73856093) ^ (tz * 19349663) ^ 0x9e3779b9) >>> 0;
  const trnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const t = {
    key, tx, tz, data, offX, offZ, rnd: trnd,
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

/** タイルの並び {tx,tz} から、それが覆う範囲 {minx,maxx,minz,maxz} を出す。 */
function boundsOf(list) {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const { tx, tz } of list) {
    minx = Math.min(minx, tx * TILE - HALF); maxx = Math.max(maxx, tx * TILE + HALF);
    minz = Math.min(minz, tz * TILE - HALF); maxz = Math.max(maxz, tz * TILE + HALF);
  }
  return { minx, maxx, minz, maxz };
}

/** 読み込み済みタイルが覆う範囲。受け皿(外周の帯)を張る位置に使う。 */
function worldBounds() {
  return boundsOf([...tiles.values()]);
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

// この世界にどのタイルがあるか(tools/build_tile_index.py が作る)。
// 「いま読み込んでいるタイル」とは別物で、こちらは歩き回っても変わらない。
// 歩ける範囲と地図の縮尺はこちらで決める(読み込みに追従させると、
// 歩くたびに地図の縮尺が変わって現在地が掴めなくなる)。
// index.json のタイルは [tx, tz, 建物の数]。建物の数はシーサーの配分に使う。
const WORLD_TILES = await fetch('./data/tiles/index.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => (j?.tiles ?? [[0, 0, 1]])
    .map(([tx, tz, n]) => ({ tx, tz, n: n ?? 1 })))
  .catch(() => [{ tx: 0, tz: 0, n: 1 }]);
const WORLD_KEYS = new Set(WORLD_TILES.map((t) => `${t.tx},${t.tz}`));
const WORLD_B = boundsOf(WORLD_TILES);

// 最初に読むタイル。既定はタイル(0,0)だけで、残りは歩くにつれて足す。
// `?tiles=0,0;-1,0` で明示すると、その並びだけを読んで足し引きしない(検証用)。
const TILE_FIXED = qs.has('tiles');
const TILE_LIST = TILE_FIXED
  ? qs.get('tiles').split(';').map((s) => s.split(',').map(Number))
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
  : [[0, 0]];
for (const [tx, tz] of TILE_LIST) await fetchTile(tx, tz);
const tile0 = tiles.get('0,0') ?? tiles.values().next().value;
// タイル(0,0)の生データ。描画には使わない(window.dbg から覗くためだけに残す)。
// public/data/world.json は tools/link_council.py の入力として残してあるが、
// ここでは読まない(t_0_0.json と中身は完全に同じ。地形の差 0.0000m を実測)。
const world = tile0.data;

// モノレール線形・駅・バス経路は corridor.json(全線ぶん)。
// タイルの中身ではないので座標は最初からワールド座標(meta.coords="global")で、
// HALF を引いてはいけない。
const corridor = await fetch('./data/corridor.json')
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (!corridor) console.error('corridor.json が読めません(モノレールとバスが出ません)');

// 全線をそのまま建てると、地形の無い受け皿の上を桁が延々と伸びる。
// 読み込み済みタイルの範囲 + この余白だけ建てる。
// 歩ける端(タイルの縁)から先へ少しだけ続いて見えればよいので短くする。
// 長いと、受け皿(平らな緑地)の上に高架だけが取り残されて目立つ。
const CORRIDOR_PAD = 120;

/** (x,z) が読み込み済みのどれかのタイル + pad の中にあるか。 */
function nearLoaded(x, z, pad = CORRIDOR_PAD) {
  for (const t of tiles.values()) {
    if (x >= t.offX - HALF - pad && x <= t.offX + HALF + pad &&
        z >= t.offZ - HALF - pad && z <= t.offZ + HALF + pad) return true;
  }
  return false;
}

/**
 * ワールド座標の折れ線(flat = [x,z,x,z,...])を読み込み済みタイル+余白で切る。
 * 途中で外へ出ると切れるので、戻りは [[x,z],...] の配列の配列。
 * タイルの矩形ごとに判定するので、L字に読んでも間の空白は拾わない。
 */
function clipToLoaded(flat, pad = CORRIDOR_PAD) {
  const inside = (p) => nearLoaded(p[0], p[1], pad);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // 内側の点と外側の点の境目。タイルの矩形の和なので解析的には解かず二分探索する。
  // 外側の頂点をそのまま残すと、頂点が疎な区間(全線データは1区間400m超のこともある)
  // が丸ごと余白の外へ出て、地形の無いところに桁が伸びる。
  const edge = (ain, bout) => {
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) {
      const m = (lo + hi) / 2;
      if (inside(lerp(ain, bout, m))) lo = m; else hi = m;
    }
    return lerp(ain, bout, lo);
  };
  const out = [];
  let run = null;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const a = [flat[i], flat[i + 1]], b = [flat[i + 2], flat[i + 3]];
    const ia = inside(a), ib = inside(b);
    if (ia && ib) {
      if (!run) { run = [a]; out.push(run); }
      run.push(b);
    } else if (ia) {                       // 出ていく: 境目で止める
      if (!run) { run = [a]; out.push(run); }
      run.push(edge(a, b));
      run = null;
    } else if (ib) {                       // 入ってくる: 境目から始める
      run = [edge(b, a), b];
      out.push(run);
    } else {
      // 両端とも外。長い区間が範囲を横切ることがあるので刻んで中を探す
      run = null;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(L / 25));
      let hit = -1;
      for (let s = 1; s < steps; s++) {
        if (inside(lerp(a, b, s / steps))) { hit = s / steps; break; }
      }
      if (hit < 0) continue;
      const m = lerp(a, b, hit);
      out.push([edge(m, a), m, edge(m, b)]);
    }
  }
  return out.filter((r) => r.length >= 2);
}

/** 折れ線 [[x,z],...] の長さ(m)。切れた断片からいちばん長いものを選ぶのに使う。 */
function polyLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return s;
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

// 空(内側から見るドーム)。
// ドームは毎フレームプレイヤーの真上へ動かす(tick)。原点に固定すると、
// 離れたぶん反対側が遠のいてカメラの far(2600m)で切れ、空に黒い穴が開く。
// タイルを増やすと必ず出る(2タイルで x=-1500 に立つと反対側は 3500m)。
// そのため階調はワールド座標ではなく **ドーム内のローカル座標** から取る。
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(2000, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: SKY_TOP }, bot: { value: SKY_BOT } },
    vertexShader: `varying float h;
      void main(){ h = normalize(position).y;
        gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 bot; varying float h;
      void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*1.5+0.08,0.0,1.0)), 1.0); }`,
  })
);
scene.add(sky);

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
  const BAND = 64;                 // 一度に仕上げる行数(実測 約18ms/帯)
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
  // G=土(グラウンド) / B=工事区域 に分けて入れる。縁のアンチエイリアスも混ざらない。
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
  // 工事区域は空いていた B に入れる。公園と同じ canvas なので読み出しは増えない
  pg.fillStyle = '#00f';
  for (const p of t.data.construction ?? []) {
    pg.beginPath();
    for (let i = 0; i < p.f.length; i += 2) {
      const x = pxX(t.X(p.f[i])), z = pxZ(t.Z(p.f[i + 1]));
      i ? pg.lineTo(x, z) : pg.moveTo(x, z);
    }
    pg.closePath(); pg.fill();
  }

  const PAVE = [154, 150, 142];             // 敷地(コンクリ)
  const ROAD = [110, 110, 114];             // 道路(アスファルト)
  const EDGE = [138, 134, 112];             // 路肩・未舗装
  const GREEN = [111, 147, 73];             // 緑地(建物からの距離で推定したもの)
  const PARK = [92, 137, 60];               // 公園の芝(実データ)
  const DIRT = [156, 130, 96];              // グラウンドの土(那覇の校庭は土が多い)
  const SITE = [143, 108, 84];              // 工事区域(掘り返した国頭マージ＝沖縄の赤土)
  // 閾値で切ると色の帯ができるので、密度に沿って連続的に混ぜる
  const mix = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t,
                            p[2] + (q[2] - p[2]) * t];
  const sstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const WALK = [176, 172, 163];             // 歩道(平板ブロック)
  const STEPS = [150, 146, 138];            // 階段

  // ここから下(6枚の読み出しと420万画素のループ)が焼き上げの 76% を占める
  // (実測 getImageData 519ms + ループ 744ms)。横帯に切ってフレームをまたぐ。
  let y0 = 0;
  const band = () => {
  const h = Math.min(BAND, W - y0);
  const A = lg.getImageData(0, y0, W, h), B = dg.getImageData(0, y0, W, h);
  const R = rg.getImageData(0, y0, W, h), RS = rsg.getImageData(0, y0, W, h);
  const WK = wg.getImageData(0, y0, W, h), PK = pg.getImageData(0, y0, W, h);
  const a = A.data, b = B.data, rr = R.data, rs = RS.data, wv = WK.data;
  const pv = PK.data;
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
      const pgv = pv[i] / 255, pdv = pv[i + 1] / 255, psv = pv[i + 2] / 255;
      if (pgv > 0.01) c = mix(c, PARK, pgv);
      if (pdv > 0.01) c = mix(c, DIRT, pdv);
      // 工事は公園より後(整備中の公園は両方に入っている。今の姿は工事のほう)
      if (psv > 0.01) c = mix(c, SITE, psv);
    }
    const n = 0.88 + Math.random() * 0.24;                // ざらつき
    a[i] = c[0] * n; a[i + 1] = c[1] * n; a[i + 2] = c[2] * n;
  }
  lg.putImageData(A, 0, y0);
  y0 += h;
  return y0 >= W;
  };

  /** 全部の帯を焼き終えてから呼ぶ仕上げ。 */
  const finish = () => {

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
  };

  return { band, finish };
}

// 焼き上げ待ちの行列。tick から時間を区切って進める。
// 一気に焼くとタイル1枚の読み込みで 2.1 秒フリーズする(実測)。
const bakes = [];

/** 焼き上げを budget ミリ秒ぶんだけ進める。 */
function stepBakes(budget = 10) {
  const t0 = performance.now();
  while (bakes.length && performance.now() - t0 < budget) {
    const job = bakes[0];
    if (job.band()) { bakes.shift(); job.done(); }
  }
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
  // 首里城の城内建物も同じ理由で除く。自前の正殿の中に白い箱が刺さる
  const castleRings = (t.data.castle ?? []).map((c) => {
    const r = [];
    for (let i = 0; i < c.f.length; i += 2) {
      r.push(new THREE.Vector2(t.X(c.f[i]), t.Z(c.f[i + 1])));
    }
    return r;
  });
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
    // 城内建物の輪郭に重心が入る建物も飛ばす(自前の造形に置き換える)
    if (castleRings.length) {
      let cx = 0, cz = 0;
      for (const q of ring) { cx += q.x; cz += q.y; }
      cx /= ring.length; cz /= ring.length;
      if (castleRings.some((r) => inRing(r, cx, cz))) { skipped++; continue; }
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

/**
 * obj 以下のジオメトリとマテリアルを解放する。
 * three は remove しても GPU 側を離さないので、タイルを出し入れすると溜まる。
 * 素材(テクスチャ)は共有していることがあるので、map だけは持ち主が要るときに
 * 各自で捨てる(ここでは触らない)。
 */
function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (!m) return;
    for (const one of Array.isArray(m) ? m : [m]) {
      one.map?.dispose?.();
      one.dispose?.();
    }
  });
}

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

  // corridor.json は全線を1本の折れ線で持つ。読み込み済みタイル+余白で切るので、
  // 途中でタイルが抜けていれば複数の線形に割れる。
  for (const raw of (corridor?.rail ?? []).flatMap((f) => clipToLoaded(f))) {
    // 8m 間隔に打ち直す(元データは頂点が疎で、地形に沿わせるため)
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
      // 桁は余白のぶんだけタイルの外へ出る。そこは受け皿(外周の標高を外へ
      // 引き伸ばした帯)で、groundAt もその高さを返すので橋脚は接地する。
      // 立てないと余白のぶんだけ桁が宙に浮いて見える。
      if (!nearLoaded(x, z)) continue;
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
  // 焼き上がるまでは平らな色で見せる(帯ごとに焼くので 1〜2 秒かかる)。
  // 途中の canvas は建物が白抜きの白黒なので、貼らずに待つ
  const gmat = new THREE.MeshLambertMaterial({ color: 0x8f9184 });
  // 近景がぼけないよう、地面のUVを何度も繰り返す細かいノイズを乗算する
  detailMap ??= detailTexture();
  gmat.onBeforeCompile = (sh) => {
    // テクスチャが付く前は vMapUv が無いので、付いてからだけ差し込む
    if (!gmat.map) return;
    sh.uniforms.detailMap = { value: detailMap };
    sh.fragmentShader = 'uniform sampler2D detailMap;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       diffuseColor.rgb *= texture2D(detailMap, vMapUv * ${(TILE / 3).toFixed(1)}).rgb;`
    );
  };
  const job = groundTexture(t);
  bakes.push({ tile: t.key, band: job.band, done: () => {
    gmat.map = job.finish();
    gmat.color.setHex(0xffffff);
    gmat.needsUpdate = true;                 // ここで onBeforeCompile が走り直す
    console.log(`[${t.key}] 地面テクスチャ 焼き上がり`);
  } });
  const ground = new THREE.Mesh(geo, gmat);
  // 地形の頂点Yは標高そのものなので、載せるのは水平位置だけ
  ground.position.set(t.offX, 0, t.offZ);
  ground.receiveShadow = true;
  t.group.add(ground);
  console.log(`[${t.key}] 地形 ${n}×${n} (${cell}m格子)`);
}

// タイルの外側。端が崖に見えないよう、外周の標高をそのまま外へ引き伸ばす(世界に1枚)。
//
// 以前は「平均標高の水平な円盤」を敷いていたが、標高 82.7〜154.0m の街に対して
// 円盤は 112.3m にあり、それより低い所に立つと円盤の裏側が空を覆っていた。
// 歩道網の 41% がその高さより下で、シーサー 10 体中 4 体がその中を歩いていたので、
// 「全部保護する」遊びそのものが壊れていた。
// 外周に沿って高さを拾えば、どこに立っても頭上に板が来ない。
// タイルを足し引きすると縁が動くので、そのつど張り直す。
let skirt = null;
const SEA = 0.0;               // 海面の高さ(m)
const SEA_COL = 0x27606e;

// 海岸線。OSM の natural=coastline は「**進行方向の左が陸・右が海**」という
// 約束の線で、面ではない。海と陸の別は地形からは出せない
// (世界の外周は 80% が標高 0〜12m で、受け皿が 12m 下がると内陸まで海になる)。
// この向きを使って点がどちら側かを見る。
const coast = await fetch('./data/coast.json')
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);

// 線分を升目に配って、最寄りを総当たりしないで済むようにする
const COAST_CELL = 400;
const cmap = new Map();
if (coast) {
  for (const f of coast.lines) {
    for (let i = 0; i + 3 < f.length; i += 2) {
      const seg = [f[i], f[i + 1], f[i + 2], f[i + 3]];
      const gx0 = Math.floor(Math.min(seg[0], seg[2]) / COAST_CELL);
      const gx1 = Math.floor(Math.max(seg[0], seg[2]) / COAST_CELL);
      const gz0 = Math.floor(Math.min(seg[1], seg[3]) / COAST_CELL);
      const gz1 = Math.floor(Math.max(seg[1], seg[3]) / COAST_CELL);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = `${gx},${gz}`;
          (cmap.get(k) ?? cmap.set(k, []).get(k)).push(seg);
        }
      }
    }
  }
  console.log(`海岸線 ${coast.lines.length}本 / 升目 ${cmap.size}`);
}

/**
 * (x,z) が海の側か。
 *
 * いちばん近い海岸線の線分を見つけ、その**右側**なら海。
 * 升目を1つずつ外へ広げながら探し、見つかった半径の外は見ない
 * (近い線分が別の升目にあることがあるので、1周ぶん余分に見る)。
 */
function isSea(x, z) {
  if (!cmap.size) return false;
  const cx = Math.floor(x / COAST_CELL), cz = Math.floor(z / COAST_CELL);
  let best = Infinity, side = 0;
  for (let r = 0; r <= 8; r++) {
    for (let gx = cx - r; gx <= cx + r; gx++) {
      for (let gz = cz - r; gz <= cz + r; gz++) {
        // 外周だけ見る(内側は前の周で見た)
        if (r > 0 && Math.abs(gx - cx) !== r && Math.abs(gz - cz) !== r) continue;
        const segs = cmap.get(`${gx},${gz}`);
        if (!segs) continue;
        for (const [ax, az, bx, bz] of segs) {
          const dx = bx - ax, dz = bz - az;
          const L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
          const qx = ax + t * dx, qz = az + t * dz;
          const d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
          if (d < best) {
            best = d;
            // 外積の符号で左右を見る。OSM は「進行方向の左が陸」だが、
            // この世界は z が南向きで OSM(北が正)と手系が逆なので左右が入れ替わる。
            // 実測でも陸側が一貫して負、沖が正だった(城東小 -398691 / 西の沖 +553024)
            side = dx * (z - az) - dz * (x - ax);
          }
        }
      }
    }
    // 1周ぶん余裕を見てから打ち切る
    if (best < Infinity && r > Math.sqrt(best) / COAST_CELL + 1) break;
  }
  return best < Infinity && side > 0;
}


function buildApron() {
  if (skirt) {
    scene.remove(skirt);
    skirt.geometry.dispose();
    skirt.material.dispose();
    skirt = null;
  }
  const B = worldBounds();
  if (!Number.isFinite(B.minx)) return;
  const OUT = 1500;            // 霧が 1250m で閉じるのでこれで足りる
  const STEP = 20;             // 外周を刻む間隔(m)
  const IN = 0.5;              // 端ちょうどはタイルの引き当てが不安定なので少し内側

  // 外周を反時計回りに一周する閉じた折れ線(角は1回だけ入れる)
  const ring = [];
  const x0 = B.minx + IN, x1 = B.maxx - IN, z0 = B.minz + IN, z1 = B.maxz - IN;
  for (let x = x0; x < x1; x += STEP) ring.push([x, z0]);
  for (let z = z0; z < z1; z += STEP) ring.push([x1, z]);
  for (let x = x1; x > x0; x -= STEP) ring.push([x, z1]);
  for (let z = z1; z > z0; z -= STEP) ring.push([x0, z]);

  // 各頂点の外向きは、隣り合う辺の法線の平均。角も隙間なく広がる(マイター)
  const V = [];
  const n = ring.length;
  const quad = (a, b, c, d) => V.push(...a, ...b, ...c, ...a, ...c, ...d);
  const outAt = (i) => {
    const p = ring[i], q = ring[(i + 1) % n], r = ring[(i - 1 + n) % n];
    const e1 = [p[0] - r[0], p[1] - r[1]], e2 = [q[0] - p[0], q[1] - p[1]];
    const nl = (e) => { const L = Math.hypot(e[0], e[1]) || 1; return [e[1] / L, -e[0] / L]; };
    const a = nl(e1), b = nl(e2);
    const m = [a[0] + b[0], a[1] + b[1]];
    const L = Math.hypot(m[0], m[1]) || 1;
    return [m[0] / L, m[1] / L];
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pi = ring[i], pj = ring[j];
    const yi = groundAt(pi[0], pi[1]), yj = groundAt(pj[0], pj[1]);
    const oi = outAt(i), oj = outAt(j);
    // 外側はゆるく下げる。真っ平らだと地形との継ぎ目が板に見える。
    // ただし**海側だけ**海面より下げる。世界の外周は 80% が標高 0〜12m
    // なので、一律に 12m 下げると内陸側まで海面に浸かる(実測)。
    // 海か陸かは海岸線の向き(左が陸)で決める
    const si = isSea(pi[0] + oi[0] * OUT, pi[1] + oi[1] * OUT);
    const sj = isSea(pj[0] + oj[0] * OUT, pj[1] + oj[1] * OUT);
    const outY = (y, sea) => (sea ? Math.min(SEA - 6, y - 12)
                                  : Math.max(SEA + 1.5, y - 12));
    quad([pi[0], yi, pi[1]], [pj[0], yj, pj[1]],
         [pj[0] + oj[0] * OUT, outY(yj, sj), pj[1] + oj[1] * OUT],
         [pi[0] + oi[0] * OUT, outY(yi, si), pi[1] + oi[1] * OUT]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
  geo.computeVertexNormals();
  skirt = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x7d9159 }));
  // 影は受けない。影カメラは ±105m しかないので、その外側が真っ黒に落ちる
  scene.add(skirt);
  console.log(`受け皿 外周${n}点 / 外へ${OUT}m`);
}
buildApron();

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
  g.userData.beam = beam;      // 探すための目印。見つけ終わったら消す
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
// シーサーはタイルに属さない。タイルを捨てても消さないので、専用の入れ物に置く。
// 分母は最初から世界ぜんぶで決まっている(タイルを読むたびに増えると
// 「ぜんぶ保護する」の目標が動いてしまう)。
const seesaaGroup = new THREE.Group();
scene.add(seesaaGroup);
// シーサーを置き終えたタイル。タイルは出し入れするが、シーサーは捨てないので、
// この覚えが無いと同じタイルに戻るたびに10体ずつ増える(実際に増えた)。
const seesaaDone = new Set();
const SEESAA_TOTAL = N_SEESAA;
// 何体目をどのタイルに置くかは最初に決めておく。
// **タイルに均等ではなく、建物の数で重み付けする**。市域ぜんぶ(84タイル)を
// 均等に配ると6割以上のタイルが空になり、港や埋立地を何分歩いても出会わない。
// 建物の数に比例させると、人が歩く街なかに寄る。
const SEESAA_QUOTA = (() => {
  const tot = WORLD_TILES.reduce((a, t) => a + Math.max(1, t.n), 0);
  const q = new Map();
  let acc = 0, given = 0;
  WORLD_TILES.forEach((t, i) => {
    acc += Math.max(1, t.n);
    // 累積で切ると端数が偏らず、合計がちょうど SEESAA_TOTAL になる
    const upto = Math.floor(acc * SEESAA_TOTAL / tot);
    q.set(`${t.tx},${t.tz}`, upto - given);
    given = upto;
  });
  return q;
})();

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
    const j = (t.rnd() * (i + 1)) | 0;
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
  if (seesaaDone.has(t.key)) return;      // このタイルには置き済み
  seesaaDone.add(t.key);
  const want = SEESAA_QUOTA.get(t.key) ?? 0;
  if (!want) return;                      // このタイルの持ち分は無し
  const spots = roadSpots(t, want);
  let n = 0;
  for (let i = 0; i < want; i++) {
    let placed = spots[i] ?? null;
    if (!placed) {                                   // 道路が無い区画向けの保険
      const ang = (i / Math.max(1, want)) * Math.PI * 2 + t.rnd() * 0.55;
      for (let tries = 0; tries < 260 && !placed; tries++) {
        const rad = 55 + t.rnd() * 330;
        const x = t.offX + Math.cos(ang + (t.rnd() - 0.5) * 0.5) * rad;
        const z = t.offZ + Math.sin(ang + (t.rnd() - 0.5) * 0.5) * rad;
        if (Math.abs(x - t.offX) > HALF - 30 || Math.abs(z - t.offZ) > HALF - 30) continue;
        if (!blocked(x, z, 2.4)) placed = [x, z];
      }
      // それでも空きが無ければ重なりを許して置く。分母(SEESAA_TOTAL)を
      // 満たせないと「ぜんぶ保護」に永久に到達しないため。
      // どのみち seatSeesaa が歩道の上へ乗せ替える
      if (!placed) {
        const rad = 55 + t.rnd() * 330;
        placed = [t.offX + Math.cos(ang) * rad, t.offZ + Math.sin(ang) * rad];
      }
    }
    const [x, z] = placed;
    const g = makeSeesaa();
    addAura(g);
    g.position.set(x, groundAt(x, z), z);
    g.rotation.y = t.rnd() * Math.PI * 2;
    g.userData.taken = false;
    g.userData.tile = t.key;
    // 歩道網に乗せ替えるのは walkLines が揃ってから(seatSeesaa)。ここは仮置き
    seesaaGroup.add(g);
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
  addWalls(t);          // 石垣。addSolid を使うので groundTexture より後
  addCastle(t);         // 首里城の建物
  addHistoric(t);       // 史跡・碑・墓・拝所
  addBusStops(t);
  addSignals(t);
  addShopSigns(t);
  const playSites = playSitesOf(t);
  addTrees(t, playSites);   // 幹は addSolid で固体にする(groundTexture の後)
  addPlayground(t, playSites);
  const sites = siteAreasOf(t);
  addFences(t, sites);      // 仮囲いも addSolid で固体にする
  addMachines(t, sites);    // 重機は仮囲いの後(ゲートの位置とは無関係だが順で読める)
}

// 道路・建物を全タイルぶん先に入れてから地形を焼くと、隣のタイルの建物が
// 縁の敷地色に効いて継ぎ目が目立たない。なので2周に分ける。
for (const t of tiles.values()) { addRoads(t); addBuildings(t); }
for (const t of tiles.values()) buildTileCore(t);
// 歩ける範囲は「読み込み済み」ではなく **世界ぜんぶ**。まだ読んでいない方へ
// 歩けないと、そもそもタイルを足す機会が来ない。
const BOUNDS = WORLD_B;

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
let monorailGroup = buildMonorail();

/** 桁と橋脚を今のタイルに合わせて張り直す。線形(railPaths)も作り直す。 */
function rebuildMonorail() {
  if (monorailGroup) {
    scene.remove(monorailGroup);
    disposeTree(monorailGroup);
  }
  railPaths.length = 0;
  monorailGroup = buildMonorail();
}

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
const stationStops = [];   // 線形の上に乗った駅 {name, q, d, p}

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

/**
 * 駅のホームと階段。桁の高さから床を決めるので数字は自動で合う。
 * 描画も当たり判定も t にぶら下げる(タイルを捨てるとき一緒に消えるように)。
 */
function buildPlatform(q, t) {
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
  addSolid(...at(SIDE, 0), PW, PL, yaw, floorY, t.key);
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
    addSolid(...at(SIDE, oz), 2.6, tread, yaw, top, t.key);
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

  t.group.add(g);
  console.log(`[${t.key}] ホーム: 床 ${floorY.toFixed(1)}m / 地上 ${gnd.toFixed(1)}m / 階段${steps}段`);
}

/**
 * 駅(ホーム＋屋根＋駅名)を今のタイルに合わせて建て直す。
 * 線形上のいちばん近い点に合わせて向きを決める。
 *
 * corridor.json は全16駅を持つので、読み込み済みタイルの上にあるものだけ建てる
 * (タイルの外は地形が縁で埋められた作り物なので、ホームの高さが出鱈目になる)。
 * ホームはタイルの群にぶら下げてあるので、タイルを捨てれば一緒に消える。
 * ここでは「まだ建っていない駅」だけを建てる。
 */
function buildStations() {
  // 線形を作り直すと railPaths の中身が別物になるので、駅も引き直す
  stationStops.length = 0;
  for (const st of corridor?.stations ?? []) {
    const home = tileOf(st.x, st.z);
    if (!home) continue;
    const sx = st.x, sz = st.z;
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
    stationStops.push({ name: st.name, q, d: best.d, p: best.p });
    // ホームは桁の真下に建てるので、駅の点ではなく桁の点が乗るタイルに預ける
    const t = tileOf(q.x, q.z) ?? home;
    if (t.stations?.has(st.name)) continue;      // このタイルには建て済み
    (t.stations ??= new Set()).add(st.name);
    buildPlatform(q, t);
    // 駅舎は PLATEAU の建物として既にある(石嶺駅=17x53m/高さ約16m)。
    // 高架はその中をホーム高さで通り抜けるのが実際の姿なので、
    // 駅舎は建てず、駅名だけを建物の上に出す。
    const lab = makeLabel(`${st.name}駅`);
    lab.position.set(q.x, supportY(q.x, q.z) + 5.5, q.z);
    t.group.add(lab);
    console.log(`[${t.key}] 駅名を設置: ${st.name} (${q.x.toFixed(0)}, ${q.z.toFixed(0)})`);
  }
}
buildStations();

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
      sp.userData.tile = t.key;
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
    // 高さはタイルが読み込まれてから決める(settleCouncil)。ここで決めると、
    // 起動時に読んでいないタイルの地点は縁の標高で埋められて宙に浮く
    // (実測で -6.0m 〜 +26.9m ずれた)
    g.position.set(p.x, 0, p.z);
    g.visible = false;

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

    g.userData = { place: p, board, ring, read: false, placed: false };
    scene.add(g);
    councilPosts.push(g);
  }
  console.log(`市議会の言及 ${councilPosts.length}地点 / ` +
    `${(council.places ?? []).reduce((n, p) => n + p.speeches.length, 0)}発言`);
}

/**
 * 議会マーカーを地表に落とす。タイルが読み込まれた地点だけを一度だけ据える。
 * 据えていない地点は隠す(受け皿の上に光柱が立って見えるため)。
 */
function settleCouncil() {
  let n = 0;
  for (const g of councilPosts) {
    const on = !!tileOf(g.position.x, g.position.z);
    if (on && !g.userData.placed) {
      g.position.y = groundAt(g.position.x, g.position.z);
      g.userData.placed = true;
      n++;
    }
    g.visible = g.userData.placed && on;
  }
  return n;
}

// ---------------------------------------------------------------- 史跡
// OSM の historic。沖縄は **亀甲墓(tomb)と拝所(うがんじゅ / wayside_shrine)** が
// 街のなかに数多く残っていて、これが土地の性格をよく表すので落とさない。
// 議会の言及は朱の光柱、史跡は白木の標柱で見分ける(色も形も変える)。
const historicPosts = [];
// 国指定文化財（文化庁 国指定文化財等データベース）。
// 規約に「文字情報は、出典を記載の上、自由にご利用ください」とあるので使える。
// **画像は個別許諾が要るので取っていない。**
// 国土数値情報の都道府県指定文化財(P32)は「非商用」で再配布できないため使わない
// （バス停の P11 と同じ罠）。
//
// OSM の史跡とどれが同じものかは tools/fetch_heritage.py が突き合わせ済みで、
// `osm` に相手の鍵が入っている。ここでは引くだけ。
// 走りながら近さで当てると「沖縄師範学校跡 → 天女橋」のように別物の由緒が
// 付く（実測）ので、当て方の判断は取得側に置いてある。
const heritageByOsm = new Map();   // 鍵 -> 文化財[]（1つの史跡に複数の指定がある）
const heritageSolo = [];           // OSM に対応の無いもの。独立して標柱を立てる
fetch('./data/heritage.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    for (const h of d?.sites ?? []) {
      if (!h.osm) { heritageSolo.push(h); continue; }
      const a = heritageByOsm.get(h.osm) ?? [];
      a.push(h);
      heritageByOsm.set(h.osm, a);
    }
    // 解説は、名前が史跡そのものを指すもの（「玉陵」＞「玉陵 墓室（西室）」）を選ぶ
    for (const a of heritageByOsm.values()) a.sort((p, q) => p.name.length - q.name.length);
    if (heritageByOsm.size || heritageSolo.length) {
      console.log(`国指定文化財 対応 ${heritageByOsm.size}件 / 独立 ${heritageSolo.length}件（文化庁DB）`);
      addSoloHeritage();
    }
  })
  .catch(() => {});

/** その史跡に付いている国指定文化財。無ければ空配列。 */
function heritageFor(site, x, z) {
  return heritageByOsm.get(`${site.name}|${Math.round(x)}|${Math.round(z)}`) ?? [];
}

function addHistoric(t) {
  const list = t.data.historic ?? [];
  if (!list.length) return;
  const wood = new THREE.MeshLambertMaterial({ color: 0xd8cba8 });   // 白木
  const cap = new THREE.MeshLambertMaterial({ color: 0x4a6b5a });    // 緑青
  for (const h of list) {
    const x = t.X(h.x), z = t.Z(h.z);
    const g = new THREE.Group();
    g.position.set(x, groundAt(x, z), z);
    // 標柱。角柱に笠を載せた、史跡標識のかたち
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.9, 0.16), wood);
    post.position.y = 0.95; post.castShadow = true; g.add(post);
    const hat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.3), cap);
    hat.position.y = 1.95; hat.castShadow = true; g.add(hat);
    // 名前のあるものは大きく、無名の亀甲墓・拝所は小さく控えめに出す
    const lab = makeLabel(h.anon ? h.name : `⛩ ${h.name}`,
                          h.anon ? 3.6 : 7.0, h.anon ? 1.2 : 1.75);
    lab.position.y = h.anon ? 2.4 : 3.0;
    g.add(lab);
    g.userData = { site: h, label: lab, tile: t.key };
    t.group.add(g);
    historicPosts.push(g);
  }
  console.log(`[${t.key}] 史跡 ${list.length}件`);
  addSoloHeritageTo(t);
}

/**
 * OSM に対応の無い国指定文化財を、このタイルに標柱として立てる。
 * OSM の史跡（白木）と混ざらないよう石の柱にする。
 */
function addSoloHeritageTo(t) {
  if (t.hzDone || !heritageSolo.length) return;
  t.hzDone = true;
  const stone = new THREE.MeshLambertMaterial({ color: 0x9aa0a0 });
  const cap = new THREE.MeshLambertMaterial({ color: 0x4a6b5a });   // 緑青
  let n = 0;
  for (const h of heritageSolo) {
    if (Math.round(h.x / TILE) !== t.tx || Math.round(h.z / TILE) !== t.tz) continue;
    const x = h.x, z = h.z;
    const g = new THREE.Group();
    g.position.set(x, groundAt(x, z), z);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.1, 0.22), stone);
    post.position.y = 1.05; post.castShadow = true; g.add(post);
    const hat = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.4), cap);
    hat.position.y = 2.16; hat.castShadow = true; g.add(hat);
    const lab = makeLabel(`⛩ ${h.name}`, 7.0, 1.75);
    lab.position.y = 3.2;
    g.add(lab);
    g.userData = { site: h, label: lab, tile: t.key, solo: true };
    t.group.add(g);
    historicPosts.push(g);
    n++;
  }
  if (n) console.log(`[${t.key}] 国指定文化財 ${n}件`);
}

/** 文化財が史跡より後に届いたとき、読み込み済みのタイルに後追いで立てる。 */
function addSoloHeritage() {
  for (const t of tiles.values()) addSoloHeritageTo(t);
}

/** 捨てたタイルの史跡を登録簿から外す。 */
function dropHistoric(key) {
  for (let i = historicPosts.length - 1; i >= 0; i--) {
    if (historicPosts[i].userData.tile === key) historicPosts.splice(i, 1);
  }
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

// ---------------------------------------------------------------- 首里城の石垣
// 首里城の姿を決めているのは正殿より石垣(城郭)。OSM に線形が入っているが
// **高さのタグは 1 件も無い**ので、地形から起こす。
//
// 石垣は「高い側の地面を、低い側から支える」擁壁なので、**線の左右を直交方向に
// 測って段差を取る**。天端 = 高い側 + 立ち上がり、足元 = 低い側。
//
// 線に沿った半径で最大値を取る方式も試したが、最大 5.6m にしかならなかった。
// PLATEAU の DEM は 5m 格子なので擁壁の段差が 2〜3 セルに均されてしまい、
// 線上をいくら探しても本来の高さが出ない。左右 9m を見ると最大 9.8m・
// 中央 1.8m になり、実際の首里城の高石垣(10〜14m)と釣り合う。
const WALL_T = 1.9;          // 石垣の厚み(m)
const WALL_PROBE = 9;        // 左右に測る距離(m)。大きいほど斜面を石垣に見立てる
const WALL_LIP = 1.2;        // 天端の立ち上がり(m)。平らな所でもこれだけは立つ
const WALL_MAX = 14;         // 見せる高さの上限(m)。DEM の外れ値で塔にしない
const WALL_BATTER = 0.16;    // 上に行くほど痩せる割合(石垣の勾配)

// 相方積み(あいかたづみ)の質感。琉球石灰岩を多角形に加工して隙間なく噛ませる
// 積み方で、日本本土の布積み(水平の目地が通る)とは見た目が違う。
// 目地が通らないよう、格子を大きく揺らした多角形で敷く。
let wallMap = null;
function wallTexture() {
  const W = 256;
  const c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d');
  g.fillStyle = '#6d6455';                 // 目地(影)
  g.fillRect(0, 0, W, W);
  // 種を固定して毎回同じ石にする(タイルを出し入れしても変わらない)
  let sd = 8675309;
  const r = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // 格子が細かく揃うと本土の布積み(水平の目地が通る)に見える。
  // 目が粗いほど、大きな石を噛ませた相方積みに近づく
  const NX = 4, NY = 4, cw = W / NX, ch = W / NY;
  // 格子点を揺らし、その四隅を結んだ多角形を石にする。上下左右で繋がるよう
  // 端の揺らぎは反対側と共有する
  const jx = [], jy = [];
  for (let i = 0; i <= NX; i++) {
    jx.push([]); jy.push([]);
    for (let j = 0; j <= NY; j++) {
      const ex = (i === 0 || i === NX), ey = (j === 0 || j === NY);
      // 0.7 より大きくすると多角形が反転して石が裏返る
      jx[i].push(ex ? 0 : (r() - 0.5) * cw * 0.70);
      jy[i].push(ey ? 0 : (r() - 0.5) * ch * 0.70);
    }
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NY; j++) {
      const P = (a, b) => [a * cw + jx[a][b], b * ch + jy[a][b]];
      const pts = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
      // 石ごとに明るさを振る。日に焼けた白茶〜灰白
      const l = 0.60 + r() * 0.30;
      g.fillStyle = `hsl(${38 + r() * 14}, ${9 + r() * 10}%, ${(l * 100) | 0}%)`;
      g.beginPath();
      pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill();
      // 面のざらつき
      for (let k = 0; k < 26; k++) {
        g.fillStyle = `rgba(0,0,0,${r() * 0.07})`;
        const [x, y] = pts[0];
        g.fillRect(x + r() * cw * 0.8, y + r() * ch * 0.8, 2, 2);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAXANISO;
  return tex;
}

function addWalls(t) {
  const ways = t.data.walls ?? [];
  if (!ways.length) return;
  const V = [], N = [], UV = [];
  // UV は u=石垣に沿った距離 / v=高さ。石ひとつが約 1.2m になるよう 3m で1周
  const UVS = 1 / 4.4;
  const push = (p, n, u, v) => {
    V.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); UV.push(u, v);
  };
  const quad = (a, b, c, d, n, ua, ub, va0, va1, vb0, vb1) => {
    push(a, n, ua, va0); push(b, n, ub, vb0); push(c, n, ub, vb1);
    push(a, n, ua, va0); push(c, n, ub, vb1); push(d, n, ua, va1);
  };
  let nseg = 0, run = 0;

  for (const w of ways) {
    // 2m 間隔に打ち直す(地形の起伏を拾うため)
    const raw = [];
    for (let i = 0; i < w.f.length; i += 2) raw.push([t.X(w.f[i]), t.Z(w.f[i + 1])]);
    const pts = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const [ax, az] = raw[i], [bx, bz] = raw[i + 1];
      const d = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.round(d / 2));
      for (let k = 0; k < steps; k++) {
        const u = k / steps;
        pts.push([ax + (bx - ax) * u, az + (bz - az) * u]);
      }
    }
    pts.push(raw[raw.length - 1]);
    if (pts.length < 2) continue;

    // 各点で線に直交する向きへ WALL_PROBE だけ離れた地形を左右とも見る。
    // 高い側が石垣が支えている地面、低い側が石垣の面が現れる側。
    const g = [], hi = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const [x, z] = pts[i];
      const gl = groundAt(x + dz * WALL_PROBE, z - dx * WALL_PROBE);
      const gr = groundAt(x - dz * WALL_PROBE, z + dx * WALL_PROBE);
      g.push(Math.min(gl, gr, groundAt(x, z)));
      hi.push(Math.max(gl, gr) + WALL_LIP);
    }
    // 天端は移動平均でならす。石垣の天端は水平に近く、ならさないと段々になる
    const top = hi.map((_, i) => {
      let sum = 0, c = 0;
      for (let k = Math.max(0, i - 6); k <= Math.min(hi.length - 1, i + 6); k++) {
        sum += hi[k]; c++;
      }
      return sum / c;
    });

    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const px = dz, pz = -dx;                       // 線形に直交
      // 足元は地形。天端との差が上限を超えたら足元を持ち上げて切る
      const ay0 = Math.max(g[i], top[i] - WALL_MAX);
      const by0 = Math.max(g[i + 1], top[i + 1] - WALL_MAX);
      const ay1 = top[i], by1 = top[i + 1];
      if (ay1 - ay0 < 0.2 && by1 - by0 < 0.2) continue;
      const hw = WALL_T / 2;
      const hwT = hw * (1 - WALL_BATTER);            // 天端は少し痩せる
      const P = (x, z, y, o) => [x + px * o, y, z + pz * o];
      const u0 = run * UVS, u1 = (run + L) * UVS;
      // 高さ方向の UV は「足元を 0」にする。天端を 0 にすると、地面の起伏で
      // 石の目地が波打って積んだように見えない
      const va0 = 0, va1 = (ay1 - ay0) * UVS;
      const vb0 = 0, vb1 = (by1 - by0) * UVS;
      // 左右の面
      quad(P(ax, az, ay0, hw), P(bx, bz, by0, hw), P(bx, bz, by1, hwT), P(ax, az, ay1, hwT),
           [px, 0, pz], u0, u1, va0, va1, vb0, vb1);
      quad(P(ax, az, ay1, -hwT), P(bx, bz, by1, -hwT), P(bx, bz, by0, -hw), P(ax, az, ay0, -hw),
           [-px, 0, -pz], u0, u1, va1, va0, vb1, vb0);
      // 天端
      quad(P(ax, az, ay1, -hwT), P(bx, bz, by1, -hwT), P(bx, bz, by1, hwT), P(ax, az, ay1, hwT),
           [0, 1, 0], u0, u1, 0, WALL_T * UVS, 0, WALL_T * UVS);
      run += L;
      // 当たり判定。天端に乗れる(石垣の上は歩けないが、抜けられては困る)
      addSolid((ax + bx) / 2, (az + bz) / 2, WALL_T, L + 0.4,
               Math.atan2(dx, dz), (ay1 + by1) / 2, t.key);
      nseg++;
    }
  }
  if (!V.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  // 琉球石灰岩。日に焼けた白茶
  wallMap ??= wallTexture();
  const mesh = new THREE.Mesh(geo,
    new THREE.MeshLambertMaterial({ map: wallMap, color: 0xd8cdb2 }));
  mesh.castShadow = mesh.receiveShadow = true;
  t.group.add(mesh);
  console.log(`[${t.key}] 石垣 ${ways.length}本 / ${nseg}区間 / ${V.length / 3}頂点`);
}

// ---------------------------------------------------------------- 正殿の造形
// 首里城 正殿。造形は Antigravity(agy)に契約を渡して書かせたものを検分して取り込んだ。
// シーサーと同じやり方で、外部アセットもローダーも増やさずに済む。
//
// 契約: 関数名 makeSeiden() / 原点=底面の中心・すべて y>=0 / 正面=-Z /
//       桁行28.75m × 梁間21.26m × 総高18.0m(内閣府沖縄総合事務局の復元設計) /
//       基本形状のみ・外部ファイル禁止 / Math.random 禁止 / メッシュ120個以内 /
//       MeshLambertMaterial のみ / castShadow 必須。
//       入れるもの: 二重三階の入母屋 / 唐破風の向拝 / 赤瓦 / 朱塗り /
//                   大龍柱2本 / 龍頭棟飾 / 正面の石階段。
// 検分: 契約違反ゼロ。メッシュ55個(うち InstancedMesh 13)。
//
// 建てるのは **2019年10月の火災で焼失する前の姿**(平成の復元)。OSM の輪郭も
// PLATEAU の計測もその時点のものなので、これだと数字が突き合わせられる。

/**
 * 首里城 正殿（2019年焼失前の平成復元姿）を生成する関数。
 * 
 * 【主要寸法（内閣府沖縄総合事務局 復元設計書拠）】
 * - 桁行（X方向全幅）: 28.75 m
 * - 梁間（Z方向全奥行）: 21.26 m (向拝張り出しは前(-Z)へ約6.5m)
 * - 総高（地面から龍頭棟飾天まで）: 18.0 m
 * - 原点: 建物の底面中心 (y >= 0)
 * - 正面: -Z 方向（向拝・大龍柱・石階段が配置される側）
 */
function makeSeiden() {
  const g = new THREE.Group();

  // -------------------------------------------------------------
  // マテリアル定義（規定の琉球伝統配色に合わせ使い回すことで描画負荷を低減）
  // -------------------------------------------------------------
  // 朱塗り (柱・梁・壁・唐破風など正殿の主色)
  const matRed = new THREE.MeshLambertMaterial({ color: 0xb03a26 });
  // 沖縄赤瓦 (朱に近い赤褐色)
  const matRoof = new THREE.MeshLambertMaterial({ color: 0xa8442c });
  // 漆喰目地・白壁 (赤瓦の目地や3階装飾)
  const matWhite = new THREE.MeshLambertMaterial({ color: 0xe8e0d0 });
  // 石造 (基壇・正面石階段・大龍柱の素材)
  const matStone = new THREE.MeshLambertMaterial({ color: 0xc9c0aa });
  // 金の装飾 (雲形・龍の目や爪・破風の飾金具)
  const matGold = new THREE.MeshLambertMaterial({ color: 0xc9a227 });
  // 黒塗り (腰壁・破風の縁取り・大棟)
  const matBlack = new THREE.MeshLambertMaterial({ color: 0x2a2320 });

  // 影の設定とメッシュ計測用ヘルパー関数
  let totalMeshCount = 0;

  function addMesh(geometry, material, receiveShadow = false) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    if (receiveShadow) mesh.receiveShadow = true;
    g.add(mesh);
    totalMeshCount++;
    return mesh;
  }

  // 大量の柱や丸瓦をメッシュ数上限（120個）以内で表現するための InstancedMesh ヘルパー
  function addInstancedMesh(geometry, material, count, setupFn, receiveShadow = false) {
    const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
    instancedMesh.castShadow = true;
    if (receiveShadow) instancedMesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      setupFn(dummy, i);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(i, dummy.matrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
    g.add(instancedMesh);
    totalMeshCount++;
    return instancedMesh;
  }

  // =============================================================
  // 1. 基壇および正面石階段（石造: c9c0aa）
  // 寸法根拠: 28.75m×21.26mの身屋を支える高さ1.2mの石造基壇と御庭へ向かう階段
  // =============================================================
  // 主基壇 (y=0.0 ~ 1.2m)
  const baseGeo = new THREE.BoxGeometry(29.5, 1.2, 22.0);
  baseGeo.translate(0, 0.6, 0);
  addMesh(baseGeo, matStone, true);

  // 正面中央石階段 (向拝の下から御庭-Z方向へ伸びる)
  const stairGeo = new THREE.BoxGeometry(7.5, 1.2, 6.5);
  stairGeo.translate(0, 0.6, -13.88);
  addMesh(stairGeo, matStone, true);

  // 階段左右の高欄（手すり）
  const railLGeo = new THREE.BoxGeometry(0.5, 1.6, 6.5);
  railLGeo.translate(-4.0, 0.8, -13.88);
  addMesh(railLGeo, matStone);

  const railRGeo = new THREE.BoxGeometry(0.5, 1.6, 6.5);
  railRGeo.translate(4.0, 0.8, -13.88);
  addMesh(railRGeo, matStone);

  // 大龍柱の台座 (階段前左右 X=±2.3m, Z=-16.0m)
  const baseLGeo = new THREE.BoxGeometry(1.2, 0.6, 1.2);
  baseLGeo.translate(-2.3, 0.3, -16.0);
  addMesh(baseLGeo, matStone, true);

  const baseRGeo = new THREE.BoxGeometry(1.2, 0.6, 1.2);
  baseRGeo.translate(2.3, 0.3, -16.0);
  addMesh(baseRGeo, matStone, true);

  // =============================================================
  // 2. 下層・中層 (1階・2階) 身屋（桁行28.75m, 梁間21.26m）
  // 寸法根拠: 幅28.75m, 奥行21.26m, 高さ6.0m (y=1.2~7.2m)
  // =============================================================
  // 朱塗りの胴体壁
  const bodyGeo = new THREE.BoxGeometry(28.75, 6.0, 21.26);
  bodyGeo.translate(0, 4.2, 0);
  addMesh(bodyGeo, matRed);

  // 1階正面御門の黒・金装飾長押
  const frontWallGeo = new THREE.BoxGeometry(28.0, 2.5, 0.2);
  frontWallGeo.translate(0, 2.45, -10.64);
  addMesh(frontWallGeo, matBlack);

  const frontGoldGeo = new THREE.BoxGeometry(12.0, 0.4, 0.25);
  frontGoldGeo.translate(0, 3.2, -10.65);
  addMesh(frontGoldGeo, matGold);

  // 桁行11間・梁間7間の朱塗り柱列 (InstancedMeshで1メッシュ化)
  // 正面11本 + 背面11本 + 側面左右10本 = 32本
  const colGeo = new THREE.CylinderGeometry(0.24, 0.24, 6.0, 12);
  const columnPositions = [];
  for (let i = 0; i < 11; i++) {
    const x = -13.5 + i * (27.0 / 10);
    columnPositions.push([x, 4.2, -10.7]); // 正面
    columnPositions.push([x, 4.2, 10.7]);  // 背面
  }
  for (let i = 1; i <= 5; i++) {
    const z = -10.0 + i * (20.0 / 6);
    columnPositions.push([-14.4, 4.2, z]); // 左側面
    columnPositions.push([14.4, 4.2, z]);  // 右側面
  }
  addInstancedMesh(colGeo, matRed, columnPositions.length, (dummy, i) => {
    dummy.position.set(...columnPositions[i]);
  });

  // =============================================================
  // 3. 下層屋根（一重屋根・入母屋造の下層部）
  // 寸法根拠: 桁行28.75m・梁間21.26mより軒出各約0.875m出張り、幅30.5m×奥行23.0m
  // 高さ2.4m (y=7.2~9.6m)
  // =============================================================
  // 下層屋根本体（四角錐台）
  const lowerRoofGeo = new THREE.CylinderGeometry(17.0, 21.5, 2.4, 4);
  lowerRoofGeo.rotateY(Math.PI / 4);
  lowerRoofGeo.scale(30.5 / 30.4, 1.0, 23.0 / 30.4);
  lowerRoofGeo.translate(0, 8.4, 0);
  addMesh(lowerRoofGeo, matRoof, true);

  // 下層軒下の朱塗り長押
  const eaveGeo = new THREE.BoxGeometry(29.8, 0.4, 22.3);
  eaveGeo.translate(0, 7.3, 0);
  addMesh(eaveGeo, matRed);

  // 【取り込み時に落とした】下層屋根の丸瓦。長さ15mの円柱を屋根面に並べる作りで、
  // 実機で見ると屋根を突き抜けて軒の外へ櫛のように飛び出していた。

  // =============================================================
  // 4. 上層 (3階) 身屋
  // 寸法根拠: 下層より一回り小さく桁行22.0m×梁間15.0m, 高さ3.4m (y=9.6~13.0m)
  // =============================================================
  const upperBodyGeo = new THREE.BoxGeometry(22.0, 3.4, 15.0);
  upperBodyGeo.translate(0, 11.3, 0);
  addMesh(upperBodyGeo, matRed);

  // 3階の白壁長押帯
  const upperDecorGeo = new THREE.BoxGeometry(22.2, 0.8, 15.2);
  upperDecorGeo.translate(0, 12.2, 0);
  addMesh(upperDecorGeo, matWhite);

  // 3階柱列 (16本)
  const upperColPositions = [];
  for (let i = 0; i < 8; i++) {
    const x = -10.0 + i * (20.0 / 7);
    upperColPositions.push([x, 11.3, -7.6]);
    upperColPositions.push([x, 11.3, 7.6]);
  }
  const upperColGeo = new THREE.CylinderGeometry(0.2, 0.2, 3.4, 10);
  addInstancedMesh(upperColGeo, matRed, upperColPositions.length, (dummy, i) => {
    dummy.position.set(...upperColPositions[i]);
  });

  // =============================================================
  // 5. 上層屋根（二重目・入母屋造頂部屋根）
  // 寸法根拠: 桁行24.5m, 梁間17.5m, 大棟頂部y=16.8m (y=13.0~16.8m, 高さ3.8m)
  // ExtrudeGeometryで入母屋の屋根勾配断面を作成
  // =============================================================
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-8.75, 0);
  roofShape.lineTo(-1.5, 3.8);
  roofShape.lineTo(1.5, 3.8);
  roofShape.lineTo(8.75, 0);
  roofShape.closePath();

  const upperRoofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 24.5, bevelEnabled: false });
  upperRoofGeo.rotateY(Math.PI / 2);
  upperRoofGeo.translate(0, 13.0, 12.25);
  addMesh(upperRoofGeo, matRoof, true);

  // 東西両端の入母屋破風（切妻三角妻壁）
  const gableShape = new THREE.Shape();
  gableShape.moveTo(-7.0, 0);
  gableShape.lineTo(0, 3.2);
  gableShape.lineTo(7.0, 0);
  gableShape.closePath();

  const gableGeoL = new THREE.ExtrudeGeometry(gableShape, { depth: 0.3, bevelEnabled: false });
  gableGeoL.rotateY(Math.PI / 2);
  gableGeoL.translate(-12.26, 13.5, 0);
  addMesh(gableGeoL, matRed);

  const gableGeoR = new THREE.ExtrudeGeometry(gableShape, { depth: 0.3, bevelEnabled: false });
  gableGeoR.rotateY(Math.PI / 2);
  gableGeoR.translate(12.26, 13.5, 0);
  addMesh(gableGeoR, matRed);

  // 破風中央の金の懸魚（げぎょ）飾り
  const gegyoGeoL = new THREE.SphereGeometry(0.6, 8, 8);
  gegyoGeoL.scale(0.3, 1.2, 1.0);
  gegyoGeoL.translate(-12.45, 15.0, 0);
  addMesh(gegyoGeoL, matGold);

  const gegyoGeoR = new THREE.SphereGeometry(0.6, 8, 8);
  gegyoGeoR.scale(0.3, 1.2, 1.0);
  gegyoGeoR.translate(12.45, 15.0, 0);
  addMesh(gegyoGeoR, matGold);

  // 上層大棟 (最頂部の黒・金の化粧棟)
  const ridgeGeo = new THREE.BoxGeometry(24.0, 0.4, 1.2);
  ridgeGeo.translate(0, 16.6, 0);
  addMesh(ridgeGeo, matBlack);

  const ridgeGoldGeo = new THREE.BoxGeometry(22.0, 0.15, 0.8);
  ridgeGoldGeo.translate(0, 16.8, 0);
  addMesh(ridgeGoldGeo, matGold);

  // 【取り込み時に落とした】上層屋根の丸瓦。長さ10mの円柱を屋根面に並べる作りで、
  // 実機で見ると屋根を突き抜けて軒の外へ櫛のように飛び出していた。
  // 屋根の勾配に沿わせ直すより、この縮尺では平らな赤瓦面のままの方が正しく見える。

  // =============================================================
  // 6. 龍頭棟飾（りゅうとうむなかざり）
  // 寸法根拠: 大棟両端(X=±11.5m, Z=0)に載る高1.2mの龍頭。地面から頂点までぴったり18.0m
  // =============================================================
  function createRyuto(xSign) {
    const x = xSign * 11.5;
    // 台座
    const ryutoBase = new THREE.BoxGeometry(0.8, 0.3, 0.8);
    ryutoBase.translate(x, 16.95, 0);
    addMesh(ryutoBase, matStone);

    // 頭部
    const ryutoHead = new THREE.SphereGeometry(0.45, 8, 8);
    ryutoHead.scale(1.0, 1.2, 1.4);
    ryutoHead.translate(x, 17.45, 0);
    addMesh(ryutoHead, matRed);

    // 角・宝珠 (最高点 y=18.0m)
    const ryutoHorn = new THREE.ConeGeometry(0.25, 0.7, 8);
    ryutoHorn.translate(x, 17.65, 0);
    addMesh(ryutoHorn, matGold);
  }
  createRyuto(-1); // 左龍頭棟飾
  createRyuto(1);  // 右龍頭棟飾

  // =============================================================
  // 7. 正面中央の唐破風（からはふ）の向拝（こうはい）
  // 寸法根拠: 正面(-Z)へ3間(約6.5m)張り出す (Z=-10.63m~-17.13m)
  // 首里城正殿最大の識別点であるゆるやかなS字（起りと反り）を描く弓形唐破風
  // =============================================================
  // 向拝柱 4本
  const kohaiColGeo = new THREE.CylinderGeometry(0.26, 0.26, 6.0, 12);
  const kohaiCols = [
    [-3.8, 4.2, -16.8], [3.8, 4.2, -16.8],
    [-3.8, 4.2, -11.5], [3.8, 4.2, -11.5]
  ];
  addInstancedMesh(kohaiColGeo, matRed, 4, (dummy, i) => {
    dummy.position.set(...kohaiCols[i]);
  });

  // 向拝床/階 (y=1.2m)
  const kohaiFloor = new THREE.BoxGeometry(8.2, 0.3, 6.0);
  kohaiFloor.translate(0, 1.35, -13.88);
  addMesh(kohaiFloor, matRed, true);

  // 向拝極彩色梁
  const kohaiBeam = new THREE.BoxGeometry(8.4, 0.6, 6.2);
  kohaiBeam.translate(0, 7.0, -13.88);
  addMesh(kohaiBeam, matRed);

  const kohaiBeamGold = new THREE.BoxGeometry(8.6, 0.2, 0.3);
  kohaiBeamGold.translate(0, 6.8, -16.9);
  addMesh(kohaiBeamGold, matGold);

  // 唐破風屋根（S字弓形曲線・Shape + ExtrudeGeometry）
  const karaShape = new THREE.Shape();
  karaShape.moveTo(-4.2, 0.0);
  karaShape.quadraticCurveTo(-4.1, 0.4, -3.8, 0.5); // 左端の反り
  karaShape.quadraticCurveTo(-2.0, 1.6, 0, 1.8);    // 中央への起り
  karaShape.quadraticCurveTo(2.0, 1.6, 3.8, 0.5);   // 右への下がり
  karaShape.quadraticCurveTo(4.1, 0.4, 4.2, 0.0);   // 右端の反り
  karaShape.lineTo(4.1, -0.25);
  karaShape.quadraticCurveTo(2.0, 1.35, 0, 1.55);
  karaShape.quadraticCurveTo(-2.0, 1.35, -4.1, -0.25);
  karaShape.closePath();

  const karaExtrude = new THREE.ExtrudeGeometry(karaShape, { depth: 6.5, bevelEnabled: false });
  karaExtrude.translate(0, 7.2, -17.13);
  addMesh(karaExtrude, matRoof, true);

  // 唐破風正面前縁の黒塗り破風板
  const karaFrontEdge = new THREE.ExtrudeGeometry(karaShape, { depth: 0.15, bevelEnabled: false });
  karaFrontEdge.translate(0, 7.2, -17.14);
  addMesh(karaFrontEdge, matBlack);

  // 唐破風頂部の金懸魚 (兎毛通し)
  const gegyoGold = new THREE.SphereGeometry(0.5, 8, 8);
  gegyoGold.scale(1.2, 1.0, 0.4);
  gegyoGold.translate(0, 8.4, -17.15);
  addMesh(gegyoGold, matGold);

  // 【取り込み時に落とした】向拝屋根の丸瓦。上層と同じく突き抜けていた。

  // =============================================================
  // 8. 大龍柱（だいりゅうちゅう・正面階段両脇の石造龍巻き柱）
  // 寸法根拠: 高さ約4.1m (y=1.2m~5.3m), 2本, 位置 X=±2.3m, Z=-16.0m
  // 灰白色石造 (matStone: c9c0aa) + 金の目・牙 (matGold: c9a227)
  // =============================================================
  function createDairyuChu(xSign) {
    const x = xSign * 2.3;
    const z = -16.0;

    // 主柱
    const chuGeo = new THREE.CylinderGeometry(0.28, 0.32, 4.1, 12);
    chuGeo.translate(x, 3.25, z);
    addMesh(chuGeo, matStone);

    // 柱に巻き付く龍の身（螺旋状に巻きつく立体感表現）
    const bodyPositions = [
      [x + xSign * 0.15, 1.9, z + 0.15, 0.4],
      [x - xSign * 0.1, 2.9, z - 0.15, -0.3],
      [x + xSign * 0.15, 3.9, z + 0.15, 0.4],
      [x - xSign * 0.1, 4.8, z - 0.1, -0.2]
    ];
    for (let b of bodyPositions) {
      const ringGeo = new THREE.TorusGeometry(0.32, 0.14, 8, 12);
      ringGeo.rotateX(Math.PI / 3 * (b[3] > 0 ? 1 : -1));
      ringGeo.translate(b[0], b[1], b[2]);
      addMesh(ringGeo, matStone);
    }

    // 龍の頭部 (-Z方向を睨む彫刻)
    const headGeo = new THREE.SphereGeometry(0.38, 8, 8);
    headGeo.scale(0.9, 1.1, 1.4);
    headGeo.translate(x, 4.9, z - 0.25);
    addMesh(headGeo, matStone);

    // 龍の開いた口・角・牙 (金)
    const jawGeo = new THREE.ConeGeometry(0.25, 0.6, 8);
    jawGeo.rotateX(-Math.PI / 3);
    jawGeo.translate(x, 4.75, z - 0.45);
    addMesh(jawGeo, matGold);

    // 龍の目 (金)
    const eyeGeoL = new THREE.SphereGeometry(0.08, 6, 6);
    eyeGeoL.translate(x - 0.15, 5.0, z - 0.35);
    addMesh(eyeGeoL, matGold);

    const eyeGeoR = new THREE.SphereGeometry(0.08, 6, 6);
    eyeGeoR.translate(x + 0.15, 5.0, z - 0.35);
    addMesh(eyeGeoR, matGold);
  }

  createDairyuChu(-1); // 左大龍柱
  createDairyuChu(1);  // 右大龍柱

  return g;
}

// メッシュ数: 55

// ---------------------------------------------------------------- 首里城の建物
// 城内の建物は PLATEAU の LOD1(輪郭の押し出し)では白い箱にしかならないので、
// OSM の輪郭で位置と向きを取り、赤瓦の寄棟屋根を自前で載せる。
// 正殿だけは別格の造形(makeSeiden)を使う。
//
// 寸法の根拠: 正殿は内閣府沖縄総合事務局の復元設計で
// 桁行下層 28.749m × 梁間下層 21.257m / 総高 18m(龍頭棟飾まで)。
// OSM の輪郭(50.4×24.0m)は付属部分まで含んだ広めの取り方なので、
// **位置と向きだけ OSM から取り、建物の寸法は設計の数字に合わせる**。
// 軒までの壁の高さ(m)。琉球の建物は **壁が低く屋根が深い**ので、
// 実測の総高からそのまま壁を立てると赤い箱に見える(実機で見て直した)。
const CASTLE_H = {
  '北殿': 4.6, '南殿・番所': 4.4, '南殿': 4.4, '番所': 3.8,
  '奉神門': 5.2, '広福門': 4.2,
};

/** 輪郭から、主軸に沿った中心・幅・奥行・向きを出す。 */
function footprintFrame(ring) {
  let cx = 0, cz = 0;
  for (const [x, z] of ring) { cx += x; cz += z; }
  cx /= ring.length; cz /= ring.length;
  // 面積最小の外接矩形を探す(建物は斜めを向いているので回さないと測れない)
  let best = null;
  for (let a = 0; a < 90; a++) {
    const t = a * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      const u = (x - cx) * c - (z - cz) * sn, v = (x - cx) * sn + (z - cz) * c;
      if (u < x0) x0 = u; if (u > x1) x1 = u;
      if (v < z0) z0 = v; if (v > z1) z1 = v;
    }
    const area = (x1 - x0) * (z1 - z0);
    if (!best || area < best.area) best = { area, w: x1 - x0, d: z1 - z0, yaw: -t };
  }
  return { cx, cz, ...best };
}

/** 赤瓦の寄棟屋根(城内の脇殿・門に使う簡素な版)。 */
function castleRoof(w, d, eave, mats) {
  const g = new THREE.Group();
  // 軒の出も屋根の高さも大きく取る。0.22 では 40m の長い建物が
  // 平らな赤いスラブに見えた(実機で確認)
  const OVER = 2.4;                       // 軒の出(m)。深い軒が沖縄の建物らしさ
  const rise = Math.min(Math.min(w, d) * 0.52, 6.5);   // 屋根の高さ
  const W = w / 2 + OVER, D = d / 2 + OVER;
  const rw = w * 0.22, rd = 0;            // 大棟の長さ(寄棟なので稜線が短い)
  const V = [], N = [];
  const tri = (a, b, c) => {
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
    const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx/=L; ny/=L; nz/=L;
    for (const p of [a, b, c]) { V.push(p[0], p[1], p[2]); N.push(nx, ny, nz); }
  };
  const A = [-W, 0, -D], B = [W, 0, -D], C = [W, 0, D], Dd = [-W, 0, D];
  const R0 = [-rw / 2, rise, rd], R1 = [rw / 2, rise, rd];
  tri(A, B, R1); tri(A, R1, R0);          // 前
  tri(C, Dd, R0); tri(C, R0, R1);         // 後
  tri(B, C, R1);                          // 右
  tri(Dd, A, R0);                         // 左
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  const m = new THREE.Mesh(geo, mats.tile);
  m.position.y = eave;
  m.castShadow = m.receiveShadow = true;
  g.add(m);
  // 大棟(白漆喰)。沖縄の赤瓦は棟を漆喰で固めるので白い線が入る
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(rw + 0.6, 0.5, 0.7), mats.plaster);
  ridge.position.set(0, eave + rise + 0.1, rd);
  ridge.castShadow = true;
  g.add(ridge);
  return g;
}

function addCastle(t) {
  const list = t.data.castle ?? [];
  if (!list.length) return;
  // 正殿は御庭(西側)を向く。輪郭の主軸から取った向きだと背を向けることがある
  // (実機で見たら唐破風も大龍柱も裏側だった)。御庭の正面にある奉神門を狙う。
  const facing = list.find((c) => c.name === '奉神門');
  let faceX = null, faceZ = null;
  if (facing) {
    let x = 0, z = 0, n = 0;
    for (let i = 0; i < facing.f.length; i += 2) {
      x += t.X(facing.f[i]); z += t.Z(facing.f[i + 1]); n++;
    }
    faceX = x / n; faceZ = z / n;
  }
  const mats = {
    tile: new THREE.MeshLambertMaterial({ color: 0xa8442c }),      // 赤瓦
    wall: new THREE.MeshLambertMaterial({ color: 0xb03a26 }),      // 朱塗り
    plaster: new THREE.MeshLambertMaterial({ color: 0xe8e0d0 }),   // 白漆喰
    stone: new THREE.MeshLambertMaterial({ color: 0xc9c0aa }),     // 石の基壇
  };
  for (const c of list) {
    const ring = [];
    for (let i = 0; i < c.f.length; i += 2) ring.push([t.X(c.f[i]), t.Z(c.f[i + 1])]);
    const f = footprintFrame(ring);
    const gy = groundAt(f.cx, f.cz);
    const g = new THREE.Group();
    g.position.set(f.cx, gy, f.cz);
    // 造形の正面は -Z。対象を向く yaw は atan2(-Δx, -Δz)
    g.rotation.y = (c.name === '正殿' && faceX !== null)
      ? Math.atan2(-(faceX - f.cx), -(faceZ - f.cz))
      : f.yaw;

    if (c.name === '正殿') {
      // 寸法は復元設計の数字。OSM の輪郭は広すぎるので使わない
      g.add(makeSeiden());
    } else {
      const h = CASTLE_H[c.name] ?? 6.5;
      const w = f.w, d = f.d;
      // 基壇
      const base = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.8, d + 1.2), mats.stone);
      base.position.y = 0.4;
      base.castShadow = base.receiveShadow = true;
      g.add(base);
      // 軸部(朱塗り)。屋根が深いので壁は軒より一回り内側にする
      const body = new THREE.Mesh(new THREE.BoxGeometry(w - 1.0, h, d - 1.0), mats.wall);
      body.position.y = 0.8 + h / 2;
      body.castShadow = body.receiveShadow = true;
      g.add(body);
      // 白漆喰の腰壁。赤一色の箱に見えるのを避ける
      const skirt = new THREE.Mesh(
        new THREE.BoxGeometry(w - 0.9, 1.0, d - 0.9), mats.plaster);
      skirt.position.y = 1.3;
      skirt.castShadow = true;
      g.add(skirt);
      g.add(castleRoof(w, d, 0.8 + h, mats));
    }
    // 建物の中に入られないよう固体にする(中身は作っていない)
    addSolid(f.cx, f.cz, f.w, f.d, -f.yaw, gy + (CASTLE_H[c.name] ?? 12), t.key);
    t.group.add(g);
  }
  console.log(`[${t.key}] 首里城の建物 ${list.length}棟 ` +
    `(${list.map((c) => c.name).join('、')})`);
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
      const x = minx + t.rnd() * (maxx - minx);
      const z = minz + t.rnd() * (maxz - minz);
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
      const h = 3.2 + t.rnd() * 3.0;
      const r = 1.4 + t.rnd() * 1.2;
      qt.setFromAxisAngle(up, t.rnd() * Math.PI * 2);
      m4.compose(pv3.set(x, y, z), qt, sv3.set(1, h, 1));
      trunks.setMatrixAt(i, m4);
      m4.compose(pv3.set(x, y + h + r * 0.4, z), qt, sv3.set(r, r * 0.85, r));
      leaves.setMatrixAt(i, m4);
      // 亜熱帯の照葉樹。濃い緑から明るい黄緑まで振って単調さを消す
      col.setHSL(0.25 + t.rnd() * 0.06, 0.30 + t.rnd() * 0.20,
                 0.24 + t.rnd() * 0.13);
      leaves.setColorAt(i, col);
      addSolid(x, z, 0.55, 0.55, 0, y + h, t.key);   // 幹だけ固体にする
      // 幹の位置と高さを残す。セミやキノボリトカゲを幹にとまらせるのに要る。
      // InstancedMesh の行列からは読み出しにくいので、ここで控えておく
      (t.trees ??= []).push({ x, z, y, h });
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
    g.rotation.y = t.rnd() * Math.PI * 2;

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

// ---------------------------------------------------------------- 工事区域
// OSM の landuse=construction(203) / building=construction(52)。
//
// **「ここは工事中です」と断定して出さない。** start_date も check_date も
// 384件中2件にしか入っていないので、いつの記録か分からない。名札は
// 「OSM 上そう記録されている」に留める(史跡289件のうち253件を説明なしで
// 出したのと同じ判断)。
//
// **highway=construction(129本)は使わない。** 那覇空港自動車道の高架部と
// 赤嶺トンネルが大半で、線を地上に描くと空中・地下にあるものを地面へ寝かせる
// ことになる。赤嶺トンネルは実際にはもう開通している可能性が高い。
//
// 出すもの: 地面の赤土(groundTexture の B チャンネル) / 仮囲い / 重機 /
//           カラーコーン。
const SITE_FENCE = 240;    // これより小さい面には仮囲いを立てない(m2)
const SITE_MACH = 900;     // 重機を置く下限(m2)
const MACH_PER_TILE = 2;   // 1タイルに置く重機の上限(1台10〜14メッシュあるため)
const FENCE_H = 2.15;      // 仮囲いの高さ(実物の鋼板は 2.0〜2.4m)
const FENCE_STEP = 2.5;    // 地形を拾うために打ち直す間隔(m)
const GATE_W = 7.0;        // 現場ゲートの開口(m)
const FOUND_H = 0.45;      // 建設中の建物に出す基礎の立ち上がり(m)
const machines = [];       // {g, parts, kind, phase, tile}

/**
 * タイル t の工事区域を、面積・重心・内外判定つきで返す。
 *
 * 重心は多角形の重心。凹んだ形だと面の外へ出るので、外れたら外接矩形の
 * 中心に落とす(それも外れたら重機を置かないので実害が無い)。
 */
function siteAreasOf(t) {
  const out = [];
  for (const p of t.data.construction ?? []) {
    const pts = [];
    for (let i = 0; i < p.f.length; i += 2) pts.push([t.X(p.f[i]), t.Z(p.f[i + 1])]);
    if (pts.length < 3) continue;
    let a2 = 0, cx = 0, cz = 0;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i], [nx, nz] = pts[(i + 1) % pts.length];
      const cr = x * nz - nx * z;
      a2 += cr; cx += (x + nx) * cr; cz += (z + nz) * cr;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    if (Math.abs(a2) < 2) continue;
    const inside = (x, z) => {
      let s = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[j];
        if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) s = !s;
      }
      return s;
    };
    cx /= 3 * a2; cz /= 3 * a2;
    if (!inside(cx, cz)) { cx = (minx + maxx) / 2; cz = (minz + maxz) / 2; }
    out.push({
      name: p.name, k: p.k, pts, area: Math.abs(a2) / 2,
      cx, cz, minx, maxx, minz, maxz, inside,
    });
  }
  return out;
}

/**
 * (x,z) の周り r m が平らか。高さの開きが tol を超えたら偽。
 *
 * **重機は地形の傾きを拾わない**（水平に置く）。那覇の高台は斜面が急で、
 * 傾きを無視して置くとダンプの半分が地中に埋まり、残り半分が宙に浮く
 * (実測で久場川公園の斜面に置いたダンプが片側 1.9m 浮いた)。
 * 実際の工事現場は造成して平らにしてあるので、平らな所だけに置くのが近い。
 */
function flatEnough(x, z, r, tol) {
  const c = groundAt(x, z);
  let lo = c, hi = c;
  for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r],
                          [r * 0.7, r * 0.7], [-r * 0.7, -r * 0.7]]) {
    const y = groundAt(x + ox, z + oz);
    if (y < lo) lo = y; if (y > hi) hi = y;
  }
  return hi - lo <= tol;
}

/**
 * 仮囲い。工事区域の外周に鋼板を立てる。
 *
 * 見た目は FENCE_STEP ごとに打ち直して地形を拾う(斜面で足元が浮かないように)。
 * **当たり判定は打ち直す前の辺ごとに1つ**にする。2.5m ごとに addSolid すると
 * 1タイルで数百件になり、blocked() の総当たりが効いてくる。辺は simplify 済みで
 * まっすぐなので、回転した箱1つで足りる。
 *
 * 一番長い辺の真ん中を GATE_W ぶん空けて現場ゲートにする。空けないと、
 * 高さ 2.15m の囲いは目の高さ 1.6m から越えられず、中の重機を近くで見られない。
 *
 * **区間ごとに持ち主のタイルを決める。** 面はタイルの矩形で切らずに、外接矩形が
 * 掛かるタイル全部に入っている(公園と同じ)。そのまま全周を建てると、境界を
 * またぐ面で囲いが二重に建つ(実測: 久場川公園26,481m2 と石嶺市営住宅17,990m2 が
 * 2枚ずつに入っていた)。中点が自分の矩形に入る区間だけを建てれば、
 * 隣と重ならず隙間も空かない。境界そのものは半開区間で片側に寄せる。
 */
function addFences(t, sites) {
  const owns = (x, z) => {
    const dx = x - t.offX, dz = z - t.offZ;
    return dx >= -HALF && dx < HALF && dz >= -HALF && dz < HALF;
  };
  const V = [], VT = [];
  const push = (A, p) => { A.push(p[0], p[1], p[2]); };
  const quad = (A, a, b, c, d) => {
    push(A, a); push(A, b); push(A, c); push(A, a); push(A, c); push(A, d);
  };
  let nseg = 0, nsite = 0, cones = [];

  for (const s of sites) {
    // **建設中の建物(building=construction)は囲わない。** 囲うのは
    // 「工事をしている土地」であって、建てかけの建物そのものではない。
    // 中城御殿跡(10,922m2)の中に建物3件(106/849/527m2)が入っていて、
    // それぞれ 2.15m の鋼板で囲んだら、敷地の真ん中が迷路の壁になった。
    // 建物のほうは下で低い基礎の立ち上がりとして出す
    if (s.k === 'building' || s.area < SITE_FENCE) continue;
    const n = s.pts.length;
    // ゲートを空ける辺。一番長い辺。短すぎる辺しか無ければ空けない(閉じたまま)
    let gi = -1, gl = GATE_W + 4;
    for (let i = 0; i < n; i++) {
      const [ax, az] = s.pts[i], [bx, bz] = s.pts[(i + 1) % n];
      const L = Math.hypot(bx - ax, bz - az);
      if (L > gl) { gl = L; gi = i; }
    }
    const seg0 = nseg;

    for (let i = 0; i < n; i++) {
      const [ax, az] = s.pts[i], [bx, bz] = s.pts[(i + 1) % n];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.6) continue;
      // この辺のうち囲いを立てる区間。ゲートの辺は真ん中を空けて2本に割る
      const runs = (i === gi)
        ? [[0, (L - GATE_W) / 2], [(L + GATE_W) / 2, L]]
        : [[0, L]];
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const px = uz, pz = -ux;                       // 辺に直交(板の厚み方向)
      for (const [d0, d1] of runs) {
        if (d1 - d0 < 0.6) continue;
        const steps = Math.max(1, Math.round((d1 - d0) / FENCE_STEP));
        // 自分の持ち分がひと続きになっているあいだ、当たり判定を1つに伸ばす
        let head = null, topMax = -Infinity;
        const flush = (dEnd) => {
          if (head === null) return;
          const mid = (head + dEnd) / 2;
          addSolid(ax + ux * mid, az + uz * mid, 0.16, (dEnd - head) + 0.3,
                   Math.atan2(ux, uz), topMax, t.key);
          head = null; topMax = -Infinity;
        };
        let prev = null;
        for (let k = 0; k <= steps; k++) {
          const d = d0 + (d1 - d0) * (k / steps);
          const x = ax + ux * d, z = az + uz * d;
          const y0 = groundAt(x, z) - 0.18;          // 少し埋めて斜面の隙間を消す
          const cur = { d, x, z, y0 };
          if (prev) {
            const mx = (prev.x + x) / 2, mz = (prev.z + z) / 2;
            if (owns(mx, mz)) {
              const a = [prev.x, prev.y0, prev.z], b = [x, y0, z];
              const c = [x, y0 + FENCE_H, z], e = [prev.x, prev.y0 + FENCE_H, prev.z];
              quad(V, a, b, c, e);                   // 板(両面で描く)
              // 天端の帯。板の上に薄く出す
              const g0 = [prev.x, prev.y0 + FENCE_H, prev.z];
              const g1 = [x, y0 + FENCE_H, z];
              const h0 = [prev.x + px * 0.06, prev.y0 + FENCE_H - 0.16, prev.z + pz * 0.06];
              const h1 = [x + px * 0.06, y0 + FENCE_H - 0.16, z + pz * 0.06];
              quad(VT, h0, h1, g1, g0);
              nseg++;
              if (head === null) head = prev.d;
              topMax = Math.max(topMax, prev.y0 + FENCE_H, y0 + FENCE_H);
            } else {
              flush(prev.d);
            }
          }
          prev = cur;
        }
        flush(prev.d);
      }
      // ゲートの脇にカラーコーンを2本ずつ立てる
      if (i === gi) {
        for (const d of [(L - GATE_W) / 2 + 0.9, (L + GATE_W) / 2 - 0.9]) {
          const cx2 = ax + ux * d + px * 0.5, cz2 = az + uz * d + pz * 0.5;
          if (owns(cx2, cz2)) cones.push([cx2, cz2]);
        }
      }
    }
    if (nseg > seg0) nsite++;         // 持ち分が1区間も無い面は数えない
  }

  // 建設中の建物は、基礎の立ち上がりだけを出す。囲いと同じ作りで高さを
  // FOUND_H にしたもの。**当たり判定には入れない**(0.45m は STEP=0.55 以下で
  // 跨げる段差なので、固体にすると跨げないのに見た目は跨げそう、になる)
  const FV = [];
  let nfound = 0;
  for (const s of sites) {
    if (s.k !== 'building' || s.area < 40) continue;
    const n = s.pts.length;
    let hit = false;
    for (let i = 0; i < n; i++) {
      const [ax, az] = s.pts[i], [bx, bz] = s.pts[(i + 1) % n];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const steps = Math.max(1, Math.round(L / FENCE_STEP));
      let prev = null;
      for (let k = 0; k <= steps; k++) {
        const dd = L * (k / steps);
        const x = ax + ux * dd, z = az + uz * dd;
        const y0 = groundAt(x, z) - 0.15;
        if (prev && owns((prev.x + x) / 2, (prev.z + z) / 2)) {
          quad(FV, [prev.x, prev.y0, prev.z], [x, y0, z],
               [x, y0 + FOUND_H, z], [prev.x, prev.y0 + FOUND_H, prev.z]);
          hit = true;
        }
        prev = { x, z, y0 };
      }
    }
    if (hit) nfound++;
  }
  if (FV.length) {
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(FV, 3));
    fg.computeVertexNormals();
    const fm = new THREE.Mesh(fg, new THREE.MeshLambertMaterial({
      color: 0xb8b4ac, side: THREE.DoubleSide,       // 打ちっぱなしのコンクリート
    }));
    fm.receiveShadow = true;
    t.group.add(fm);
  }

  if (V.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    geo.computeVertexNormals();
    // 板は厚みを持たせていないので両面で描く。仮囲いの鋼板は実際に薄い
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: 0xd7dad5, side: THREE.DoubleSide,
    }));
    m.receiveShadow = true;
    t.group.add(m);
    const gt = new THREE.BufferGeometry();
    gt.setAttribute('position', new THREE.Float32BufferAttribute(VT, 3));
    gt.computeVertexNormals();
    t.group.add(new THREE.Mesh(gt, new THREE.MeshLambertMaterial({
      color: 0x2f6ea8, side: THREE.DoubleSide,
    })));
  }
  if (cones.length) {
    const cg = new THREE.ConeGeometry(0.22, 0.7, 6);
    cg.translate(0, 0.35, 0);
    const im = new THREE.InstancedMesh(
      cg, new THREE.MeshLambertMaterial({ color: 0xe8642f }), cones.length);
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion();
    const pv = new THREE.Vector3(), sv = new THREE.Vector3(1, 1, 1);
    cones.forEach(([x, z], i) => {
      m4.compose(pv.set(x, groundAt(x, z), z), qt, sv);
      im.setMatrixAt(i, m4);
    });
    im.castShadow = true;
    t.group.add(im);
  }
  if (nsite || nfound) {
    console.log(`[${t.key}] 仮囲い ${nsite}区域 / ${nseg}区間 / コーン${cones.length}本 `
                + `/ 基礎 ${nfound}棟`);
  }
}

/**
 * 重機。1台10〜14メッシュあるので、**タイルあたり MACH_PER_TILE 台まで**。
 * 広い面から順に置く。t.group に足すので、タイルを捨てれば一緒に消える
 * (machines の登録簿だけは dropTile で外す)。
 */
function addMachines(t, sites) {
  const big = sites.filter((s) => s.area >= SITE_MACH)
                   .sort((a, b) => b.area - a.area).slice(0, MACH_PER_TILE);
  let n = 0;
  for (const s of big) {
    // 面の中で、建物にも道にもぶつからず、**平らな**場所を探す
    let x = null, z = null;
    for (let k = 0; k < 40; k++) {
      const px = s.minx + t.rnd() * (s.maxx - s.minx);
      const pz = s.minz + t.rnd() * (s.maxz - s.minz);
      if (Math.abs(px - t.offX) > HALF - 8 || Math.abs(pz - t.offZ) > HALF - 8) continue;
      if (!s.inside(px, pz)) continue;
      if (blocked(px, pz, 3.4)) continue;
      if (onRoad(px, pz)) continue;
      if (!flatEnough(px, pz, 3.0, 0.8)) continue;
      x = px; z = pz; break;
    }
    if (x === null) continue;
    // 広い面にはクレーン、そうでなければショベル。ダンプはその脇に付ける。
    // クレーンは控えめに出す。ブーム18mは遠くからでも目立つので、実際の街より
    // 多く見えると嘘になる(6000m2 以上の面で 0.3 だと、読み込み6枚で1〜2台)
    const kind = s.area >= 6000 && t.rnd() < 0.3 ? 'crane' : 'excavator';
    const g = kind === 'crane' ? makeCrawlerCrane() : makeExcavator();
    g.position.set(x, groundAt(x, z), z);
    g.rotation.y = t.rnd() * Math.PI * 2;
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    t.group.add(g);
    machines.push({
      g, parts: g.userData.parts, kind, tile: t.key,
      phase: t.rnd() * Math.PI * 2,
    });
    // 重機は動くので当たり判定に入れない(動く固体は bstore が扱えない)。
    // 代わりに現場そのものを仮囲いで囲ってある
    n++;

    // ダンプ。重機の脇に停める。置けなければ諦める(現場が狭いだけ)
    for (let k = 0; k < 12; k++) {
      const a = t.rnd() * Math.PI * 2, r = 7 + t.rnd() * 5;
      const dx = x + Math.cos(a) * r, dz = z + Math.sin(a) * r;
      if (Math.abs(dx - t.offX) > HALF - 6 || Math.abs(dz - t.offZ) > HALF - 6) continue;
      if (!s.inside(dx, dz) || blocked(dx, dz, 3.4) || onRoad(dx, dz)) continue;
      if (!flatEnough(dx, dz, 3.2, 0.8)) continue;
      const d = makeDumpTruck();
      d.position.set(dx, groundAt(dx, dz), dz);
      d.rotation.y = t.rnd() * Math.PI * 2;
      d.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      t.group.add(d);
      machines.push({
        g: d, parts: d.userData.parts, kind: 'dump', tile: t.key,
        phase: t.rnd() * Math.PI * 2,
      });
      n++;
      break;
    }
  }
  if (n) console.log(`[${t.key}] 重機 ${n}台`);
}

/**
 * 重機を1フレーム動かす。**可動部を回すだけ**で、位置は動かさない。
 *
 * クレーンのフックは boom ではなく swing の子になっている。ワイヤが
 * 世界の鉛直に垂れるのはそのおかげなので、**ブームは起こさない**
 * (起こすとフックが先端から離れる)。旋回と巻き上げだけ動かす。
 */
const MACH_R2 = 220 * 220;        // これより遠い重機は動かさない
function stepMachines(dt) {
  if (!machines.length) return;
  for (const m of machines) {
    const dx = m.g.position.x - player.x, dz = m.g.position.z - player.z;
    if (dx * dx + dz * dz > MACH_R2) continue;
    m.phase += dt;
    const p = m.parts;
    if (!p) continue;
    if (m.kind === 'excavator') {
      // 掘る→旋回して放す→戻る、をひと続きの周期にする。
      // **下げる側だけ振れを半分にする。** 地形は掘れないので、対称に振ると
      // バケットが地面の 0.64m 下まで潜って丸ごと埋まる(実測)。半分にすると
      // 歯先が 0.21m 噛むだけで止まり、掘っているようには見えたまま
      const c = (m.phase * 0.22) % 1;
      const s = Math.sin(c * Math.PI * 2);
      const dig = s < 0 ? s * 0.5 : s;
      p.swing.rotation.y = Math.sin(c * Math.PI * 2 - 1.2) * 0.85;
      p.boom.rotation.x = -1.25 + dig * 0.22;
      p.arm.rotation.x = 1.55 - dig * 0.40;
      p.bucket.rotation.x = 0.35 + dig * 0.55;
    } else if (m.kind === 'crane') {
      p.swing.rotation.y = Math.sin(m.phase * 0.12) * 0.7;
      // 巻き上げ・巻き下ろし。ワイヤはフックの下げ幅ぶん伸ばす
      const d = 5.5 + Math.sin(m.phase * 0.35) * 4.5;
      p.hook.position.y = m.hookY0 ?? (m.hookY0 = p.hook.position.y);
      p.hook.position.y = m.hookY0 - d;
      if (p.hook.userData.rope) p.hook.userData.rope.scale.y = d;
    } else if (m.kind === 'dump') {
      // たまに荷台を上げて土を落とす。上げっぱなしにしない
      const c = (m.phase * 0.06) % 1;
      const up = c < 0.18 ? Math.sin((c / 0.18) * Math.PI) : 0;
      p.bed.rotation.x = up * 0.85;
    }
  }
}

// ---------------------------------------------------------------- 重機の造形
// 造形は Antigravity(agy)に契約を渡して書かせたものを検分して取り込んだ。
// シーサー・正殿・車内と同じやり方。
//
// 契約: 原点=接地面の中心・すべて y>=0 / 正面=-Z / MeshLambertMaterial のみ /
//       transparent 禁止・castShadow 禁止(呼び出し側でまとめる) /
//       Math.random 禁止 / 1関数40メッシュ以内 /
//       **可動部は「回転の付け根を原点にした Group」を userData.parts に出す**。
//
// 検分で見つけて直したもの2件（どちらも初期姿勢の誤り。構造は契約どおり）:
//   1. クレーンの boom.rotation.x が -1.0 で、ブームが**地中 13m まで刺さって
//      いた**。フックの置き場所 (0, 1.0+15.14, -1.7-9.72) が +1.0 のときの
//      先端と小数点以下まで一致するので、符号だけの取り違え。+1.0 に直した
//   2. ショベルの初期姿勢でバケットが**空中 5.3m** にあった(契約は
//      「バケットを地面近くに下ろした待機の形」)。この腕の長さだと、
//      バケットが接地するにはブームがほぼ水平まで下りる必要がある
//      (ブーム先端の高さ 1.75+4.2cosθ が 3.25m 以下、つまり |θ|>=1.21)。
//      θb=-1.25 / θa=1.55 / θc=0.35 にしてバケット下端 0.11m・総高 3.10m。
//      この姿勢を stepMachines の振れ幅の中心にしている

// 油圧ショベル (0.25m3級) クローラ全長3.6m / 全幅2.4m / 旋回体幅2.3m / ブーム4.2m / アーム2.2m
function makeExcavator() {
  const group = new THREE.Group();
  group.userData.parts = {};

  const matYellow = new THREE.MeshLambertMaterial({ color: 0xe8b423 });
  const matBlack = new THREE.MeshLambertMaterial({ color: 0x3a3a3c });
  const matWindow = new THREE.MeshLambertMaterial({ color: 0x1e2a30 });

  const crawlerGroup = new THREE.Group();
  group.add(crawlerGroup);

  const trackGeo = new THREE.BoxGeometry(0.5, 0.75, 3.6);
  const trackL = new THREE.Mesh(trackGeo, matBlack);
  trackL.position.set(-0.95, 0.375, 0);
  const trackR = new THREE.Mesh(trackGeo, matBlack);
  trackR.position.set(0.95, 0.375, 0);
  const baseGeo = new THREE.BoxGeometry(1.2, 0.6, 2.0);
  const baseCenter = new THREE.Mesh(baseGeo, matBlack);
  baseCenter.position.set(0, 0.45, 0);
  crawlerGroup.add(trackL, trackR, baseCenter);

  const swing = new THREE.Group();
  swing.position.set(0, 0.75, 0);
  group.add(swing);
  group.userData.parts.swing = swing;

  const swingBodyGeo = new THREE.BoxGeometry(2.3, 1.5, 2.9);
  const swingBody = new THREE.Mesh(swingBodyGeo, matYellow);
  swingBody.position.set(0, 0.75, 0.1);
  const cabGeo = new THREE.BoxGeometry(1.0, 1.6, 1.6);
  const cab = new THREE.Mesh(cabGeo, matYellow);
  cab.position.set(-0.65, 1.55, -0.6);
  const winGeo = new THREE.BoxGeometry(0.9, 0.7, 1.65);
  const win = new THREE.Mesh(winGeo, matWindow);
  win.position.set(-0.65, 1.9, -0.6);
  swing.add(swingBody, cab, win);

  const boom = new THREE.Group();
  boom.position.set(0.3, 1.0, -0.5);
  boom.rotation.x = -1.25;              // 検分で直した(元は -0.5 でバケットが空中)
  swing.add(boom);
  group.userData.parts.boom = boom;

  const boomGeo = new THREE.BoxGeometry(0.4, 4.2, 0.5);
  const boomMesh = new THREE.Mesh(boomGeo, matYellow);
  boomMesh.position.set(0, 2.1, 0);
  boom.add(boomMesh);

  const arm = new THREE.Group();
  arm.position.set(0, 4.2, 0);
  arm.rotation.x = 1.55;                // 同上(元は -1.0)
  boom.add(arm);
  group.userData.parts.arm = arm;

  const armGeo = new THREE.BoxGeometry(0.3, 2.2, 0.3);
  const armMesh = new THREE.Mesh(armGeo, matYellow);
  armMesh.position.set(0, -1.1, 0);
  arm.add(armMesh);

  const bucket = new THREE.Group();
  bucket.position.set(0, -2.2, 0);
  bucket.rotation.x = 0.35;             // 同上(元は 0.5)
  arm.add(bucket);
  group.userData.parts.bucket = bucket;

  const bucketBaseGeo = new THREE.BoxGeometry(0.9, 0.8, 0.6);
  const bucketBase = new THREE.Mesh(bucketBaseGeo, matBlack);
  bucketBase.position.set(0, -0.4, 0);
  const toothGeo = new THREE.BoxGeometry(0.9, 0.1, 0.3);
  const tooth = new THREE.Mesh(toothGeo, matBlack);
  tooth.position.set(0, -0.85, -0.15);
  bucket.add(bucketBase, tooth);

  return group;
}

// クローラクレーン (25t吊り級) クローラ全長5.0m / 全幅3.2m / ブーム18m
function makeCrawlerCrane() {
  const group = new THREE.Group();
  group.userData.parts = {};

  const matBody = new THREE.MeshLambertMaterial({ color: 0xd9d4c8 });
  const matBoom = new THREE.MeshLambertMaterial({ color: 0xc4452f });
  const matBlack = new THREE.MeshLambertMaterial({ color: 0x3a3a3c });
  const matWindow = new THREE.MeshLambertMaterial({ color: 0x1e2a30 });

  const trackGeo = new THREE.BoxGeometry(0.7, 0.9, 5.0);
  const trackL = new THREE.Mesh(trackGeo, matBlack);
  trackL.position.set(-1.25, 0.45, 0);
  const trackR = new THREE.Mesh(trackGeo, matBlack);
  trackR.position.set(1.25, 0.45, 0);
  const baseGeo = new THREE.BoxGeometry(1.5, 0.7, 2.5);
  const baseCenter = new THREE.Mesh(baseGeo, matBlack);
  baseCenter.position.set(0, 0.45, 0);
  group.add(trackL, trackR, baseCenter);

  const swing = new THREE.Group();
  swing.position.set(0, 0.9, 0);
  group.add(swing);
  group.userData.parts.swing = swing;

  const bodyGeo = new THREE.BoxGeometry(2.8, 2.2, 4.4);
  const bodyMesh = new THREE.Mesh(bodyGeo, matBody);
  bodyMesh.position.set(0, 1.1, 0.5);
  const cwGeo = new THREE.BoxGeometry(2.8, 1.5, 1.0);
  const cwMesh = new THREE.Mesh(cwGeo, matBlack);
  cwMesh.position.set(0, 0.75, 2.2);
  const cabGeo = new THREE.BoxGeometry(1.0, 2.0, 1.5);
  const cabMesh = new THREE.Mesh(cabGeo, matBody);
  cabMesh.position.set(-0.9, 1.0, -1.5);
  const winGeo = new THREE.BoxGeometry(0.9, 1.0, 1.55);
  const winMesh = new THREE.Mesh(winGeo, matWindow);
  winMesh.position.set(-0.9, 1.3, -1.5);
  swing.add(bodyMesh, cwMesh, cabMesh, winMesh);

  const boom = new THREE.Group();
  boom.position.set(0, 1.0, -1.7);
  // 検分で直した。元は -1.0 で、ブームが**地中 13m** まで刺さっていた
  boom.rotation.x = 1.0;
  swing.add(boom);
  group.userData.parts.boom = boom;

  const chordGeo = new THREE.BoxGeometry(0.1, 0.1, 18);
  const c1 = new THREE.Mesh(chordGeo, matBoom); c1.position.set(-0.4, 0.4, -9);
  const c2 = new THREE.Mesh(chordGeo, matBoom); c2.position.set(0.4, 0.4, -9);
  const c3 = new THREE.Mesh(chordGeo, matBoom); c3.position.set(-0.4, -0.4, -9);
  const c4 = new THREE.Mesh(chordGeo, matBoom); c4.position.set(0.4, -0.4, -9);
  boom.add(c1, c2, c3, c4);

  const latGeo = new THREE.BoxGeometry(0.05, 0.05, 1.4);
  const latMesh = new THREE.InstancedMesh(latGeo, matBoom, 60);
  const dummy = new THREE.Object3D();
  let idx = 0;
  for (let i = 0; i < 15; i++) {
    const z = -1.2 * i - 0.6;
    dummy.position.set(0, 0.4, z); dummy.rotation.set(0, 0.6, 0);
    dummy.updateMatrix(); latMesh.setMatrixAt(idx++, dummy.matrix);
    dummy.position.set(0, -0.4, z); dummy.rotation.set(0, -0.6, 0);
    dummy.updateMatrix(); latMesh.setMatrixAt(idx++, dummy.matrix);
    dummy.position.set(-0.4, 0, z); dummy.rotation.set(0.6, 0, 0);
    dummy.updateMatrix(); latMesh.setMatrixAt(idx++, dummy.matrix);
    dummy.position.set(0.4, 0, z); dummy.rotation.set(-0.6, 0, 0);
    dummy.updateMatrix(); latMesh.setMatrixAt(idx++, dummy.matrix);
  }
  boom.add(latMesh);

  // フックは boom ではなく swing の子。ワイヤが世界の鉛直に垂れるのはそのため。
  // 代わりに**ブームを起こすとフックが先端から離れる**ので、起伏は動かさない
  const hook = new THREE.Group();
  hook.position.set(0, 1.0 + 15.14, -1.7 - 9.72);
  swing.add(hook);
  group.userData.parts.hook = hook;

  const hookBodyGeo = new THREE.BoxGeometry(0.4, 0.6, 0.4);
  const hookBody = new THREE.Mesh(hookBodyGeo, matBlack);
  hookBody.position.set(0, -0.3, 0);
  hook.add(hookBody);

  const ropeGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 8);
  ropeGeo.translate(0, 0.5, 0);
  const rope = new THREE.Mesh(ropeGeo, matBlack);
  rope.scale.y = 0.01;
  hook.add(rope);
  hook.userData.rope = rope;

  return group;
}

// 4tダンプトラック 全長6.1m / 全幅2.2m / 全高2.6m / 荷台長さ3.4m
function makeDumpTruck() {
  const group = new THREE.Group();
  group.userData.parts = {};

  const matCab = new THREE.MeshLambertMaterial({ color: 0xe8e4dc });
  const matBed = new THREE.MeshLambertMaterial({ color: 0x2f5c8a });
  const matTire = new THREE.MeshLambertMaterial({ color: 0x22262a });
  const matWindow = new THREE.MeshLambertMaterial({ color: 0x1e2a30 });
  const matChassis = new THREE.MeshLambertMaterial({ color: 0x3a3a3c });

  const chassisGeo = new THREE.BoxGeometry(2.0, 0.2, 5.8);
  const chassis = new THREE.Mesh(chassisGeo, matChassis);
  chassis.position.set(0, 0.85, 0.15);
  group.add(chassis);

  const cabGeo = new THREE.BoxGeometry(2.2, 1.5, 1.8);
  const cab = new THREE.Mesh(cabGeo, matCab);
  cab.position.set(0, 1.7, -1.8);
  group.add(cab);

  const winGeo = new THREE.BoxGeometry(2.1, 0.7, 1.85);
  const win = new THREE.Mesh(winGeo, matWindow);
  win.position.set(0, 1.9, -1.8);
  group.add(win);

  const tireGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.28, 16);
  tireGeo.rotateZ(Math.PI / 2);

  const tFL = new THREE.Mesh(tireGeo, matTire); tFL.position.set(-0.96, 0.45, -1.8);
  const tFR = new THREE.Mesh(tireGeo, matTire); tFR.position.set(0.96, 0.45, -1.8);
  group.add(tFL, tFR);

  const tRL1 = new THREE.Mesh(tireGeo, matTire); tRL1.position.set(-0.82, 0.45, 2.0);
  const tRL2 = new THREE.Mesh(tireGeo, matTire); tRL2.position.set(-1.1, 0.45, 2.0);
  const tRR1 = new THREE.Mesh(tireGeo, matTire); tRR1.position.set(0.82, 0.45, 2.0);
  const tRR2 = new THREE.Mesh(tireGeo, matTire); tRR2.position.set(1.1, 0.45, 2.0);
  group.add(tRL1, tRL2, tRR1, tRR2);

  // ヒンジは荷台の**後端の下**。中心を原点にすると上げたとき車体にめり込む
  const bed = new THREE.Group();
  bed.position.set(0, 0.95, 3.0);
  group.add(bed);
  group.userData.parts.bed = bed;

  const floorGeo = new THREE.BoxGeometry(2.1, 0.1, 3.4);
  const floor = new THREE.Mesh(floorGeo, matBed);
  floor.position.set(0, 0.05, -1.7);

  const sideGeo = new THREE.BoxGeometry(0.1, 0.9, 3.4);
  const leftWall = new THREE.Mesh(sideGeo, matBed); leftWall.position.set(-1.0, 0.55, -1.7);
  const rightWall = new THREE.Mesh(sideGeo, matBed); rightWall.position.set(1.0, 0.55, -1.7);

  const fbGeo = new THREE.BoxGeometry(1.9, 0.9, 0.1);
  const frontWall = new THREE.Mesh(fbGeo, matBed); frontWall.position.set(0, 0.55, -3.35);
  const backWall = new THREE.Mesh(fbGeo, matBed); backWall.position.set(0, 0.55, -0.05);

  bed.add(floor, leftWall, rightWall, frontWall, backWall);

  return group;
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
                    x: s.x, z: s.z, door, tile: t.key };
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

/**
 * タイル t の歩道を歩道網に足す。歩道は corridor.json ではなくタイルが持つ
 * (OSM をタイルごとに切ってある)ので、タイルの出し入れに合わせて足し引きする。
 */
function addWalkLines(t) {
  let n = 0;
  for (const f of t.data.footways ?? []) {
    if (f.k !== 'sidewalk' && f.k !== 'path') continue;
    const pts = [];
    for (let i = 0; i < f.f.length; i += 2) {
      pts.push({ x: t.X(f.f[i]), z: t.Z(f.f[i + 1]) });
    }
    if (pts.length < 2) continue;
    const cum = [0];
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      cum.push(len);
    }
    if (len < 6) continue;               // 短すぎる断片は使わない
    walkLines.push({ pts, cum, len, tile: t.key });
    n++;
  }
  return n;
}

/** タイル key の歩道を歩道網から外す。乗っていた者は呼び出し側で乗せ替える。 */
function dropWalkLines(key) {
  for (let i = walkLines.length - 1; i >= 0; i--) {
    if (walkLines[i].tile === key) walkLines.splice(i, 1);
  }
}

{
  for (const t of tiles.values()) addWalkLines(t);

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

/**
 * シーサーを歩道網に乗せる。walkLines が揃ってから呼ぶこと。
 *
 * 二通りある:
 *  - 初めての個体は互いになるべく離れた歩道へ(固まって湧くと探す楽しみが無い)
 *  - タイルを捨てられて足を止めていた個体(L === null)は、いま立っている場所の
 *    いちばん近い歩道へ戻す。遠くの歩道へ乗せ直すと、離れて居たはずの1体が
 *    プレイヤーの目の前へ湧いてしまう
 */
function seatSeesaa() {
  if (!walkLines.length) return;
  const live = new Set(walkLines);
  const used = [];
  let fresh = 0, back = 0;
  for (const g of seesaa) {
    const u = g.userData;
    if (u.L && live.has(u.L)) { used.push([g.position.x, g.position.z]); continue; }
    if (!tiles.has(u.tile)) continue;        // 居場所のタイルが無い間はそのまま
    let best = null;
    if (u.L === null) {
      // 足を止めていた個体を、自分のタイルのいちばん近い歩道へ戻す
      let bd = Infinity;
      for (const L of walkLines) {
        if (L.tile !== u.tile || L.len < 12) continue;
        for (let d = 0; d <= L.len; d += 4) {
          const q = walkAt(L, d);
          const e = Math.hypot(q.x - g.position.x, q.z - g.position.z);
          if (e < bd) { bd = e; best = { L, d, q }; }
        }
      }
      if (best) back++;
    } else {
      // 初めての個体。互いになるべく離れた歩道を選ぶ
      let bestSep = -1;
      for (let k = 0; k < 60; k++) {
        const L = walkLines[(rnd() * walkLines.length) | 0];
        if (L.len < 12) continue;            // 短い断片では歩いているように見えない
        const d = rnd() * L.len;
        const q = walkAt(L, d);
        const sep = used.length
          ? Math.min(...used.map((w) => Math.hypot(w[0] - q.x, w[1] - q.z))) : 1e9;
        if (sep > bestSep) { bestSep = sep; best = { L, d, q }; }
      }
      if (best) fresh++;
    }
    if (!best) continue;
    used.push([best.q.x, best.q.z]);
    Object.assign(u, {
      L: best.L, d: best.d,
      dir: rnd() < 0.5 ? 1 : -1,
      phase: rnd() * Math.PI * 2,
      pause: rnd() * SEESAA_PAUSE,
      trot: 0,
    });
    g.position.set(best.q.x, groundAt(best.q.x, best.q.z), best.q.z);
  }
  if (fresh || back) {
    console.log(`シーサー 新規${fresh}体 / 復帰${back}体 を歩道に乗せた` +
                `（累計 ${seesaa.length}）`);
  }
}

seatSeesaa();

// ---------------------------------------------------------------- ぜんぶ保護できた
// 保護したシーサーは消えているだけなので、最後に呼び戻して主役にする。
// 沖縄のシーサーは屋根や門の上から街を見張る守り神なので、
// 「集まる → 空へ昇って持ち場に就く」という筋にした。
const FIN = { GATHER: 1.6, RISE: 3.6, HOLD: 6.4 };   // 各段の終わり(秒)
let finale = null;

/** 全部保護したときに1回だけ呼ぶ。 */
function startFinale() {
  if (finale) return;
  const cx = hereX(), cz = hereZ(), gy = groundAt(cx, cz);
  finale = { t: 0, cx, cz, gy, motes: null, said: false };
  seesaa.forEach((s, i) => {
    // プレイヤーを囲む輪に、少し外側から歩み寄る形で並べる
    const a = (i / seesaa.length) * Math.PI * 2;
    s.userData.fin = { a, r0: 11 + (i % 3) * 1.4, r1: 5.4, spin: (i % 2 ? 1 : -1) };
    s.visible = true;
    s.userData.ring.visible = true;
    // 光の柱は「遠くから見つける」ための目印。10本が輪になると視界を塞ぐだけなので消す
    s.userData.beam.visible = false;
  });
  // 舞い上がるときの光の粒。1つの InstancedMesh に畳む
  const N = 170;
  const im = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.10, 0),
    new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.9 }),
    N
  );
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  im.frustumCulled = false;            // 毎フレーム行列を書き換えるので境界球が当てにならない
  const col = new THREE.Color();
  finale.motes = { im, seed: [] };
  for (let i = 0; i < N; i++) {
    finale.motes.seed.push({
      a: rnd() * Math.PI * 2, r: 2.5 + rnd() * 7, up: 3 + rnd() * 12,
      w: 0.6 + rnd() * 2.2, ph: rnd() * Math.PI * 2, d: 0.3 + rnd() * 0.7,
    });
    col.setHSL(0.06 + rnd() * 0.10, 0.75, 0.55 + rnd() * 0.2);  // 提灯のような橙〜黄
    im.setColorAt(i, col);
  }
  im.instanceColor.needsUpdate = true;
  scene.add(im);
  say('🎉 ぜんぶ保護できた！');
}

/** 完成アニメーションを1フレーム進める。 */
function stepFinale(dt, now) {
  const f = finale;
  f.t += dt;
  const ease = (x) => x * x * (3 - 2 * x);            // なめらかな出入り
  const p1 = Math.min(1, f.t / FIN.GATHER);                       // 集まる
  const p2 = Math.min(1, Math.max(0, (f.t - FIN.GATHER) / (FIN.RISE - FIN.GATHER)));  // 昇る
  const p3 = Math.min(1, Math.max(0, (f.t - FIN.RISE) / (FIN.HOLD - FIN.RISE)));      // 見送る

  seesaa.forEach((s, i) => {
    const u = s.userData, F = u.fin;
    if (!F) return;
    // 1段目: 輪の外から歩み寄る。2段目: 渦を巻きながら頭上へ寄り集まる。
    // 3段目: 街へ散っていく。半径 5.4m の輪のまま昇らせると視野に2体しか
    // 入らないので、いったん真上へ集めて「10体そろった」画をつくる
    const r = p3 > 0
      ? 1.8 + ease(p3) * 34
      : (F.r0 + (F.r1 - F.r0) * ease(p1)) + (1.8 - F.r1) * ease(p2);
    const a = F.a + (ease(p2) * 1.9 + ease(p3) * 1.2) * F.spin;
    const x = f.cx + Math.cos(a) * r, z = f.cz + Math.sin(a) * r;
    const lift = ease(p2) * (9 + (i % 4) * 0.8) + ease(p3) * 30;
    s.position.set(x, f.gy + lift + Math.sin(now * 0.004 + i) * 0.12, z);
    // 内側(プレイヤー)を向く。造形の前方は -Z なので π 足す
    s.rotation.y = Math.atan2(f.cx - x, f.cz - z) + Math.PI;
    s.rotation.z = ease(p2) * 0.12 * F.spin;         // 昇るときに少し傾ぐ
    const P = u.parts;
    if (P) {
      // 歩いて来る間は脚を振り、浮いたら前足を揃えて胸を張る
      const sw = p1 < 1 ? Math.sin(f.t * 7 + i) * 0.3 : -0.25 * ease(p2);
      P.legFL.rotation.x = sw;  P.legBR.rotation.x = sw;
      P.legFR.rotation.x = p1 < 1 ? -sw : sw;
      P.legBL.rotation.x = p1 < 1 ? -sw : sw;
      P.tail.rotation.x = Math.sin(f.t * 5 + i) * 0.4 - 0.1;
      P.head.rotation.y = Math.sin(f.t * 1.4 + i) * 0.3 * (1 - p2);
    }
    u.ring.rotation.z += dt * (1.1 + p2 * 6);        // 昇るほど速く回る
    u.ring.position.y = 0.1;
    u.ring.material.opacity = 0.85 * (1 - p3);
    s.visible = p3 < 1;
  });

  // 光の粒。集まり終わってから湧き、上へ流れて消える
  const M = f.motes, m4 = new THREE.Matrix4();
  const pv = new THREE.Vector3(), qt = new THREE.Quaternion(), sv = new THREE.Vector3();
  const rise = Math.max(0, f.t - FIN.GATHER * 0.6);
  M.seed.forEach((g, i) => {
    const t = rise * g.d;
    const a = g.a + t * g.w * 0.5;
    const y = f.gy + t * g.up * 0.9;
    const fade = Math.max(0, 1 - t / 3.2);
    qt.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * g.w);
    pv.set(f.cx + Math.cos(a) * g.r, y + Math.sin(t * 3 + g.ph) * 0.3,
           f.cz + Math.sin(a) * g.r);
    sv.setScalar(fade * (0.6 + Math.sin(t * 6 + g.ph) * 0.25));
    m4.compose(pv, qt, sv);
    M.im.setMatrixAt(i, m4);
  });
  M.im.instanceMatrix.needsUpdate = true;
  M.im.material.opacity = 0.9 * Math.max(0, 1 - Math.max(0, f.t - FIN.RISE) / 2.4);

  if (!f.said && f.t > FIN.RISE) {
    f.said = true;
    say('10体そろって、街の見張りに戻っていった');
  }
  if (f.t > FIN.HOLD + 1.2) {                        // 片付けて通常へ戻す
    scene.remove(M.im);
    M.im.geometry.dispose(); M.im.material.dispose();
    for (const s of seesaa) s.visible = false;
    finale = null;
  }
}

/** 1体ぶんの歩きと脚の振り。dist はプレイヤーとの距離。 */
function stepSeesaa(g, dist, dt, now) {
  const u = g.userData;
  // 近づかれると早足。急に切り替わると不自然なので、なまして寄せる
  const want = dist < SEESAA_NEAR ? 1 : 0;
  u.trot += (want - u.trot) * Math.min(1, dt * 1.8);
  const speed = SEESAA_WALK + (SEESAA_TROT - SEESAA_WALK) * u.trot;

  // 歩道は番号ではなく線そのもので持つ。タイルを捨てると walkLines の並びが
  // 変わるので、番号だと別の歩道の上へ瞬間移動してしまう。
  if (u.L && walkLines.length) {
    if (u.pause > 0 && u.trot < 0.25) {
      u.pause -= dt;                         // 追われている間は立ち止まらない
    } else {
      const L = u.L;
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
  if (!walkLines.length) { p.alive = false; return; }
  for (let tries = 0; tries < 24; tries++) {
    const L = walkLines[(Math.random() * walkLines.length) | 0];
    const d = Math.random() * L.len;
    const q = walkAt(L, d);
    const dist = Math.hypot(q.x - player.x, q.z - player.z);
    if (dist < PED_NEAR[0] || dist > PED_NEAR[1]) continue;
    p.L = L; p.d = d;
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

const SIG_UP = new THREE.Vector3();      // 腕木を倒すときの使い回し
const SIG_DIR = new THREE.Vector3();

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
  // 車両用は柱を歩道の縁に立て、灯器だけ車道の上へアームで出す。
  // 腕木の無い基数ぶんは長さ0で潰す(数が変わらないほうが添字が単純)
  const arms = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.055, 0.055, 1, 5), poleMat, list.length);
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
    // 柱は歩道の縁(x,z)。灯器は ax/az があれば車道の上へ張り出す
    const armX = s.ax ?? 0, armZ = s.az ?? 0;
    const armL = Math.hypot(armX, armZ);
    const hx = x + armX, hz = z + armZ;   // 灯器の位置
    const hy = g + h - 0.35;

    // 支柱
    e.set(0, 0, 0); q.setFromEuler(e);
    pos.set(x, g + h / 2, z); scl.set(1, h, 1);
    m.compose(pos, q, scl); poles.setMatrixAt(i, m);

    // 腕木。円柱は Y 方向なので、腕木の向きへ倒す。
    // Euler で組むと軸の順序を取り違えやすいので、向きを直接与える
    // (`setFromEuler` の第2引数は order ではなく update フラグ。ここで一度踏んだ)
    if (armL > 0.5) {
      SIG_UP.set(0, 1, 0); SIG_DIR.set(armX / armL, 0, armZ / armL);
      q.setFromUnitVectors(SIG_UP, SIG_DIR);
      pos.set(x + armX / 2, hy + 0.28, z + armZ / 2); scl.set(1, armL, 1);
    } else {
      // 腕木の無い基。長さ0に潰して消す
      q.identity(); pos.set(x, hy, z); scl.set(0.001, 0.001, 0.001);
    }
    m.compose(pos, q, scl); arms.setMatrixAt(i, m);

    // 灯器(交差点の中心を向く)
    e.set(0, s.r, 0); q.setFromEuler(e);
    const cw = car ? 1.15 : 0.5, ch = car ? 0.42 : 0.78;
    pos.set(hx, hy, hz); scl.set(cw, ch, 1);
    m.compose(pos, q, scl); cases.setMatrixAt(i, m);

    // 灯火を灯器の前面に並べる(車両用は横3つ、歩行者用は縦2つ)
    const fx = Math.sin(s.r) * 0.13, fz = Math.cos(s.r) * 0.13;
    for (let k = 0; k < 3; k++) {
      let ox = 0, oy = 0;
      if (car) ox = (k - 1) * 0.34; else oy = k === 2 ? 0 : (k === 0 ? 0.19 : -0.19);
      const lx = hx + Math.cos(s.r) * ox + fx;
      const lz = hz - Math.sin(s.r) * ox + fz;
      pos.set(lx, hy + oy, lz);
      scl.set(car ? 1 : (k === 2 ? 0.001 : 1), 1, 1);   // 歩行者用は3つ目を消す
      m.compose(pos, q, scl);
      lamps.setMatrixAt(i * 3 + k, m);
    }
    // 灯火の書き換え先(どのメッシュの何番目か)を持たせておく
    signals.push({ x, z, r: s.r, k: s.k, a: s.a, g: gidBase + s.g, lamps, li: i * 3,
                  tile: t.key });
  });
  poles.instanceMatrix.needsUpdate = true;
  cases.instanceMatrix.needsUpdate = true;
  arms.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  poles.castShadow = cases.castShadow = arms.castShadow = true;
  t.group.add(poles, cases, arms, lamps);
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
/**
 * 系統名から末尾の行き先を落とす。
 * 「石嶺（開南）線 （具志営業所行き)」のように線名そのものに全角括弧が入る系統が
 * あるので、最初の括弧ではなく **末尾の括弧ひとつ** だけを取る。
 */
function routeName(s) {
  return s.replace(/\s*[（(][^（(]*[)）]?\s*$/, '').trim() || s.trim();
}

/**
 * 走るバスを今のタイルに合わせて作り直す。
 * 経路は全線ぶんあるので読み込み済みタイル+余白で切る。切り直すと経路の長さが
 * 変わるので、走行位置は距離ではなく **世界座標** で引き継ぐ
 * (距離のまま渡すと、経路が伸びた瞬間にバスが数百m飛ぶ)。
 */
function rebuildBuses() {
  const was = new Map();
  for (const b of buses) {
    const q = pathAt(b.path, b.d);
    was.set(b.ref, { x: q.x, z: q.z, dir: b.dir, wait: b.wait });
    scene.remove(b.g);
    disposeTree(b.g);
  }
  buses.length = 0;

  const LIVERY = [0xf2f0ea, 0xe8642f];   // 白地にオレンジ帯(那覇バスのイメージ)
  let n = 0;
  for (const r of corridor?.busRoutes ?? []) {
    // 全系統ぶん(1系統13km超)あるので、読み込み済みタイル+余白で切る。
    // 切れて複数になったら、いちばん長い断片の上を走らせる。
    const segs = clipToLoaded(r.f);
    if (!segs.length) continue;
    const pts = segs.reduce((a, b) => (polyLen(b) > polyLen(a) ? b : a));
    if (pts.length < 2) continue;
    const path = { pts: pts.map(([x, z]) => ({ x, z })), cum: [0], len: 0 };
    for (let k = 1; k < pts.length; k++) {
      path.len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      path.cum.push(path.len);
    }
    if (path.len < 60) continue;         // かすっただけの系統は走らせない
    const i = n++;

    // 経路上でバス停に近づく地点(そこで少し停まる)。
    // バス停はタイルが持つので、建て終わった標識(busSigns)の位置で見る
    const stops = [];
    for (let d = 0; d < path.len; d += 5) {
      const q = pathAt(path, d);
      for (const b of busSigns) {
        if (Math.hypot(b.position.x - q.x, b.position.z - q.z) < 13) {
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
    const lab = makeLabel(`${r.ref}  ${routeName(r.name)}`, 7.6, 1.9);
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
      ref: r.ref, name: routeName(r.name),
      // 初期位置をばらす。系統が増えても経路の外へ出ないよう 1 で折り返す
      d: path.len * ((0.13 + 0.21 * i) % 1), dir: 1, wait: 0,
    });

    // 作り直しなら、居た場所にいちばん近い地点へ戻す
    const w = was.get(r.ref);
    if (w) {
      const bus = buses[buses.length - 1];
      let bd = Infinity;
      for (let d = 0; d <= path.len; d += 4) {
        const q = pathAt(path, d);
        const e = Math.hypot(q.x - w.x, q.z - w.z);
        if (e < bd) { bd = e; bus.d = d; }
      }
      bus.dir = w.dir; bus.wait = w.wait;
    }
  }
  console.log(`バス ${buses.length}台 / 経路 ` + buses.map((b) => b.ref).join('、'));
}
rebuildBuses();

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

// 走る車両(2両編成)。線形を往復するので端で消えたり湧いたりしない。
//
// **本数は線形の長さで決める**。世界が1kmだった頃は線形1,025mに1本で往復3分
// だったが、10kmに広げたら線形が最大6,277mになり、同じ駅に次が来るまで
// **11.5〜21分**になって事実上乗れなくなった(実測)。
// 約800mに1本にすると、どの長さでも2〜3分に落ち着く。
// 本数と「同じ駅での最悪の待ち時間」の実測(線形3,177m・駅3):
//   3本=4.0分 / 4本=2.7分 / 5本=2.1分 / 6本=1.7分 / 8本=1.4分
// 往復の線形なので往路と復路が駅の近くで擦れ違い、到着にムラが出る。
// 均されないぶん、最悪値で見て 550m に1本にしている。
const TRAIN_GAP = 550;                        // この距離に1本の割合
const TRAIN_MIN = 3, TRAIN_MAX = 12;
const TRAIN_SPEED = 11;                       // m/s。約40km/h
const TRAIN_DWELL = 9;                        // 駅での停車(秒)。乗り降りできる長さ
const trains = [];            // {g, d, dir, wait, ride}
let trainPath = null, trainStopDs = [];

/** 2両編成の車両。 */
function makeTrainCars() {
  const g = new THREE.Group();
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
    g.add(car);
  }
  g.position.y = -9999;                       // 初回 tick で正しい位置に移す
  scene.add(g);
  return g;
}

if (railPaths.length) retargetTrain();

/**
 * 線形を作り直したあとに、走らせる線形と停車位置を選び直す。
 * 走行位置は距離ではなく **世界座標** で引き継ぐ(線形が伸びると距離の意味が
 * 変わるので、そのまま渡すと列車が数百m飛ぶ)。
 */
function retargetTrain(keeps = null) {
  if (!railPaths.length) {
    trainPath = null; trainStopDs = [];
    for (const tr of trains) { scene.remove(tr.g); disposeTree(tr.g); }
    trains.length = 0;
    return;
  }
  // 駅がいちばん多く乗っている線形を走らせる(同数なら長いほう)。
  // 長さだけで選ぶと、駅が別の線形に乗っていて永久に停まらないことがある。
  const nSt = new Map();
  for (const s of stationStops) nSt.set(s.p, (nSt.get(s.p) ?? 0) + 1);
  trainPath = railPaths.reduce((a, b) =>
    ((nSt.get(b) ?? 0) - (nSt.get(a) ?? 0) || b.len - a.len) > 0 ? b : a);

  // 駅での停車位置(線形上の距離)。この線形に乗った駅ぜんぶに停まる
  trainStopDs = stationStops.filter((s) => s.p === trainPath)
    .map((s) => s.d).sort((a, b) => a - b);

  // 本数を線形の長さに合わせる
  const want = Math.max(TRAIN_MIN,
    Math.min(TRAIN_MAX, Math.round(trainPath.len / TRAIN_GAP)));
  while (trains.length > want) {
    const tr = trains.pop();
    scene.remove(tr.g); disposeTree(tr.g);
  }
  while (trains.length < want) {
    const g = makeTrainCars();
    trains.push({
      g, d: 0, dir: 1, wait: 0,
      // 乗り物としての顔(バスと同じ扱いにして乗降処理を共通化する)
      ride: { g, ref: 'ゆいレール', name: '沖縄都市モノレール線',
              seat: { x: 0, y: 0.15, z: 7.2 },   // 前寄りの車両の中ほど
              isTrain: true, wait: 0 },
    });
  }

  // 位置。引き継ぎがあれば世界座標で拾い直し、無ければ **線形上を等分して
  // 向きを交互にする**。往復1周(2×len)を等分すると、往路の車両と復路の車両が
  // 同じ地点に重なり(位相 p と 2len-p が同じ d を指す)、駅に2本まとめて着いて
  // しまう(実測で到着の間隔が 0分と1.1分の繰り返しになった)。
  const cyc = trainPath.len * 2;
  trains.forEach((tr, i) => {
    const keep = keeps?.[i];
    if (keep) {
      let bd = Infinity;
      for (let d = 0; d <= trainPath.len; d += 4) {
        const q = railAt(trainPath, d);
        const e = Math.hypot(q.x - keep.x, q.z - keep.z);
        if (e < bd) { bd = e; tr.d = d; }
      }
      tr.dir = keep.dir;
    } else {
      tr.d = (i / trains.length) * trainPath.len;
      tr.dir = (i % 2) ? -1 : 1;
    }
    tr.d = Math.max(0, Math.min(trainPath.len, tr.d));
  });

  const round = cyc / TRAIN_SPEED + trainStopDs.length * 2 * TRAIN_DWELL + 6;
  console.log(`列車 ${trains.length}本 / 線形 ${Math.round(trainPath.len)}m / ` +
    `停車 ${trainStopDs.length}駅 / 同じ駅に次が来るまで約` +
    `${(round / trains.length / 60).toFixed(1)}分`);
}

/** モノレールの車両を進める(駅ぜんぶで停車し、端に着いたら折り返す)。 */
function stepTrain(dt) {
  if (!trainPath) return;
  for (const tr of trains) {
    if (tr.wait > 0) {
      tr.wait -= dt;
    } else {
      const prev = tr.d;
      tr.d += tr.dir * TRAIN_SPEED * dt;
      if (tr.d > trainPath.len) { tr.d = trainPath.len; tr.dir = -1; tr.wait = 3; }
      if (tr.d < 0) { tr.d = 0; tr.dir = 1; tr.wait = 3; }
      // 通り過ぎた駅があれば、そこへ戻して停める。
      // 1フレームで進むのは約0.2mなので普通は1駅ぶんだが、
      // タブが止まって dt が伸びたときのために手前の駅を選ぶ
      let stopAt = null;
      for (const sd of trainStopDs) {
        if ((prev < sd && tr.d >= sd) || (prev > sd && tr.d <= sd)) {
          if (stopAt === null || Math.abs(sd - prev) < Math.abs(stopAt - prev)) stopAt = sd;
        }
      }
      if (stopAt !== null) { tr.d = stopAt; tr.wait = TRAIN_DWELL; }
    }
    const q = railAt(trainPath, tr.d);
    tr.g.position.set(q.x, q.y + 0.9, q.z);     // 桁をまたぐので少し上に乗せる
    tr.g.rotation.y = q.yaw + (tr.dir < 0 ? Math.PI : 0);
    tr.ride.wait = tr.wait;
  }
}

// ---------------------------------------------------------------- 水面
// 那覇は水の街なのに、これまで水が1つも無かった。奥武山まわりの地形は
// 標高 -0.1m まで下がっていて 21% のセルが 0.2m 以下＝水が来るべき低地が
// 正しく凹んでいるのに、そこが乾いた土のまま広がっていた。
//
// **水位は池ごとに1つ**（tools/build_water_levels.py が世界ぜんぶの DEM から
// 決めた対応表を引く）。漫湖は 0.0m、龍潭は首里の高台で 92.0m。世界に1枚
// 平面を張って済ませることはできない。
const WATER_COL = { water: 0x2d6b78, wetland: 0x3f6b58 };
// 川。**タイルに分けない。** 水面の高さが川筋に沿って変わるので、タイルごとに
// 決めると継ぎ目で段差になる(池で実際に踏んだ)。世界ぜんぶを1本の折れ線として
// 持ち、点ごとに高さを持たせて幅で膨らませたリボンにする。
const riverData = await fetch('./data/rivers.json')
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);

const RIVER_CELL = 120;
const rmapW = new Map();          // 川の線分の升目。泳ぎの判定に使う
let riverMesh = null;

function buildRivers() {
  if (!riverData) return;
  const V = [];
  for (const r of riverData.rivers) {
    const f = r.f, n = f.length / 3, hw = r.w / 2;
    if (n < 2) continue;
    // 各点の法線は前後の向きの平均。曲がり角で幅が痩せない
    const nx = new Float32Array(n), nz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = f[b * 3] - f[a * 3], dz = f[b * 3 + 1] - f[a * 3 + 1];
      const L = Math.hypot(dx, dz) || 1;
      nx[i] = -dz / L; nz[i] = dx / L;
    }
    for (let i = 0; i < n - 1; i++) {
      const x0 = f[i * 3], z0 = f[i * 3 + 1], y0 = f[i * 3 + 2];
      const x1 = f[(i + 1) * 3], z1 = f[(i + 1) * 3 + 1], y1 = f[(i + 1) * 3 + 2];
      const ax = x0 + nx[i] * hw, az = z0 + nz[i] * hw;
      const bx = x0 - nx[i] * hw, bz = z0 - nz[i] * hw;
      const cx = x1 + nx[i + 1] * hw, cz = z1 + nz[i + 1] * hw;
      const dx2 = x1 - nx[i + 1] * hw, dz2 = z1 - nz[i + 1] * hw;
      // 上から見る向き
      V.push(ax, y0, az, cx, y1, cz, bx, y0, bz);
      V.push(bx, y0, bz, cx, y1, cz, dx2, y1, dz2);

      // 判定用に線分を升目へ配る
      const seg = { x0, z0, y0, x1, z1, y1, hw };
      const g0 = Math.floor(Math.min(x0, x1) / RIVER_CELL);
      const g1 = Math.floor(Math.max(x0, x1) / RIVER_CELL);
      const h0 = Math.floor(Math.min(z0, z1) / RIVER_CELL);
      const h1 = Math.floor(Math.max(z0, z1) / RIVER_CELL);
      for (let gx = g0; gx <= g1; gx++) {
        for (let gz = h0; gz <= h1; gz++) {
          const k = `${gx},${gz}`;
          (rmapW.get(k) ?? rmapW.set(k, []).get(k)).push(seg);
        }
      }
    }
  }
  if (!V.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
  geo.computeVertexNormals();
  riverMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    color: WATER_COL.water,
  }));
  addWave(riverMesh.material, 1.9);
  riverMesh.renderOrder = 1;
  scene.add(riverMesh);
  console.log(`川 ${riverData.rivers.length}本 / 三角形 ${V.length / 9}`);
}

// 水の中に居るときの見え方。フォグを水の色にして一気に近づける。
// 空ドームは depthWrite:false で常に描かれるので、水中では隠す
// (隠さないと、水面より下に居るのに空が見えてしまう)。
const AIR_FOG = { color: SKY_BOT.getHex(), near: 260, far: 1250 };
const WET_FOG = { color: 0x14434f, near: 0.6, far: 34 };
let wasUnder = false;

/**
 * 目が水面より下かどうかで、フォグと空を切り替える。
 *
 * **足元ではなく目で判定する。** 泳ぎ(inWater)は足元が水面より下なら真に
 * なるので、それで切り替えると立ち泳ぎで顔が出ているのに水中の絵になる。
 */
// 水面のゆらぎ。頂点を動かすと当たり判定と食い違うので、**色だけ**を揺らす。
// 実測で水面は 78面＋川193本＝マテリアルは数個しかないので、
// 毎フレーム色を書き換えても描画の回数は増えない。
const WAVE = [];                  // 揺らすマテリアル {mat, base, phase}
let waveT = 0;

function addWave(mat, phase) {
  WAVE.push({ mat, base: mat.color.clone(), phase });
}

function stepWaves(dt) {
  if (!WAVE.length) return;
  waveT += dt;
  for (const w of WAVE) {
    // ゆっくり明暗するだけ。海と池と川で位相をずらすと、
    // 同じ色の面が一斉に光らない
    const k = 1 + Math.sin(waveT * 0.55 + w.phase) * 0.055;
    w.mat.color.setRGB(w.base.r * k, w.base.g * k, w.base.b * k);
  }
}

function stepUnderwater() {
  const surf = waterAt(player.x, player.z);
  const under = surf !== null && player.y < surf - 0.02;
  if (under === wasUnder) return;
  wasUnder = under;
  const f = under ? WET_FOG : AIR_FOG;
  scene.fog.color.setHex(f.color);
  scene.fog.near = f.near;
  scene.fog.far = f.far;
  sky.visible = !under;
  document.body.classList.toggle('under', under);
}

/** (x,z) が川の中なら水面の高さ。外なら null。 */
function riverAt(x, z) {
  const segs = rmapW.get(`${Math.floor(x / RIVER_CELL)},${Math.floor(z / RIVER_CELL)}`);
  if (!segs) return null;
  let best = null, bd = Infinity;
  for (const s of segs) {
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - s.x0) * dx + (z - s.z0) * dz) / L2));
    const qx = s.x0 + t * dx, qz = s.z0 + t * dz;
    const d = Math.hypot(x - qx, z - qz);
    if (d <= s.hw && d < bd) { bd = d; best = s.y0 + (s.y1 - s.y0) * t; }
  }
  return best;
}

let seaMesh = null;

/** 海面。世界ぜんぶに1枚。地形より低い所だけが見える。 */
function buildSea() {
  if (seaMesh) {
    scene.remove(seaMesh);
    seaMesh.geometry.dispose();
    seaMesh.material.dispose();
    seaMesh = null;
  }
  if (!coast) return;
  const [x0, z0, x1, z1] = coast.meta.bbox;
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geo.rotateX(-Math.PI / 2);
  geo.translate((x0 + x1) / 2, SEA, (z0 + z1) / 2);
  seaMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: SEA_COL }));
  addWave(seaMesh.material, 0);
  seaMesh.renderOrder = -1;      // 受け皿より先に描く
  scene.add(seaMesh);
  console.log(`海面 ${Math.round(x1 - x0)}x${Math.round(z1 - z0)}m @ ${SEA}m`);
}
buildSea();
buildRivers();

const SWIM = 1.9;              // 泳ぐ速さ(m/s)。歩き4.6よりずっと遅い
const SWIM_V = 1.5;            // 沈む/浮く速さ(m/s)
const FLOAT = 0.22;            // 立ち泳ぎのとき水面から出る目の高さ(m)
const WADE = 0.7;              // これより浅ければ歩いて渡れる(m)
const waters = [];                 // {ring, minx, maxx, minz, maxz, y, k, tile}
const wmap = new Map();            // 空間ハッシュ。泳ぎの判定に使う

/** タイル t の水面を張る。 */
function addWater(t) {
  const list = t.data.water ?? [];
  if (!list.length) return 0;
  const byKind = new Map();
  for (const w of list) {
    const f = w.f, m = f.length / 2;
    if (m < 3) continue;
    const ring = new Array(m);
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < m; i++) {
      const x = t.X(f[i * 2]), z = t.Z(f[i * 2 + 1]);
      ring[i] = new THREE.Vector2(x, z);
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    // name は釣りの見出しに使う(「龍潭に糸をたらした」)。
    // **魚の種類は名前では変えない**。個々の池に何が居るかは手元のデータに
    // 無いので、言えるのは水域の種別までにとどめる
    const rec = { ring, minx, maxx, minz, maxz, y: w.y, k: w.k,
                  name: w.name || '', tile: t.key };
    waters.push(rec);
    hashInsert(wmap, rec);

    // 種別ごとに1つのジオメトリへ畳む(描画は種別の数だけで済む)
    const V = byKind.get(w.k) ?? [];
    byKind.set(w.k, V);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(ring, [])) {
      // 上から見る面。反時計回りだと法線が下を向くので順序を入れ替える
      for (const i of [a, c, b]) V.push(ring[i].x, w.y, ring[i].y);
    }
  }
  let n = 0;
  for (const [kind, V] of byKind) {
    if (!V.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: WATER_COL[kind] ?? WATER_COL.water,
    }));
    addWave(mesh.material, waters.length * 0.7);
    mesh.renderOrder = 1;            // 地形と同じ高さで喧嘩したとき水を上に
    t.group.add(mesh);
    n++;
  }
  console.log(`[${t.key}] 水面 ${list.length}面 / 描画${n}`);
  return list.length;
}

function dropWater(key) {
  for (let i = waters.length - 1; i >= 0; i--) {
    if (waters[i].tile === key) waters.splice(i, 1);
  }
  hashRemove(wmap, (r) => r.tile === key);
}

/**
 * (x,z) の水面の高さ。水の無い所は null。
 *
 * 重なっている面があれば **高いほうを採る**。漫湖のような広い面の上に
 * 小さな池が乗っている所で、低いほうを採ると池が消える。
 */
function waterAt(x, z) {
  // 池が無い升目でも、川と海を見にいく必要がある。
  // ここで早く返してしまうと川の上でも水が無いことになる(実際にそうなっていた)
  const hits = wmap.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`) ?? [];
  let best = null;
  for (const w of hits) {
    if (x < w.minx || x > w.maxx || z < w.minz || z > w.maxz) continue;
    const g = w.ring, m = g.length;
    let inside = false;
    for (let k = 0, l = m - 1; k < m; l = k++) {
      const a = g[k], c = g[l];
      if ((a.y > z) !== (c.y > z) &&
          x < (c.x - a.x) * (z - a.y) / (c.y - a.y) + a.x) inside = !inside;
    }
    if (inside && (best === null || w.y > best)) best = w.y;
  }
  if (best !== null) return best;
  const rv = riverAt(x, z);
  if (rv !== null) return rv;
  // 池でなくても、海の側で地面が海面より低ければ海
  if (groundAt(x, z) < SEA && isSea(x, z)) return SEA;
  return null;
}

// ------------------------------------------------------------ 車とタクシー
// 道路の「面」しか無かったので、これまで走っていたのは経路を持つバスと
// モノレールだけだった。OSM の車道中心線(roadLines)を足して、一般の車を流す。
//
// 歩行者(walkLines/peds)とまったく同じ作りにしてある:
//   タイルを読んだら線を足し、捨てたら外す。線に乗った者は乗り換え先を探す。
// 違うのは、①車は交差点で信号を見る ②左側通行なので車線ぶん横にずらす
// ③台数が多いので InstancedMesh に畳む、の3点。
const carLines = [];                    // {pts, cum, len, k, ow, tile}
const cars = [];
const CAR_N = 44;                       // 同時に走らせる台数(描画は4回で済む)
const CAR_NEAR = [40, 260];             // この距離の帯に湧かし直す(m)
const CAR_SPD = [15.5, 11.5, 8.5, 6.0]; // 道の格ごとの速さ(m/s)
// 中心線からの車線のずらし(m)。道の格ごとに変える。生活道路(k=3)は
// 幅が4〜5mしかないので、幹線と同じだけずらすと路肩から出て建物にめり込む
// (実測で44台中8台が道路面の外に居て、全部 k=3 だった)
const LANE = [2.4, 2.0, 1.6, 1.0];
const TAXI_RATE = 0.22;                 // タクシーの割合
// 沖縄の街を走っている車の色。白と銀が多いので厚めに入れてある
const CAR_COL = [0xe9e9e6, 0xdcdde0, 0xc9ccd0, 0x2f3438, 0x8f989e,
                 0x2b4a6f, 0x7a2b2b, 0x2f5c3a];
const TAXI_COL = [0xf2e8d8, 0xdfe9ef, 0xeae2c8];  // 沖縄のタクシーは淡い車体が多い

/** タイル t の車道中心線を道路網に足す。 */
function addCarLines(t) {
  let n = 0;
  for (const r of t.data.roadLines ?? []) {
    const pts = [];
    for (let i = 0; i < r.f.length; i += 2) {
      pts.push({ x: t.X(r.f[i]), z: t.Z(r.f[i + 1]) });
    }
    if (pts.length < 2) continue;
    const cum = [0];
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      cum.push(len);
    }
    // 切り出しで生じる数十cmの破片は乗り換え先としてしか意味が無い。
    // 乗せると1フレームで通り抜けてしまうので、線としては持たない
    if (len < 8) continue;
    carLines.push({ pts, cum, len, k: r.k, ow: r.ow, tile: t.key });
    n++;
  }
  return n;
}

function dropCarLines(key) {
  for (let i = carLines.length - 1; i >= 0; i--) {
    if (carLines[i].tile === key) carLines.splice(i, 1);
  }
  // 消えた道に乗っていた車は湧かし直させる
  for (const c of cars) if (c.L && c.L.tile === key) c.alive = false;
}

/**
 * 端点 p から続く道を探す。
 *
 * 正式なグラフは組まない。OSM の way は交差点で切れているので、
 * **端点どうしが近いこと**がそのまま接続を表す。曲がれる先が無ければ
 * 元の道を逆向きに返す(行き止まりでのUターン)。
 */
function nextCarLine(from, px, pz, R = 7) {
  const cand = [];
  for (const L of carLines) {
    if (L === from) continue;
    const a = L.pts[0], b = L.pts[L.pts.length - 1];
    if (Math.hypot(a.x - px, a.z - pz) < R) cand.push({ L, dir: 1, d: 0 });
    if (Math.hypot(b.x - px, b.z - pz) < R) cand.push({ L, dir: -1, d: L.len });
  }
  // 一方通行は入れる向きだけ通す
  const ok = cand.filter((c) => !c.L.ow || c.L.ow === c.dir);
  if (!ok.length) return null;
  return ok[(Math.random() * ok.length) | 0];
}

/** 端点の近くに信号があれば、その交差点と系統を返す。 */
function signalAt(px, pz, yaw, R = 15) {
  let best = null, bd = R;
  for (const s of signals) {
    if (s.k !== 'car') continue;
    const d = Math.hypot(s.x - px, s.z - pz);
    if (d < bd) { bd = d; best = s; }
  }
  if (!best) return null;
  // 東西に進むなら axis 0、南北なら axis 1（バスの停止線と同じ決め方）
  const axis = Math.abs(Math.sin(yaw)) >= Math.abs(Math.cos(yaw)) ? 0 : 1;
  return { g: best.g, axis };
}

function spawnCar(c, force = false) {
  if (!carLines.length) { c.alive = false; return; }
  for (let tries = 0; tries < 24; tries++) {
    const L = carLines[(Math.random() * carLines.length) | 0];
    const d = Math.random() * L.len;
    // force のときは player を見ない。この関数は初期化ブロックからも呼ばれ、
    // player はこの下で宣言されるので、触ると TDZ で落ちる
    if (!force) {
      const q = walkAt(L, d);
      const dist = Math.hypot(q.x - player.x, q.z - player.z);
      if (dist < CAR_NEAR[0] || dist > CAR_NEAR[1]) continue;
    }
    c.L = L; c.d = d;
    c.dir = L.ow ? L.ow : (Math.random() < 0.5 ? 1 : -1);
    c.wait = 0; c.sig = null; c.alive = true;
    return;
  }
  c.alive = false;
}

let carBody = null, carRoof = null, carWheel = null, carLamp = null;

{
  for (const t of tiles.values()) { addCarLines(t); addWater(t); }

  // 車体・屋根・タイヤ・行灯の4つに畳む。台数を増やしても描画は4回のまま。
  // バスのように1台ずつ Group にすると、44台で 300 回を超える
  const bodyGeo = new THREE.BoxGeometry(1.72, 0.62, 4.15);
  const roofGeo = new THREE.BoxGeometry(1.56, 0.56, 2.25);
  const wheelGeo = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 8);
  wheelGeo.rotateZ(Math.PI / 2);
  const lampGeo = new THREE.BoxGeometry(0.5, 0.17, 0.24);
  const cmat = () => new THREE.MeshLambertMaterial({ vertexColors: false });
  carBody = new THREE.InstancedMesh(bodyGeo, cmat(), CAR_N);
  carRoof = new THREE.InstancedMesh(roofGeo, cmat(), CAR_N);
  carWheel = new THREE.InstancedMesh(wheelGeo, cmat(), CAR_N * 4);
  carLamp = new THREE.InstancedMesh(lampGeo, cmat(), CAR_N);
  for (const [im, n] of [[carBody, CAR_N], [carRoof, CAR_N],
                         [carWheel, CAR_N * 4], [carLamp, CAR_N]]) {
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    im.castShadow = true;
    im.frustumCulled = false;           // 毎フレーム行列を書き換えるので境界球が当てにならない
    scene.add(im);
  }
  const col = new THREE.Color();
  for (let i = 0; i < CAR_N; i++) {
    const taxi = Math.random() < TAXI_RATE;
    const c = {
      L: null, d: 0, dir: 1, wait: 0, sig: null, alive: false,
      taxi, spd: 0,
      col: taxi ? TAXI_COL[(Math.random() * TAXI_COL.length) | 0]
                : CAR_COL[(Math.random() * CAR_COL.length) | 0],
    };
    cars.push(c);
    spawnCar(c, true);
    col.setHex(c.col);
    carBody.setColorAt(i, col);
    // 屋根は車体より少し暗くする(窓の帯に見える)
    carRoof.setColorAt(i, col.clone().multiplyScalar(0.62));
    col.setHex(0x22262a);
    for (let w = 0; w < 4; w++) carWheel.setColorAt(i * 4 + w, col);
    // 行灯。タクシーでない車は下の stepCars で潰して消す
    col.setHex(0xf6e7b0);
    carLamp.setColorAt(i, col);
  }
  for (const im of [carBody, carRoof, carWheel, carLamp]) im.instanceColor.needsUpdate = true;
}

const CAR_M = new THREE.Matrix4(), CAR_Q = new THREE.Quaternion();
const CAR_P = new THREE.Vector3(), CAR_S = new THREE.Vector3();
const CAR_E = new THREE.Euler();
const CAR_HIDE = new THREE.Vector3(0.0001, 0.0001, 0.0001);

/** 車を1フレーム進める。 */
function stepCars(dt, now) {
  if (!carLines.length) return;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.alive) { spawnCar(c); }
    if (!c.alive || !c.L) { hideCar(i); continue; }

    const L = c.L;
    c.spd = CAR_SPD[L.k] ?? 6.0;

    // 信号待ち。交差点は道の端にあるので、端に着いたところで見る
    if (c.sig) {
      if (sigPhase(c.sig.g, c.sig.axis, now) === 'g') c.sig = null;
    } else {
      c.d += c.spd * dt * c.dir;
      if (c.d <= 0 || c.d >= L.len) {
        const end = c.dir > 0 ? L.pts[L.pts.length - 1] : L.pts[0];
        const q0 = walkAt(L, c.dir > 0 ? L.len : 0);
        const sg = signalAt(end.x, end.z, q0.yaw);
        if (sg && sigPhase(sg.g, sg.axis, now) !== 'g') {
          // 停止線で待つ。線の端に張り付ける
          c.d = c.dir > 0 ? L.len : 0;
          c.sig = sg;
        } else {
          const nx = nextCarLine(L, end.x, end.z);
          if (nx) { c.L = nx.L; c.d = nx.d; c.dir = nx.dir; }
          else { c.dir = -c.dir; c.d = Math.max(0, Math.min(L.len, c.d)); }
        }
      }
    }

    const q = walkAt(c.L, c.d);
    const yaw = q.yaw + (c.dir < 0 ? Math.PI : 0);
    // 左側通行。進行方向の左へ車線ぶんずらす
    const lane = LANE[c.L.k] ?? 1.2;
    const ox = Math.cos(yaw) * -lane, oz = Math.sin(yaw) * lane;
    const x = q.x + ox, z = q.z + oz;
    const gy = groundAt(x, z);

    // 遠い車は描かない(位置は進め続ける。戻ってきたときに街が止まって見えない)
    const dist = Math.hypot(x - player.x, z - player.z);
    if (dist > CAR_NEAR[1] + 120) { c.alive = false; hideCar(i); continue; }
    if (dist > 190) { hideCar(i); continue; }

    CAR_E.set(0, yaw, 0); CAR_Q.setFromEuler(CAR_E);
    CAR_S.set(1, 1, 1);
    CAR_P.set(x, gy + 0.62, z);
    CAR_M.compose(CAR_P, CAR_Q, CAR_S); carBody.setMatrixAt(i, CAR_M);
    CAR_P.set(x, gy + 1.18, z - 0);
    CAR_M.compose(CAR_P, CAR_Q, CAR_S); carRoof.setMatrixAt(i, CAR_M);
    // 行灯はタクシーだけ。他は潰して消す
    if (c.taxi) {
      CAR_P.set(x, gy + 1.52, z);
      CAR_M.compose(CAR_P, CAR_Q, CAR_S);
    } else {
      CAR_M.compose(CAR_P.set(x, gy, z), CAR_Q, CAR_HIDE);
    }
    carLamp.setMatrixAt(i, CAR_M);

    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let w = 0;
    for (const [fwd, side] of [[1.3, 0.82], [1.3, -0.82], [-1.3, 0.82], [-1.3, -0.82]]) {
      CAR_P.set(x + fx * fwd + rx * side, gy + 0.31, z + fz * fwd + rz * side);
      CAR_M.compose(CAR_P, CAR_Q, CAR_S);
      carWheel.setMatrixAt(i * 4 + w++, CAR_M);
    }
  }
  carBody.instanceMatrix.needsUpdate = true;
  carRoof.instanceMatrix.needsUpdate = true;
  carWheel.instanceMatrix.needsUpdate = true;
  carLamp.instanceMatrix.needsUpdate = true;
}

function hideCar(i) {
  CAR_Q.identity(); CAR_P.set(0, -9999, 0);
  CAR_M.compose(CAR_P, CAR_Q, CAR_HIDE);
  carBody.setMatrixAt(i, CAR_M);
  carRoof.setMatrixAt(i, CAR_M);
  carLamp.setMatrixAt(i, CAR_M);
  for (let w = 0; w < 4; w++) carWheel.setMatrixAt(i * 4 + w, CAR_M);
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

// ------------------------------------------------------------ 歩きだす場所
// 既定は城東小まわり(原点)。モノレールの駅からも始められる。
// corridor.json は全16駅を持っていて起動時に読めているので、タイルが
// まだ載っていない駅も選べる（選んでから、そこのタイルを読みに行く）。
const SPAWN_KEY = 'jouto-walk:spawn';

/** ゆいレールの駅を、那覇空港から石嶺までの並び順で返す。 */
function spawnPoints() {
  const st = (corridor?.stations ?? []).slice();
  // 線形上の距離では並べ替えられない(駅が乗る線形が1本とは限らない)ので、
  // 空港から石嶺へ向かう向き=西から東・南から北に近い順で並べる
  st.sort((a, b) => (a.x - b.x) || (b.z - a.z));
  return st;
}

function fillSpawnSelect() {
  const sel = $('spawn-sel');
  if (!sel) return;
  for (const st of spawnPoints()) {
    const o = document.createElement('option');
    o.value = st.name;
    o.textContent = `${st.name}駅`;
    sel.appendChild(o);
  }
  // ?at=首里 で直に指定できる。前回選んだ場所も覚えておく
  const want = new URLSearchParams(location.search).get('at')
            ?? localStorage.getItem(SPAWN_KEY) ?? '';
  if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
  sel.addEventListener('change', () => {
    try { localStorage.setItem(SPAWN_KEY, sel.value); } catch {}
  });
}
fillSpawnSelect();

/**
 * 選ばれた場所へプレイヤーを移す。タイルはこのあと syncTiles が読む。
 *
 * 駅そのものの真上ではなく少し手前に降ろす。駅は高架なので、真下は
 * 桁の下になって空が見えない。
 */
function applySpawn(name) {
  if (!name) return false;
  const st = spawnPoints().find((s) => s.name === name);
  if (!st) return false;
  player.x = st.x + 18;
  player.z = st.z + 18;
  player.y = groundAt(player.x, player.z) + EYE;
  player.vy = 0; player.onGround = true;
  player.yaw = Math.atan2(-(st.x - player.x), -(st.z - player.z));  // 駅の方を向く
  player.pitch = 0.06;
  return true;
}

// 最後に飛んだ先。選び直されたときだけ動かす（一時停止からの再開で
// 毎回そこへ引き戻されては困る）。空文字＝城東小まわり＝初期位置
let lastSpawn = '';

/**
 * 移った先のタイルが本当に載ってから、地表に座り直す。
 *
 * applySpawn の時点の groundAt は、まだ載っていないタイルを最寄りのタイルの
 * 縁で埋めた値なので当てにならない。**syncTiles を1回待つだけでは足りない**:
 * すでに読み込みが走っているときは `syncing` で即座に返るので、待ったつもりで
 * 古いタイルのまま高さを決めてしまう（本番で地面より 55.8m 上に立った）。
 * 自分の乗るタイルが tiles に入るまで見張る。
 */
async function seatOnSpawn() {
  for (let i = 0; i < 80; i++) {          // 最大8秒。届かなければ諦めて座る
    await syncTiles();
    if (tileOf(player.x, player.z)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  player.y = supportY(player.x, player.z) + EYE;
  player.vy = 0; player.onGround = true;
}

/**
 * 選ばれた場所へ移ってから歩きだす。
 *
 * **タイルが揃うまでカードを出したままにする。** 先に始めてしまうと、
 * 建物の多い所（おもろまち周辺は6枚で12,014棟。城東小まわりの1.5倍）では
 * 組み立てのあいだ操作を受け付けず、固まったように見える。
 */
async function goSpawn(name) {
  const go = $('go');
  const label = go.textContent;
  go.disabled = true;
  go.textContent = '読み込み中…';
  $('meta').textContent = `${name}駅 のまわりを読み込んでいます`;
  applySpawn(name);
  await seatOnSpawn();
  lastSpawn = name;
  go.disabled = false;
  go.textContent = label;
  $('meta').textContent = `シーサー ${taken} / ${SEESAA_TOTAL} 体を保護ずみ`;
  say(`${name}駅 から歩きだす`);
}

function start() {
  // 選び直されていたら、そこへ移ってから歩きだす。一時停止して駅を
  // 選び直せば、何度でも移れる。選び直していなければその場で再開する
  const name = $('spawn-sel')?.value ?? '';
  if (name && name !== lastSpawn && spawnPoints().some((s) => s.name === name)) {
    goSpawn(name).then(start);        // 読み終わってから改めて歩きだす
    return;
  }
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
  $('meta').textContent = `シーサー ${taken} / ${SEESAA_TOTAL} 体を保護ずみ`;
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

// ---------------------------------------------------------------- 史跡の案内
// 説明は **出典のあるものだけ**（OSM の碑文・現地案内板の写し／Wikipedia 日本語版の
// 冒頭）。289 件ぜんぶに機械が解説を書くと、史実でないことを史実として載せる
// ことになる。議事の要約を言い換えなかったのと同じ理由。
// 出典が無い史跡は名前と種別だけ出す。それでよい。
let siteNotes = {};
fetch('./data/site_notes.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    siteNotes = d ?? {};
    const n = Object.keys(siteNotes).length;
    if (n) console.log(`史跡の説明 ${n}件（OSM・Wikipedia）`);
  })
  .catch(() => {});

// 指定の強さ。バッジに一つだけ出すときの順番
const KIND_ORDER = ['登録有形文化財', '史跡名勝天然記念物', '国宝・重要文化財', '世界遺産'];
const KIND_RANK = (k) => KIND_ORDER.findIndex((o) => k.startsWith(o));

const SITE_R = 22;                 // この距離まで近づくと案内が出る(m)
let siteNear = null, siteClosed = false;
const svEl = $('site');

function showSite(g) {
  if (!g || siteClosed) { svEl.classList.remove('on'); return; }
  const h = g.userData.site;
  // 1つの史跡がいくつもの指定を持つ（玉陵は世界遺産・史跡・国宝が計7件）。
  // 解説は全体を指すものを使い、指定の種別はぜんぶ並べる
  const hz = g.userData.solo ? [h] : heritageFor(h, g.position.x, g.position.z);
  const note = siteNotes[h.name];
  const lead = hz.find((r) => r.text) ?? hz[0];
  let text, src, url;
  if (lead?.text) {
    // 文化庁の解説を最優先にする。公的な文で、出典がはっきりしている
    text = lead.text; src = '文化庁 国指定文化財等データベース'; url = lead.url;
  } else if (note?.text) {
    text = note.text; src = note.src; url = note.url;
  } else if (h.text) {
    text = h.text; src = 'OpenStreetMap';
    url = 'https://www.openstreetmap.org/copyright';
  } else {
    text = 'この場所の説明はまだ集まっていません。'; src = ''; url = '';
  }
  // 見出しのバッジは強い指定を一つだけ。玉陵は3種類の指定を持つので
  // 全部並べるとバッジが2行になり、名前が押し出される（実機375pxで実測）
  const kinds = [...new Set((g.userData.solo ? h.k.split('／') : hz.map((r) => r.k)))];
  $('sv-kind').textContent = kinds.length
    ? [...kinds].sort((p, q) => KIND_RANK(q) - KIND_RANK(p))[0]
    : h.k;
  $('sv-name').textContent = h.name;
  $('sv-text').textContent = text;
  // 同じ史跡に付いている他の指定（玉陵の各墓室、新垣家住宅の主屋・ヒンプン…）
  // は名前だけ添える。まとめたものは取得側が parts に持っている
  // 同名の指定が重なる（玉陵は世界遺産と史跡の両方が「玉陵」）ので名前で畳む
  const more = [...new Set((g.userData.solo ? (h.parts ?? [])
    : hz.map((r) => r.name)).filter((n) => n !== lead?.name && n !== h.name))];
  const lines = [];
  if (kinds.length > 1) lines.push(`指定: ${kinds.join('／')}`);
  if (more.length) lines.push(`国指定: ${more.join('、')}`);
  $('sv-more').textContent = lines.join('\n');
  const a = $('sv-link');
  a.href = url || '#';
  a.style.visibility = url ? 'visible' : 'hidden';
  $('sv-src').textContent = src;
  svEl.classList.add('on');
}

$('sv-close').addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  siteClosed = true; svEl.classList.remove('on');
});

// ---------------------------------------------------------------- 人口メッシュ
// 令和2年国勢調査の地域メッシュ統計(e-Stat 統計GIS T001102、250m メッシュ)。
// **小地域(町丁字)ではなくメッシュを選んだ**。この world は 3 次メッシュ由来の
// 1km タイルでできているので、メッシュはコードから緯度経度が出せてそのまま
// 座標に乗る。町丁字だと境界ポリゴンを別に落として名前で突き合わせる工程が要る。
//
// 那覇の緯度では 1 セルは約 232m × 312m(3 次メッシュが 30秒×45秒で正方形でない)。
const meshCells = [];
const meshMap = new Map();                 // 空間ハッシュ。升目 500m
const MESH_HASH = 500;
fetch('./data/mesh_pop.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    for (const c of d?.cells ?? []) {
      meshCells.push(c);
      const gx = Math.floor(c.x / MESH_HASH), gz = Math.floor(c.z / MESH_HASH);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const k = `${gx + i},${gz + j}`;
          (meshMap.get(k) ?? meshMap.set(k, []).get(k)).push(c);
        }
      }
    }
    if (meshCells.length) console.log(`人口メッシュ ${meshCells.length}セル`);
  })
  .catch(() => {});

/** (x,z) を含むメッシュのセル。無ければ null。 */
function meshAt(x, z) {
  const hits = meshMap.get(`${Math.floor(x / MESH_HASH)},${Math.floor(z / MESH_HASH)}`);
  if (!hits) return null;
  for (const c of hits) {
    if (Math.abs(x - c.x) <= c.w / 2 && Math.abs(z - c.z) <= c.d / 2) return c;
  }
  return null;
}

// ---------------------------------------------------------------- ミニマップ
// 世界が 10km × 7km まで広がるので、全体を1枚に収めると 53m/px になって
// 街が潰れる(建物1棟が 0.28px)。**プレイヤーの周りだけを一定の縮尺で見せる**。
// 下地はタイルごとに焼いておき、毎フレーム窓の位置に貼り直す。
const map = $('map'), mctx = map.getContext('2d');
const MS = map.width;
const MAP_SPAN = 1200;        // 地図に写す一辺(m)。1タイルより少し広い
const MAP_TILE_PX = 256;      // タイル1枚ぶんの下地の解像度(px) = 3.9m/px

/** タイル t の下地(道路と建物)を小さな canvas に焼く。読み込んだときに1回だけ。 */
function bakeTileMap(t) {
  const c = document.createElement('canvas');
  c.width = c.height = MAP_TILE_PX;
  const b = c.getContext('2d');
  const k = MAP_TILE_PX / TILE;
  const X = (v) => (v - t.offX + HALF) * k;
  const Z = (v) => (v - t.offZ + HALF) * k;
  b.fillStyle = '#16302f';
  b.fillRect(0, 0, MAP_TILE_PX, MAP_TILE_PX);
  // 道路を先に敷く(街路の骨格が見えると現在地を掴みやすい)
  b.fillStyle = 'rgba(190,205,205,.30)';
  b.beginPath();
  for (const r of rstore) {
    if (r.tile !== t.key) continue;
    b.moveTo(X(r.ring[0].x), Z(r.ring[0].y));
    for (let i = 1; i < r.ring.length; i++) b.lineTo(X(r.ring[i].x), Z(r.ring[i].y));
    b.closePath();
  }
  b.fill();
  b.fillStyle = 'rgba(246,243,234,.42)';
  for (const bd of bstore) {
    if (bd.tile !== t.key) continue;
    b.beginPath();
    b.moveTo(X(bd.ring[0].x), Z(bd.ring[0].y));
    for (let i = 1; i < bd.ring.length; i++) b.lineTo(X(bd.ring[i].x), Z(bd.ring[i].y));
    b.closePath(); b.fill();
  }
  t.mapTile = c;
}

/** まだ下地の無いタイルを焼く。タイルを足し引きしたあとに呼ぶ。 */
function bakeMap() {
  for (const t of tiles.values()) if (!t.mapTile) bakeTileMap(t);
}
bakeMap();
settleCouncil();

// マーカーは 188px 表示を基準に描いていたので、実解像度に合わせて拡大する
const MK = MS / 188;

function drawMap() {
  // 窓はプレイヤー中心。店内に居るあいだは街での立ち位置で描く
  const cx = hereX(), cz = hereZ();
  const k = MS / MAP_SPAN;                     // px / m
  const mx = (v) => (v - cx) * k + MS / 2;
  const mz = (v) => (v - cz) * k + MS / 2;
  mctx.fillStyle = '#0e1f1e';
  mctx.fillRect(0, 0, MS, MS);
  // 読み込み済みタイルの下地を窓の位置に貼る
  const span = TILE * k;
  for (const t of tiles.values()) {
    if (!t.mapTile) continue;
    mctx.drawImage(t.mapTile, mx(t.offX - HALF), mz(t.offZ - HALF), span, span);
  }
  // モノレール(街の骨格として道路より目立たせる)
  mctx.strokeStyle = 'rgba(120,190,235,.85)';
  mctx.lineWidth = Math.max(2, 3 * MK);
  mctx.lineCap = 'round';
  for (const p of railPaths) {
    mctx.beginPath();
    p.pts.forEach((q, i) => (i ? mctx.lineTo(mx(q.x), mz(q.z)) : mctx.moveTo(mx(q.x), mz(q.z))));
    mctx.stroke();
  }
  // バス停
  mctx.fillStyle = 'rgba(120,200,235,.9)';
  const bs = Math.max(2, 2.2 * MK);
  for (const s of busSigns) {
    mctx.fillRect(mx(s.position.x) - bs / 2, mz(s.position.z) - bs / 2, bs, bs);
  }
  // 城東小(窓の外に出ることがあるので枠内のときだけ)
  if (Math.abs(cx) < MAP_SPAN && Math.abs(cz) < MAP_SPAN) {
    mctx.fillStyle = '#e8642f';
    mctx.beginPath(); mctx.arc(mx(0), mz(0), 3.4 * MK, 0, 7); mctx.fill();
  }
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

  // 自分(視線方向つき)。窓の中心に固定
  mctx.save(); mctx.translate(MS / 2, MS / 2); mctx.rotate(-player.yaw);
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
    cap.textContent = big ? 'まわり 1.2km ・ タップで戻す' : 'まわり 1.2km ・ タップで拡大';
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

// ------------------------------------------------ タイルの読み込み／破棄
// 世界は 1km タイルの集まりで、プレイヤーの近くだけを持つ。
// 読むしきい値と捨てるしきい値を離してあるのは、境目で立ち止まったときに
// 読む・捨てるを繰り返さないため(ヒステリシス)。
// 700 で読むと、タイルの真ん中に立ったとき四方の隣(距離500)が入り、
// 斜めの隣(距離707)は入らない。1100 で捨てると持つのは最大 3×3=9枚
// (約6MB・2万棟)に収まる。差の 400m は歩き 4.6m/s で 87秒ぶんあるので、
// 境目で行ったり来たりしても読み直しにはならない。
let TILE_LOAD = 700;      // タイルの縁までこの距離に入ったら読む(m)
let TILE_DROP = 1100;     // 縁からこれより遠のいたら捨てる(m)
let syncing = false;

/** (x,z) からタイル(tx,tz)の四角までの距離。中に居れば 0。 */
function tileDist(tx, tz, x, z) {
  return Math.hypot(Math.max(Math.abs(x - tx * TILE) - HALF, 0),
                    Math.max(Math.abs(z - tz * TILE) - HALF, 0));
}

/** タイル t を捨てる。描画物も当たり判定も登録簿も、まとめて外す。 */
function dropTile(t) {
  scene.remove(t.group);
  disposeTree(t.group);
  // 当たり判定。空間ハッシュと総当たり用の配列は必ず両方から外す
  hashRemove(bmap, (r) => r.tile === t.key);
  hashRemove(rmap, (r) => r.tile === t.key);
  for (const arr of [bstore, rstore]) {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].tile === t.key) arr.splice(i, 1);
  }
  // 付属物の登録簿(バス停はバスの停車位置、信号はバスの停止線に使われる)
  for (const arr of [busSigns, shopSigns]) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].userData.tile === t.key) arr.splice(i, 1);
    }
  }
  for (let i = signals.length - 1; i >= 0; i--) {
    if (signals[i].tile === t.key) signals.splice(i, 1);
  }
  // 重機の絵は t.group ごと捨てられるが、動かす登録簿はここで外す
  for (let i = machines.length - 1; i >= 0; i--) {
    if (machines[i].tile === t.key) machines.splice(i, 1);
  }
  dropWalkLines(t.key);
  dropCarLines(t.key);
  dropWater(t.key);
  dropHistoric(t.key);
  // 焼きかけのテクスチャは捨てる(戻ってきたら最初から焼き直す)
  for (let i = bakes.length - 1; i >= 0; i--) if (bakes[i].tile === t.key) bakes.splice(i, 1);
  // 消えた歩道の上に居た者を降ろす。シーサーはその場に立たせ(遠くに居るので
  // 乗せ直すとプレイヤーの目の前へ湧く)、歩行者は手前へ湧かし直させる
  for (const g of seesaa) if (g.userData.L?.tile === t.key) g.userData.L = null;
  for (const q of peds) if (q.L?.tile === t.key) q.alive = false;
  tiles.delete(t.key);
  console.log(`[${t.key}] 破棄`);
}

/** タイルを足し引きしたあとに、タイルをまたぐもの(線形・駅・バス・地図)を組み直す。 */
function rebuildDerived() {
  // 列車の居場所は距離ではなく世界座標で覚える(線形が伸び縮みするため)
  const keep = trainPath
    ? trains.map((tr) => ({ ...railAt(trainPath, tr.d), dir: tr.dir })) : null;
  buildApron();
  rebuildMonorail();
  buildStations();
  retargetTrain(keep);
  rebuildBuses();      // 停車位置は busSigns、停止線は signals を見るので駅の後
  seatSeesaa();        // 新しいタイルで生まれた個体だけを歩道に乗せる
  settleCouncil();     // 読み込んだタイルの議会マーカーを地表に落とす
  bakeMap();
}

/**
 * 1フレーム譲る。
 *
 * requestAnimationFrame だけに頼ると、画面が隠れているあいだ rAF が
 * 止まるので**永久に返ってこない**（読み込みがそこで固まる）。
 * タイマーと競走させて、隠れていても必ず進むようにする。
 */
function nextFrame(ms = 60) {
  return new Promise((r) => {
    const id = setTimeout(r, ms);
    requestAnimationFrame(() => { clearTimeout(id); r(); });
  });
}

/** プレイヤーの位置に合わせてタイルを足し引きする。tick から間引いて呼ぶ。 */
async function syncTiles() {
  if (TILE_FIXED || syncing) return;
  const x = hereX(), z = hereZ();          // 店内に居るときは街での立ち位置
  const add = WORLD_TILES.filter((t) =>
    !tiles.has(`${t.tx},${t.tz}`) && tileDist(t.tx, t.tz, x, z) <= TILE_LOAD);
  const drop = [...tiles.values()].filter((t) =>
    tileDist(t.tx, t.tz, x, z) > TILE_DROP);
  if (!add.length && !drop.length) return;
  syncing = true;
  try {
    for (const { tx, tz } of add) {
      const t = await fetchTile(tx, tz);
      // 道路と建物を先に登録してから地形を焼く。隣のタイルの建物が縁の敷地色に
      // 効いて継ぎ目が目立たなくなる(README の順序をタイル1枚ぶんで守る)
      addRoads(t); addBuildings(t);
      buildTileCore(t);
      buildTileProps(t);
      addWalkLines(t);
      addCarLines(t);
      addWater(t);
      // 1枚組み立てるあいだ主スレッドが止まる(建物の多いタイルで 220〜240ms)。
      // そのまま次へ行くと、おもろまち周辺のように重いタイルが6枚続く所で
      // 2秒ちかく画面が固まる。1枚ごとに1フレーム譲って描かせる。
      // 合計の時間は変わらないが、止まって見えなくなる
      await nextFrame();
    }
    for (const t of drop) dropTile(t);
    rebuildDerived();
  } catch (e) {
    console.error('タイルの読み込みに失敗:', e);
  } finally {
    syncing = false;
  }
}

// ------------------------------------------------------------------ 車内
// 乗ると、これまでは何も描かれていなかった。車体は BoxGeometry の既定
// (FrontSide) なので、内側からは面がぜんぶ裏を向いて消える。床も窓枠も無い
// 空中の一点から街を見ることになり、それが「屋根に乗っている」感じの正体だった。
//
// 造形は Antigravity(agy) に契約を渡して書かせた（シーサー・正殿と同じやり方）。
// 契約の要点は可動部の受け渡しで、扉を userData.parts に Group で出させてある。
// 併せて「重くなる2つ」を禁止条項に入れた:
//   transparent 禁止（窓は板を分けて本当の開口にする。半透明パスを増やさない）
//   castShadow 禁止（影は別パス。qLevel 3 の影切りにも巻き込まない）
// 検分の結果、両方とも違反ゼロ（バス35メッシュ/4マテリアル、モノレール39/6）。

function makeBusCabin() {
    // 寸法根拠: 内寸 幅2.3m, 天井高2.2m(y=0.95~3.15), 長さ8.8m(z=-4.4~+4.4)。目線y=2.15。
    // 左に座席、右に扉(z=-0.6~0.6)を配置し、厚みのある扉なども全てこのバウンディングボックス内に収めています。
    const cabin = new THREE.Group();

    // マテリアル (4種のみ生成し使い回す)
    const matFloor = new THREE.MeshLambertMaterial({ color: 0x333333 });
    const matWall = new THREE.MeshLambertMaterial({ color: 0xeeeee0 });
    const matSeat = new THREE.MeshLambertMaterial({ color: 0x1f5c87 });
    const matRail = new THREE.MeshLambertMaterial({ color: 0xcccccc });

    // 床・天井
    const geoFloor = new THREE.PlaneGeometry(2.3, 8.8);
    
    const floor = new THREE.Mesh(geoFloor, matFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.95, 0);
    cabin.add(floor);

    const ceiling = new THREE.Mesh(geoFloor, matWall);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, 3.15, 0);
    cabin.add(ceiling);

    // 前面・背面
    const geoCap = new THREE.PlaneGeometry(2.3, 2.2);
    
    const frontWall = new THREE.Mesh(geoCap, matWall);
    frontWall.position.set(0, 2.05, -4.4);
    cabin.add(frontWall);

    const rearWall = new THREE.Mesh(geoCap, matWall);
    rearWall.rotation.y = Math.PI;
    rearWall.position.set(0, 2.05, 4.4);
    cabin.add(rearWall);

    // 左側面 (x = -1.15)
    const geoWaist = new THREE.PlaneGeometry(8.8, 0.75); // 0.95~1.70
    const leftWaist = new THREE.Mesh(geoWaist, matWall);
    leftWaist.rotation.y = Math.PI / 2;
    leftWaist.position.set(-1.15, 1.325, 0);
    cabin.add(leftWaist);

    const geoFrieze = new THREE.PlaneGeometry(8.8, 0.5); // 2.65~3.15
    const leftFrieze = new THREE.Mesh(geoFrieze, matWall);
    leftFrieze.rotation.y = Math.PI / 2;
    leftFrieze.position.set(-1.15, 2.90, 0);
    cabin.add(leftFrieze);

    const geoPillar = new THREE.PlaneGeometry(0.08, 0.95); // 1.70~2.65
    [-2.2, 0, 2.2].forEach(z => {
        const pillar = new THREE.Mesh(geoPillar, matWall);
        pillar.rotation.y = Math.PI / 2;
        pillar.position.set(-1.15, 2.175, z);
        cabin.add(pillar);
    });

    // 右側面 (x = 1.15) - z=-0.6~0.6が扉
    const geoWaistHalf = new THREE.PlaneGeometry(3.8, 0.75);
    const geoFriezeHalf = new THREE.PlaneGeometry(3.8, 0.5);

    const rightWaistF = new THREE.Mesh(geoWaistHalf, matWall);
    rightWaistF.rotation.y = -Math.PI / 2;
    rightWaistF.position.set(1.15, 1.325, -2.5);
    cabin.add(rightWaistF);

    const rightFriezeF = new THREE.Mesh(geoFriezeHalf, matWall);
    rightFriezeF.rotation.y = -Math.PI / 2;
    rightFriezeF.position.set(1.15, 2.90, -2.5);
    cabin.add(rightFriezeF);

    const rightWaistR = new THREE.Mesh(geoWaistHalf, matWall);
    rightWaistR.rotation.y = -Math.PI / 2;
    rightWaistR.position.set(1.15, 1.325, 2.5);
    cabin.add(rightWaistR);

    const rightFriezeR = new THREE.Mesh(geoFriezeHalf, matWall);
    rightFriezeR.rotation.y = -Math.PI / 2;
    rightFriezeR.position.set(1.15, 2.90, 2.5);
    cabin.add(rightFriezeR);

    // 右扉上の壁 (y=2.90~3.15)
    const geoTop = new THREE.PlaneGeometry(1.2, 0.25);
    const rightTop = new THREE.Mesh(geoTop, matWall);
    rightTop.rotation.y = -Math.PI / 2;
    rightTop.position.set(1.15, 3.025, 0);
    cabin.add(rightTop);

    // 右柱
    [-2.5, 2.5].forEach(z => {
        const pillar = new THREE.Mesh(geoPillar, matWall);
        pillar.rotation.y = -Math.PI / 2;
        pillar.position.set(1.15, 2.175, z);
        cabin.add(pillar);
    });

    // 扉
    const doorL = new THREE.Group();
    doorL.position.set(1.15, 0.95, -0.6);
    const doorR = new THREE.Group();
    doorR.position.set(1.15, 0.95, 0.6);

    const geoDoor = new THREE.BoxGeometry(0.04, 1.95, 0.6);
    // 箱からはみ出さないよう、x方向に-0.02ずらして厚みを内側に収める
    const meshDoorL = new THREE.Mesh(geoDoor, matWall);
    meshDoorL.position.set(-0.02, 0.975, 0.3);
    doorL.add(meshDoorL);

    const meshDoorR = new THREE.Mesh(geoDoor, matWall);
    meshDoorR.position.set(-0.02, 0.975, -0.3);
    doorR.add(meshDoorR);

    cabin.add(doorL);
    cabin.add(doorR);
    cabin.userData.parts = { doorL, doorR };

    // 座席 (左3列、右3列) プレイヤー目線位置(x=-0.75, z=1.6)を避ける
    const geoSeatBase = new THREE.BoxGeometry(0.9, 0.1, 0.5);
    const geoSeatBack = new THREE.BoxGeometry(0.9, 0.5, 0.1);
    
    [-3.0, -1.0, 3.0].forEach(z => {
        const base = new THREE.Mesh(geoSeatBase, matSeat);
        base.position.set(-0.65, 1.1, z);
        cabin.add(base);
        const back = new THREE.Mesh(geoSeatBack, matSeat);
        back.position.set(-0.65, 1.4, z + 0.2); // 後ろ側に背もたれ
        cabin.add(back);
    });

    [-3.0, 2.0, 3.5].forEach(z => {
        const base = new THREE.Mesh(geoSeatBase, matSeat);
        base.position.set(0.65, 1.1, z);
        cabin.add(base);
        const back = new THREE.Mesh(geoSeatBack, matSeat);
        back.position.set(0.65, 1.4, z + 0.2);
        cabin.add(back);
    });

    // 手すり
    const geoRail = new THREE.CylinderGeometry(0.02, 0.02, 8.8, 8);
    const railL = new THREE.Mesh(geoRail, matRail);
    railL.rotation.x = Math.PI / 2;
    railL.position.set(-0.7, 2.8, 0);
    cabin.add(railL);

    const railR = new THREE.Mesh(geoRail, matRail);
    railR.rotation.x = Math.PI / 2;
    railR.position.set(0.7, 2.8, 0);
    cabin.add(railR);

    // つり革
    const geoStrap = new THREE.CylinderGeometry(0.01, 0.01, 0.2, 5);
    [-2.0, 0, 2.0].forEach(z => {
        const strapL = new THREE.Mesh(geoStrap, matRail);
        strapL.position.set(-0.7, 2.7, z);
        cabin.add(strapL);

        const strapR = new THREE.Mesh(geoStrap, matRail);
        strapR.position.set(0.7, 2.7, z);
        cabin.add(strapR);
    });

    return cabin;
}

function makeTrainCabin() {
    // 寸法根拠: 内寸(2.4x2.5x12.8)を遵守し、床Plane(y=-1.05)、天井Plane(y=1.45)で高さを固定
    // 中央プレイヤ位置(z=0)半径0.6mを避け、ドア開口部(z=-0.65〜0.65)を設けて壁と座席を配置
    const cabin = new THREE.Group();

    const matFloor = new THREE.MeshLambertMaterial({ color: 0xc0c0c0 });
    const matWall = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
    const matSeat = new THREE.MeshLambertMaterial({ color: 0x2266cc });
    const matBack = new THREE.MeshLambertMaterial({ color: 0xee7722 });
    const matPole = new THREE.MeshLambertMaterial({ color: 0xcccccc });
    const matDoor = new THREE.MeshLambertMaterial({ color: 0xe8e8e8 });

    const floorGeo = new THREE.PlaneGeometry(2.4, 12.8);
    const floor = new THREE.Mesh(floorGeo, matFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.05, 0);
    cabin.add(floor);

    const ceil = new THREE.Mesh(floorGeo, matFloor);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, 1.45, 0);
    cabin.add(ceil);

    const fwGeo = new THREE.BoxGeometry(2.4, 0.7, 0.02);
    const fw = new THREE.Mesh(fwGeo, matWall);
    fw.position.set(0, -0.7, -6.39);
    cabin.add(fw);

    const ffGeo = new THREE.BoxGeometry(2.4, 0.5, 0.02);
    const ff = new THREE.Mesh(ffGeo, matWall);
    ff.position.set(0, 1.2, -6.39);
    cabin.add(ff);

    const bwGeo = new THREE.BoxGeometry(2.4, 2.5, 0.02);
    const bw = new THREE.Mesh(bwGeo, matWall);
    bw.position.set(0, 0.2, 6.39);
    cabin.add(bw);

    const wainscotGeo = new THREE.BoxGeometry(0.02, 0.7, 5.75);
    const friezeGeo = new THREE.BoxGeometry(0.02, 0.5, 12.8);
    const pillarGeo = new THREE.BoxGeometry(0.02, 1.3, 0.08);

    const sideSigns = [-1, 1];
    sideSigns.forEach(sx => {
        const x = sx * 1.19;

        const wFront = new THREE.Mesh(wainscotGeo, matWall);
        wFront.position.set(x, -0.7, -3.525);
        cabin.add(wFront);

        const wBack = new THREE.Mesh(wainscotGeo, matWall);
        wBack.position.set(x, -0.7, 3.525);
        cabin.add(wBack);

        const frieze = new THREE.Mesh(friezeGeo, matWall);
        frieze.position.set(x, 1.2, 0);
        cabin.add(frieze);

        [-4.5, -2.5, 2.5, 4.5].forEach(pz => {
            const pillar = new THREE.Mesh(pillarGeo, matWall);
            pillar.position.set(x, 0.3, pz);
            cabin.add(pillar);
        });
    });

    const doorL = new THREE.Group();
    doorL.position.set(-1.18, 0, -0.65);
    const doorR = new THREE.Group();
    doorR.position.set(1.18, 0, -0.65);

    const doorLeafGeo = new THREE.BoxGeometry(0.02, 2.0, 0.65);
    [doorL, doorR].forEach(doorGroup => {
        const leaf1 = new THREE.Mesh(doorLeafGeo, matDoor);
        leaf1.position.set(0, -0.05, 0.325);
        const leaf2 = new THREE.Mesh(doorLeafGeo, matDoor);
        leaf2.position.set(0, -0.05, 0.975);
        doorGroup.add(leaf1, leaf2);
        cabin.add(doorGroup);
    });

    cabin.userData.parts = { doorL, doorR };

    const seatBaseGeo = new THREE.BoxGeometry(0.45, 0.4, 5.69);
    const seatBackGeo = new THREE.BoxGeometry(0.1, 0.3, 5.69);

    sideSigns.forEach(sx => {
        const baseX = sx * 0.955;
        const backX = sx * 1.13;
        [-3.545, 3.545].forEach(sz => {
            const sBase = new THREE.Mesh(seatBaseGeo, matSeat);
            sBase.position.set(baseX, -0.85, sz);
            cabin.add(sBase);

            const sBack = new THREE.Mesh(seatBackGeo, matBack);
            sBack.position.set(backX, -0.5, sz);
            cabin.add(sBack);
        });
    });

    const handrailGeo = new THREE.CylinderGeometry(0.02, 0.02, 12.8, 8);
    sideSigns.forEach(sx => {
        const hr = new THREE.Mesh(handrailGeo, matPole);
        hr.rotation.x = Math.PI / 2;
        hr.position.set(sx * 0.8, 1.1, 0);
        cabin.add(hr);
    });

    const poleGeo = new THREE.CylinderGeometry(0.02, 0.02, 2.5, 8);
    const poleL = new THREE.Mesh(poleGeo, matPole);
    poleL.position.set(-0.7, 0.2, -0.75);
    cabin.add(poleL);
    
    const poleR = new THREE.Mesh(poleGeo, matPole);
    poleR.position.set(0.7, 0.2, 0.75);
    cabin.add(poleR);

    const strapGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.2, 8);
    sideSigns.forEach(sx => {
        [-2.5, 2.5].forEach(sz => {
            const strap = new THREE.Mesh(strapGeo, matPole);
            strap.position.set(sx * 0.8, 1.0, sz);
            cabin.add(strap);
        });
    });

    return cabin;
}

/**
 * 乗り物に車内を建てて、扉を動かせる形にして返す。
 *
 * 店(buildRoom)と違って舞台へ飛ばす必要は無い。車体はもともと街にあるし、
 * supportY が footprint の天端に立たせてしまう問題も乗車中は起きない
 * (乗車中はプレイヤーを座席へ貼り付けるので地形を見ない)。
 */
function buildCabin(v) {
  const cabin = v.isTrain ? makeTrainCabin() : makeBusCabin();
  // モノレールは2両編成。座席のある側の車両にぶら下げる
  if (v.isTrain) cabin.position.z = seatOf(v).z;
  const { doorL, doorR } = cabin.userData.parts;

  // 扉の動かし方は車種で違う。バスは折戸なので内側へ回し、
  // モノレールは引戸なので2枚を前後へ滑らせる。
  // agy には「2枚を1つの Group にまとめてよい」と書いたので、
  // モノレールは同じ蝶番に2枚ぶら下がっている。回すと外側の戸が
  // 1.3m の弧を描いてしまうため、こちらは子を個別に滑らせる。
  let setDoors;
  if (v.isTrain) {
    const base = [];
    for (const g of [doorL, doorR]) {
      for (const leaf of g.children) base.push([leaf, leaf.position.z]);
    }
    setDoors = (u) => {
      for (let i = 0; i < base.length; i++) {
        const [leaf, z0] = base[i];
        // 各 Group の 0番目は手前、1番目は奥。前後へ開く
        base[i][0].position.z = z0 + (i % 2 === 0 ? -1 : 1) * 0.62 * u;
      }
    };
  } else {
    setDoors = (u) => {
      doorL.rotation.y = -1.5 * u;
      doorR.rotation.y = 1.5 * u;
    };
  }
  setDoors(0);
  cabin.userData.setDoors = setDoors;
  cabin.userData.open = 0;

  // 外から見る車体を、乗っているあいだは隠す。
  // 車体は帯・窓・裾を「実体のある箱」で重ねて作ってあり、その何枚かが
  // 車内の床より上に来る（バスの帯は床の 0.2m 上）。箱は内側からは面が
  // 消えるが、**天面より下に目線があるとは限らない**ので、見下ろすと
  // 帯の天面が床を覆う。実際にオレンジの板が床一面に見えた。
  const hidden = [];
  for (const o of v.g.children) {
    if (o === cabin || !o.visible) continue;
    o.visible = false;
    hidden.push(o);
  }
  cabin.userData.hidden = hidden;

  v.g.add(cabin);
  return cabin;
}

function disposeCabin(cabin) {
  if (!cabin) return;
  for (const o of cabin.userData.hidden ?? []) o.visible = true;
  cabin.parent?.remove(cabin);
  const seen = new Set();
  cabin.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    for (const m of [o.material].flat().filter(Boolean)) {
      if (seen.has(m)) continue;
      seen.add(m);
      m.dispose();
    }
  });
}

// ---------------------------------------------------------------- バスに乗る
// バス停に停まっているバスへ近づくと乗れる。乗車中は移動入力を切り、
// 座席の位置にプレイヤーを貼り付ける(見回しは自由)。
const BOARD_R = 6.5;           // この距離まで近づくと乗れる(m)
const SEAT = { x: -0.75, y: 2.15, z: 1.6 };   // バス内の座席(左の窓側)
const seatOf = (v) => v.seat ?? SEAT;
let riding = null, boardable = null;
let inWater = false;              // 泳いでいるか(HUDと車の湧かし直しに使う)
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

// ---------------------------------------------------------------- 財布と持ち物
// この世界には**何かを持つ器が無かった**。シーサーは `taken` という裸の
// カウンタで、localStorage に入れているのは出発駅の選択だけ。釣り・買い物・
// 工事はどれも「何かを得る」遊びなので、器を先に置く。
//
// 財布は**今は入り口が無い**(釣りで魚は増えるが金は増えない)。無理に
// 釣りを換金にすると、市議会の発言や史跡の解説と並ぶこの街の調子から外れる。
// 買い物か工事の日当を作るときに繋ぐので、0円のあいだは HUD に出さない。
const PURSE_KEY = 'jouto-walk.purse.v1';
let coins = 0;                    // 円
const bag = new Map();            // 品名 -> 個数
const seenFish = new Set();       // 一度でも釣った魚(図鑑)
// いきものは**持ち帰らない**。図鑑に載せるだけなので bag には入れない
// (オカヤドカリは国の天然記念物で、そもそも持ち帰れない)。
const seenCrea = new Set();

function loadPurse() {
  try {
    const j = JSON.parse(localStorage.getItem(PURSE_KEY) || '{}');
    coins = Number(j.coins) || 0;
    for (const [k, v] of Object.entries(j.bag || {})) bag.set(k, Number(v) || 0);
    for (const k of j.seenFish || []) seenFish.add(k);
    for (const k of j.seenCrea || []) seenCrea.add(k);
  } catch { /* 壊れていたら空で始める。持ち物は失っても遊びは続く */ }
}

function savePurse() {
  try {
    localStorage.setItem(PURSE_KEY, JSON.stringify({
      coins, bag: Object.fromEntries(bag), seenFish: [...seenFish],
      seenCrea: [...seenCrea],
    }));
  } catch { /* プライベートモードなどで書けないことがある。落とさない */ }
}

/** 持ち物に n 個足す。 */
function addItem(name, n = 1) {
  bag.set(name, (bag.get(name) ?? 0) + n);
  savePurse();
  updatePurseUI();
}

function updatePurseUI() {
  const row = $('purse-row');
  if (row) row.style.display = coins > 0 ? '' : 'none';
  const c = $('purse');
  if (c) c.textContent = `${coins.toLocaleString()} 円`;
  const f = $('fishcount');
  if (f) {
    let n = 0;
    for (const [k, v] of bag) if (FISH_NAMES.has(k)) n += v;
    f.textContent = `${n} 匹 / ${seenFish.size} 種`;
  }
  const cr = $('creacount');
  if (cr) cr.textContent = `${seenCrea.size} 種`;
}

loadPurse();
// updatePurseUI() はここでは呼べない。中で FISH_NAMES を読むが、あれは下の
// 釣りの節で宣言されるので TDZ で落ちる。表示の初期化は FISH_NAMES を
// 組み立てた直後に置いてある

// ---------------------------------------------------------------- 釣り
// 水際に立って水面を向くと釣れる。水面の高さは waterAt() が池78面・川193本・
// 海のどれからでも返すので、**釣りのために足す当たり判定は無い**。
//
// 魚は「この池にこの魚が居る」とは言わない。OSM にも PLATEAU にも魚は
// 入っていないので、言えるのは**沖縄の池・川・干潟・海で釣れる魚**まで
// (史跡289件のうち253件を説明なしで出したのと同じ線引き)。
// だから水域の**種別**で表を分け、個々の池の名前では変えない。
const CAST_R = 14;            // 竿を振って届く距離(m)
const BITE_MS = [1500, 5000]; // 当たりが来るまで(ms)
// 合わせる猶予。**0.9秒では釣れない。** 「きた！」を読んでキーへ手を動かす
// までにそれくらい掛かる。実際に遊んで一匹も上がらなかった
const HOOK_MS = 1900;
const REEL_R = 2.5;           // 投げた場所からこれだけ離れると糸を上げる(m)

// 沖縄の水辺で釣れる魚。名前は現地の呼び方を添える。
// k は waters の種別(water=池・貯水池 / wetland=干潟)、river=川、sea=海。
const FISH = {
  water: [
    ['ティラピア', 'ちかごろの池でいちばん釣れる。もとは食用に持ちこまれた魚', 18, 34],
    ['コイ', '公園の池でよく見る。人に慣れていて岸まで寄ってくる', 30, 62],
    ['オオウナギ', '夜に出てくる大きなウナギ。石垣の隙間にひそむ', 60, 110],
    ['テナガエビ', '腕の長いエビ。魚ではないが、よく釣れる', 6, 13],
  ],
  wetland: [
    ['ミナミトビハゼ', 'トントンミー。干潟をはねて歩く、水から出られる魚', 5, 10],
    ['ミナミクロダイ', 'チンシラー。汽水の濁りを好む', 22, 45],
    ['シオマネキ', '片方のはさみだけ大きいカニ。潮を招くように振る', 3, 5],
  ],
  river: [
    ['ボウズハゼ', '腹の吸盤で滝をのぼる。川の上流にいる', 8, 15],
    ['ヨシノボリ', '石の間を跳ねるように動く小さなハゼ', 5, 11],
    ['オオウナギ', '川の淵の岩陰にひそむ。夜に動く', 60, 110],
    ['テナガエビ', '腕の長いエビ。石を起こすと逃げていく', 6, 13],
  ],
  sea: [
    ['グルクン', 'タカサゴ。沖縄県の魚。から揚げでよく食べる', 20, 30],
    ['イラブチャー', 'ブダイ。青い体。サンゴをかじって砂にする', 30, 60],
    ['ミーバイ', 'ハタ。岩の穴で待ちぶせる。刺身にも汁にも', 25, 55],
    ['ガーラ', 'ロウニンアジ。港の中まで入ってくる大物', 40, 90],
    ['チヌマン', 'アイゴ。ひれのとげに毒があるので触らない', 18, 30],
  ],
};
const FISH_NAMES = new Set();
for (const list of Object.values(FISH)) for (const f of list) FISH_NAMES.add(f[0]);
updatePurseUI();          // 前の節の loadPurse() の結果をここで初めて出せる

// 状態は1つだけ。null=釣っていない / 'cast'=待っている / 'bite'=当たり /
// 'reel'=引き上げの見せ場
let fishing = null;   // {phase, t, biteAt, spot:{x,y,z}, kind, place}
let rodGroup = null, floatMesh = null, lineMesh = null;

/**
 * 目の前の水面を探す。見ている向きへ CAST_R まで伸ばす。
 * **自分の足元は見ない**(泳ぎながら釣らせないため)。
 *
 * 最初に当たった点には落とさない。岸から振ると水際は足のすぐ先なので、
 * 浮きが画面の下の端に沈んで「投げた」ように見えない。当たった所から
 * 水が続くかぎり先へ進み、CAST_OUT ぶん沖へ置く。
 */
const CAST_OUT = 6.5;         // 水際からさらに沖へ振る距離(m)

function castTarget() {
  if (riding || transit || inShop || fishing) return null;
  if (inWater) return null;                 // 泳いでいるあいだは振れない
  const dx = -Math.sin(player.yaw), dz = -Math.cos(player.yaw);
  let first = null, last = null;
  for (let d = 2.5; d <= CAST_R; d += 0.8) {
    const x = player.x + dx * d, z = player.z + dz * d;
    const y = waterAt(x, z);
    // 水面より高い地形が間にあるなら、そこは対岸。そこで打ち切る
    if (y === null || groundAt(x, z) > y + 0.05) {
      if (first !== null) break;            // 対岸に着いた。ここまでが水面
      continue;
    }
    if (first === null) first = d;
    last = { d, x, y, z };
  }
  if (first === null) return null;
  // 水際から CAST_OUT 先。水面が途切れていればその手前まで
  const want = Math.min(first + CAST_OUT, last.d);
  const x = player.x + dx * want, z = player.z + dz * want;
  const y = waterAt(x, z) ?? last.y;
  return { x, y, z, ...waterKindAt(x, z) };
}

/** (x,z) の水域の種別と呼び名。waters に無ければ川か海。 */
function waterKindAt(x, z) {
  const hits = wmap.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`) ?? [];
  for (const w of hits) {
    if (x < w.minx || x > w.maxx || z < w.minz || z > w.maxz) continue;
    if (pointInRing(w.ring, x, z)) {
      return { kind: w.k === 'wetland' ? 'wetland' : 'water', place: w.name || '' };
    }
  }
  if (riverAt(x, z) !== null) return { kind: 'river', place: '' };
  return { kind: 'sea', place: '' };
}

// 竿の手元と先端(カメラ座標。-Z が前・+X が右・+Y が上)。
// **糸の始点をここから作る。** 別々に数字を書くと竿先と糸が離れる。
// 手元を近づけすぎると画面を横切る巨大な棒になる(0.55m で実際にそうなった)。
const ROD_BUTT = new THREE.Vector3(0.52, -0.52, -0.95);
const ROD_TIP = new THREE.Vector3(0.12, 0.30, -2.55);

/** 竿と浮きを作る。竿はカメラの子にして、常に手元に見えるようにする。 */
function buildRod() {
  if (rodGroup) return;
  rodGroup = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  // 手元→先端の向きへ円柱を寝かせる。Euler で書くと order の解釈で狂うので
  // 向きを直接与える(信号の腕木で踏んだのと同じ理由)
  const dir = ROD_TIP.clone().sub(ROD_BUTT);
  const len = dir.length();
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.022, len, 6), mat(0x6b4f33));
  rod.quaternion.copy(q);
  rod.position.copy(ROD_BUTT).addScaledVector(dir, len / 2);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.26, 6), mat(0x2f2a26));
  grip.quaternion.copy(q);
  grip.position.copy(ROD_BUTT).addScaledVector(dir, 0.12);
  rodGroup.add(rod, grip);
  rodGroup.visible = false;
  // カメラの子。カメラは毎フレーム位置を書き換えられるが、子は付いてくる
  camera.add(rodGroup);
  scene.add(camera);                 // 子を描かせるにはカメラも木に居る必要がある

  floatMesh = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 7), mat(0xe8642f));
  floatMesh.visible = false;
  scene.add(floatMesh);
  // 糸。竿先から浮きまで。毎フレーム2点を書き換える
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  lineMesh = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xf2efe6 }));
  lineMesh.visible = false;
  lineMesh.frustumCulled = false;    // 2点しかないので境界球が当てにならない
  scene.add(lineMesh);
}

/** [F] とボタンの共通処理。投げる／合わせる／やめる。 */
function fishAction() {
  // 糸をたらしていないときは、近くのいきものが先。逃げてしまうので
  if (!fishing && creaNear) { recordCreature(); return; }
  if (!fishing) {
    const spot = castTarget();
    if (!spot) return;
    buildRod();
    fishing = {
      phase: 'cast', t: 0, spot,
      biteAt: (BITE_MS[0] + Math.random() * (BITE_MS[1] - BITE_MS[0])) / 1000,
      kind: spot.kind, place: spot.place,
      // 投げた立ち位置。ここから離れたら糸を上げる(やめる手段はこれ)
      fromX: player.x, fromZ: player.z,
    };
    rodGroup.visible = true;
    floatMesh.visible = lineMesh.visible = true;
    floatMesh.position.set(spot.x, spot.y + 0.1, spot.z);
    say(spot.place ? `${spot.place} に糸をたらした` : '糸をたらした');
  } else if (fishing.phase === 'bite') {
    landFish();
  } else {
    // **待っているあいだの [F] で糸を上げない。** 同じキーが「合わせる」と
    // 「やめる」を兼ねていたので、待ちきれずに押すと黙って終わっていた。
    // これが「全然釣れない」の正体。やめたいときは水辺から離れる
    say('まだ当たっていない');
  }
  updateFishUI();
}

function stopFishing(msg) {
  fishing = null;
  if (rodGroup) rodGroup.visible = false;
  if (floatMesh) floatMesh.visible = lineMesh.visible = false;
  if (msg) say(msg);
  updateFishUI();
}

/** 合わせに成功したとき。種を選んで持ち物に入れる。 */
function landFish() {
  const list = FISH[fishing.kind] ?? FISH.water;
  const [name, note, lo, hi] = list[(Math.random() * list.length) | 0];
  const cm = Math.round(lo + Math.random() * (hi - lo));
  const first = !seenFish.has(name);
  seenFish.add(name);
  addItem(name, 1);
  const where = fishing.place ? `${fishing.place}で` : '';
  stopFishing(null);
  if (first) {
    say(`${where}${name} ${cm}cm を釣った — ${note}`);
  } else {
    say(`${where}${name} ${cm}cm を釣った`);
  }
  savePurse();
}

/** 釣りを1フレーム進める。 */
function stepFishing(dt) {
  if (!fishing) return;
  // 乗り物に乗る・店に入る・泳ぐと竿は仕舞う
  if (riding || transit || inShop || inWater) { stopFishing(null); return; }
  // 水辺から離れたら糸を上げる。[F] は合わせる専用にしたので、やめる手段はこれ
  if (Math.hypot(player.x - fishing.fromX, player.z - fishing.fromZ) > REEL_R) {
    stopFishing('糸を上げた');
    return;
  }
  fishing.t += dt;
  const f = floatMesh, s = fishing.spot;
  if (fishing.phase === 'cast') {
    // 待っているあいだ、浮きは水面で上下に揺れるだけ
    f.position.set(s.x, s.y + 0.10 + Math.sin(fishing.t * 2.1) * 0.03, s.z);
    if (fishing.t >= fishing.biteAt) {
      fishing.phase = 'bite'; fishing.t = 0;
      say('きた！');
      updateFishUI();
    }
  } else if (fishing.phase === 'bite') {
    // 当たり。浮きが水面下へ引きこまれる
    f.position.set(s.x, s.y - 0.16 - Math.sin(fishing.t * 15) * 0.08, s.z);
    if (fishing.t * 1000 >= HOOK_MS) stopFishing('逃げられた');
  }
  if (!fishing) return;
  // 糸を竿先から浮きへ張る。竿先はカメラ座標なので世界座標へ直す
  camera.updateMatrixWorld();
  const tip = ROD_TIP.clone().applyMatrix4(camera.matrixWorld);
  const p = lineMesh.geometry.attributes.position;
  p.setXYZ(0, tip.x, tip.y, tip.z);
  p.setXYZ(1, f.position.x, f.position.y, f.position.z);
  p.needsUpdate = true;
}

// ---------------------------------------------------------------- いきもの
// 公園の木・草地・水辺にいる虫や小さな生き物を見つけて図鑑に載せる。
//
// **つかまえて持ち帰るのではなく、記録する。** オカヤドカリは国の天然記念物で
// 持ち帰れないし、街の生き物を袋に詰めて歩くのはこの街の調子に合わない。
// 集めるのは「見た記録」のほう。
//
// 魚と同じで、**どこに何が居るとは言わない**。OSM にも PLATEAU にも生き物は
// 入っていないので、言えるのは「沖縄のこういう場所で見かける生き物」まで。
// だから居場所の**種類**(木・草地・淡水の岸・潮の岸)で表を分ける。
//
// **ヤンバルクイナは入れていない。** あれはやんばる(北部)の鳥で、那覇には居ない。
// 沖縄でいちばん名の知れた生き物だが、出したら嘘になる。
const CREA_N = 14;             // 同時に居る数(距離バジェット。歩行者36人・車44台と同じ考え)
const CREA_NEAR = [7, 70];     // この距離の帯に湧かし直す(m)
const CATCH_R = 3.4;           // 図鑑に載せられる距離(m)

// [名前, 説明, 見た目, 動き]。動きは 'fly'=舞う / 'sit'=とまっている
const CREATURES = {
  tree: [
    ['クロイワツクツク', '沖縄のツクツクボウシ。夏の終わりに鳴きだす', 'cicada', 'sit'],
    ['リュウキュウアブラゼミ', '羽の茶色いセミ。街なかの木でも鳴く', 'cicada', 'sit'],
    ['オキナワキノボリトカゲ', '幹でじっとしている緑のトカゲ。体の色を変える', 'lizard', 'sit'],
    ['ナナフシ', '枝にそっくりな虫。動かないと見つけられない', 'stick', 'sit'],
  ],
  grass: [
    ['オオゴマダラ', '沖縄県の蝶。日本でいちばん大きい蝶のひとつで、さなぎが金色になる', 'butterfly', 'fly'],
    ['リュウキュウアサギマダラ', '浅葱色の蝶。冬になると谷あいに群れて集まる', 'butterfly', 'fly'],
    ['アオカナヘビ', '草の上を走る細いトカゲ。しっぽが体より長い', 'lizard', 'sit'],
  ],
  // 民家の壁ぎわ。**この街でいちばん多い住みか**。公園だけを住みかにすると、
  // 城東小のまわりのような住宅地では一匹も出ない(出発地点から最寄りの公園は
  // 230m、最寄りの木は 240m だった)
  wall: [
    ['ホオグロヤモリ', '「ケケケ」と鳴くヤモリ。夜、灯りのそばの壁で虫を待つ', 'lizard', 'sit'],
    ['シロオビアゲハ', '黒地に白い帯の蝶。庭のミカンの木で育つ', 'butterfly', 'fly'],
    ['アオドウガネ', '緑色のコガネムシ。夜、灯りに集まってくる', 'cicada', 'sit'],
  ],
  // 淡水(池・川)の岸
  bank: [
    ['オオシオカラトンボ', '水色の太いトンボ。水辺を行ったり来たりする', 'dragonfly', 'fly'],
    ['ショウジョウトンボ', '真っ赤なトンボ。赤とんぼの仲間ではない', 'dragonfly', 'fly'],
    ['ヒメアマガエル', '小さくて丸いカエル。雨のあとによく鳴く', 'frog', 'sit'],
  ],
  // 潮の満ち引きのある岸(干潟・海岸)
  tide: [
    ['オカヤドカリ', '国の天然記念物。貝がらを借りて歩く。持ち帰れない', 'crab', 'sit'],
    ['ミナミコメツキガニ', '干潟を群れになって歩く青いカニ。まっすぐ前に歩く', 'crab', 'sit'],
  ],
};

const creatures = [];          // {g, name, note, look, mode, home, phase, alive}
let creaNear = null;           // いま記録できる1匹

// 体の寸法は実物に合わせてあるが、**描くときだけ2倍にする**。
// この街で唯一、実寸から意図的にずらしている所。オオゴマダラの13cmは
// 3.6m 先で15px にしかならず(実測)、何を記録したのか分からない。
// 2倍でも 30px 程度で、路上の生き物として不自然ではない。
const CREA_SCALE = 2.0;

/** 小さな体を作る。見た目ごとに 2〜3 メッシュ。 */
function makeCreature(look) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const box = (w, h, d, x, y, z, c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
    m.position.set(x, y, z); g.add(m); return m;
  };
  if (look === 'butterfly') {
    box(0.02, 0.02, 0.10, 0, 0, 0, 0x2b2b2b);                 // 胴
    // 翅は羽ばたかせるので、付け根を原点にした Group に入れる(重機と同じ型)
    for (const s of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(0, 0, 0);
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.004, 0.09), mat(0xf4f1e8));
      p.position.set(s * 0.055, 0, 0);
      w.add(p); g.add(w);
      (g.userData.wings ??= []).push({ w, s });
    }
  } else if (look === 'dragonfly') {
    box(0.014, 0.014, 0.16, 0, 0, 0, 0x4a7fa5);
    for (const s of [-1, 1]) {
      const w = new THREE.Group();
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.003, 0.03), mat(0xdfe8ee));
      p.position.set(s * 0.05, 0, -0.02);
      w.add(p); g.add(w);
      (g.userData.wings ??= []).push({ w, s });
    }
  } else if (look === 'cicada') {
    box(0.022, 0.020, 0.055, 0, 0, 0, 0x4a3b2c);
    box(0.030, 0.004, 0.065, 0, 0.012, 0.004, 0x6e6252);      // たたんだ羽
  } else if (look === 'lizard') {
    box(0.028, 0.022, 0.085, 0, 0, 0, 0x5f8f4a);
    box(0.012, 0.012, 0.12, 0, 0, 0.10, 0x4f7a3e);            // しっぽ
  } else if (look === 'stick') {
    box(0.010, 0.010, 0.17, 0, 0, 0, 0x7a6b46);
    box(0.008, 0.008, 0.07, 0, 0.004, -0.11, 0x7a6b46);
  } else if (look === 'frog') {
    box(0.05, 0.035, 0.06, 0, 0, 0, 0x6f8a55);
    for (const s of [-1, 1]) box(0.014, 0.014, 0.014, s * 0.017, 0.024, -0.022, 0x2b2b2b);
  } else {  // crab
    box(0.06, 0.032, 0.05, 0, 0, 0, 0xb06a4a);
    for (const s of [-1, 1]) box(0.022, 0.016, 0.03, s * 0.04, 0.004, -0.026, 0xc07a55);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(CREA_SCALE);
  return g;
}

/**
 * 湧かす場所を1つ選ぶ。
 *
 * 点をばらまいて分類するのではなく、**居場所の側から選ぶ**。木は幹の控えから、
 * 草地は公園の面から、岸は水面の輪から。そのほうが外れが出ない。
 *
 * **候補を先に距離で絞る。** タイルを引いてから点を選び、あとで距離帯で
 * 落とす書き方だと、1km 角のタイルに対して帯が 70m しかないので
 * ほとんど当たらない(実測で 600 回試して 0 件だった)。
 */
function pickHome() {
  const [near, far] = CREA_NEAR;
  const px = player.x, pz = player.z;
  const inBand = (x, z) => {
    const d = Math.hypot(x - px, z - pz);
    return d >= near && d <= far;
  };
  const trees = [], parks = [], banks = [];
  for (const t of tiles.values()) {
    // タイルまるごと帯の外なら見ない
    if (Math.abs(t.offX - px) > far + HALF || Math.abs(t.offZ - pz) > far + HALF) continue;
    for (const tr of t.trees ?? []) if (inBand(tr.x, tr.z)) trees.push(tr);
    for (const p of t.data.parks ?? []) {
      if (p.k === 'pitch') continue;
      const pts = [];
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (let i = 0; i < p.f.length; i += 2) {
        const x = t.X(p.f[i]), z = t.Z(p.f[i + 1]);
        pts.push([x, z]);
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (z < minz) minz = z; if (z > maxz) maxz = z;
      }
      if (pts.length < 3) continue;
      // 外接矩形が帯に掛かるものだけ。中の点を選ぶのはこの後
      if (maxx < px - far || minx > px + far || maxz < pz - far || minz > pz + far) continue;
      parks.push({ pts, minx, maxx, minz, maxz });
    }
  }
  // 岸は**輪の頂点を先に帯で絞る**。水面レコードごと候補にして、あとから
  // 頂点をランダムに引く書き方だと、漫湖のような大きな面で当たらない
  // (実測: 龍潭は26件拾えたのに漫湖は1,200回試して0件)
  for (const w of waters) {
    if (w.maxx < px - far || w.minx > px + far ||
        w.maxz < pz - far || w.minz > pz + far) continue;
    const m = w.ring.length;
    for (let i = 0; i < m; i++) {
      const p = w.ring[i];
      if (!inBand(p.x, p.y)) continue;
      banks.push({ w, i });
    }
  }
  // 民家の壁。bstore から建物だけを拾う(木の幹・仮囲い・店内の固体は外す)。
  // 街のどこにでもあるので、ここが住みかの主力になる
  const wallsB = [];
  for (const b of bstore) {
    if (!b.tile || b.tile === SOLID_SHOP) continue;
    if (b.maxx - b.minx < 3 || b.maxz - b.minz < 3) continue;   // 幹や柱は除く
    const cx = (b.minx + b.maxx) / 2, cz = (b.minz + b.maxz) / 2;
    if (!inBand(cx, cz)) continue;
    wallsB.push(b);
  }

  const pools = [];
  if (wallsB.length) pools.push('wall', 'wall', 'wall');
  if (trees.length) pools.push('tree', 'tree');
  if (parks.length) pools.push('grass', 'grass');
  if (banks.length) pools.push('bank');
  if (!pools.length) return null;

  for (let k = 0; k < 30; k++) {
    const pool = pools[(Math.random() * pools.length) | 0];
    if (pool === 'wall') {
      const b = wallsB[(Math.random() * wallsB.length) | 0];
      const m = b.ring.length;
      const i = (Math.random() * m) | 0;
      const a = b.ring[i], c = b.ring[(i + 1) % m];
      const mx = (a.x + c.x) / 2, mz = (a.y + c.y) / 2;
      const bx = (b.minx + b.maxx) / 2, bz = (b.minz + b.maxz) / 2;
      // 壁の外へ少し離す。中心から見て外向き
      let ox = mx - bx, oz = mz - bz;
      const L = Math.hypot(ox, oz) || 1;
      ox /= L; oz /= L;
      const x = mx + ox * 0.34, z = mz + oz * 0.34;
      if (!inBand(x, z)) continue;
      if (blocked(x, z, 0.25)) continue;            // 壁にめり込む所は避ける
      const gy = groundAt(x, z);
      const y = gy + 1.2 + Math.random() * 0.8;
      if (y > b.top - 0.3) continue;                // 屋根より上には付けない
      return { x, z, y, kind: 'wall', yaw: Math.atan2(ox, oz) };
    }
    if (pool === 'tree') {
      const tr = trees[(Math.random() * trees.length) | 0];
      const a = Math.random() * Math.PI * 2;
      return { x: tr.x + Math.cos(a) * 0.24, z: tr.z + Math.sin(a) * 0.24,
               y: tr.y + 0.9 + Math.random() * Math.max(0.4, tr.h - 1.2),
               kind: 'tree', yaw: a };
    }
    if (pool === 'grass') {
      const p = parks[(Math.random() * parks.length) | 0];
      const x = p.minx + Math.random() * (p.maxx - p.minx);
      const z = p.minz + Math.random() * (p.maxz - p.minz);
      if (!inBand(x, z)) continue;
      if (!pointInPts(p.pts, x, z)) continue;
      if (blocked(x, z, 0.8)) continue;
      return { x, z, y: groundAt(x, z) + 0.9 + Math.random() * 0.8, kind: 'grass', yaw: 0 };
    }
    // 水辺。水面の輪の外へ少し出た陸の上。
    // **外向きは辺の法線から取る。** 重心から見た向きだと、漫湖のように
    // 長く曲がった面では岸と関係ない方角を指す
    const { w, i } = banks[(Math.random() * banks.length) | 0];
    const m = w.ring.length;
    const p = w.ring[i];
    const a = w.ring[(i - 1 + m) % m], c = w.ring[(i + 1) % m];
    let tx = c.x - a.x, tz = c.y - a.y;
    const L = Math.hypot(tx, tz) || 1;
    tx /= L; tz /= L;
    const o = 1.0 + Math.random() * 2.2;
    // 法線の左右どちらが陸かは分からないので、両方あたる
    let x = null, z = null;
    for (const s of Math.random() < 0.5 ? [1, -1] : [-1, 1]) {
      const qx = p.x + tz * s * o, qz = p.y - tx * s * o;
      if (!inBand(qx, qz)) continue;
      if (waterAt(qx, qz) !== null) continue;       // まだ水の上。岸ではない
      if (groundAt(qx, qz) < w.y - 0.2) continue;   // 水面より低い。岸ではない
      if (blocked(qx, qz, 0.8)) continue;
      x = qx; z = qz; break;
    }
    if (x === null) continue;
    const gy = groundAt(x, z);
    // 淡水か潮かは**水面レコードの種別をそのまま見る**。
    // waterKindAt に輪の頂点を渡してはいけない。頂点は境界の上にあるので
    // 内外判定が当てにならず、外と出れば海に落ちる。実際に龍潭(首里の
    // 淡水池、標高92m)でオカヤドカリが湧いた。
    // waters に入っているのは池と干潟だけで、海は入っていない
    return { x, z, y: gy + 0.05, yaw: 0,
             kind: w.k === 'wetland' ? 'tide' : 'bank' };
  }
  return null;
}

/** 点が多角形(配列の配列)の内側か。pointInRing は Vector2 用なので別に持つ。 */
function pointInPts(pts, x, z) {
  let s = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) s = !s;
  }
  return s;
}

function spawnCreature(c) {
  const home = pickHome();
  if (!home) { c.alive = false; return; }
  const list = CREATURES[home.kind];
  const [name, note, look, mode] = list[(Math.random() * list.length) | 0];
  if (c.g) { scene.remove(c.g); disposeTree(c.g); }
  c.g = makeCreature(look);
  c.name = name; c.note = note; c.look = look; c.mode = mode;
  c.home = home; c.phase = Math.random() * Math.PI * 2; c.alive = true;
  c.g.position.set(home.x, home.y, home.z);
  c.g.rotation.y = home.yaw + Math.random() * 0.8;
  scene.add(c.g);
}

for (let i = 0; i < CREA_N; i++) creatures.push({ g: null, alive: false });

/** いきものを1フレーム動かし、いちばん近い1匹を記録の相手にする。 */
function stepCreatures(dt) {
  creaNear = null;
  let best = CATCH_R;
  // 湧かし直しは1フレームに3匹まで。駅から歩きだすときのように場所が
  // 飛ぶと14匹いっぺんに湧き直して 2.3ms の山になる(pickHome が1匹0.164ms)
  let budget = 3;
  for (const c of creatures) {
    if (!c.alive) {
      if (budget <= 0) continue;
      budget--;
      spawnCreature(c);
      if (!c.alive) continue;
    }
    const h = c.home;
    const d = Math.hypot(h.x - player.x, h.z - player.z);
    // 帯から外れたら別の場所へ湧かし直す(車と同じ)
    if (d > CREA_NEAR[1] * 1.4) { c.alive = false; continue; }
    c.phase += dt;
    if (c.mode === 'fly') {
      // 住みかのまわりを漂う。上下にも揺れる
      const r = 1.1 + Math.sin(c.phase * 0.37) * 0.6;
      const a = c.phase * 0.55;
      c.g.position.set(h.x + Math.cos(a) * r, h.y + Math.sin(c.phase * 1.7) * 0.28,
                       h.z + Math.sin(a) * r);
      c.g.rotation.y = -a;
      // 羽ばたき。付け根の Group を Z 軸で振る
      const f = Math.sin(c.phase * 22) * 0.85;
      for (const { w, s } of c.g.userData.wings ?? []) w.rotation.z = f * s;
    } else {
      // とまっているものは、たまに向きを変えるだけ
      c.g.rotation.y = h.yaw + Math.sin(c.phase * 0.4) * 0.5;
    }
    if (d < best) { best = d; creaNear = c; }
  }
}

/** いま近くにいる1匹を図鑑に載せる。 */
function recordCreature() {
  const c = creaNear;
  if (!c) return;
  const first = !seenCrea.has(c.name);
  seenCrea.add(c.name);
  savePurse();
  updatePurseUI();
  say(first ? `${c.name} を図鑑に載せた — ${c.note}` : `${c.name} を見つけた`);
  c.alive = false;              // 逃げていく。次の場所へ湧かし直す
  creaNear = null;
  updateFishUI();
}

const fishEl = $('fish');

function updateFishUI() {
  if (!fishEl) return;
  const set = (t, m, b) => {
    $('fs-title').textContent = t;
    $('fs-msg').textContent = m;
    $('fs-btn').textContent = TOUCH ? b : `${b} [F]`;
    fishEl.classList.add('on');
  };
  if (fishing?.phase === 'bite') {
    set('きた！', 'いま引く', '合わせる');
  } else if (fishing) {
    set('糸をたらしている', '当たったら [F]・離れると上げる', '待つ');
  } else if (creaNear) {
    // いきものは逃げるので釣りより先。名前は近づけば見えているので出す
    set(creaNear.name, seenCrea.has(creaNear.name) ? '図鑑にある' : 'はじめて見る', '記録する');
  } else {
    const spot = castTarget();
    if (spot) set(spot.place || '水辺', '釣れます', '釣る');
    else fishEl.classList.remove('on');
  }
}

/**
 * 乗降のあいだの中間状態。
 *
 * ここを独立した状態にしないと落ちる。毎フレームの処理は
 * 「riding なら座席へ貼り付け／riding でなければ歩かせる」の二択で、
 * 補間中はそのどちらでもない。riding のまま transit を重ねることで、
 * 移動処理と supportY を止めたまま카メラだけを動かせる。
 */
let transit = null;      // {mode:'board'|'alight', t, dur, from, to?}
let cabin = null;        // 乗っている車内(乗っていなければ null)

const smooth = (u) => u * u * (3 - 2 * u);

/** v を省くと、いま近くに居る乗り物(boardable)に乗る。 */
function board(v = boardable) {
  if (riding || transit || !v) return;
  riding = v;
  boardable = null;
  setFly(false);
  player.vy = 0; player.onGround = true;
  document.body.classList.add('riding');
  stick = null; stickShow(false);
  cabin = buildCabin(riding);
  // 立っていた所から座席へ寄る。乗り物は停まっているので補間が暴れない
  transit = { mode: 'board', t: 0, dur: 0.85,
              from: { x: player.x, y: player.y, z: player.z } };
  say(`${riding.ref} ${riding.name} に乗車`);
  updateRideUI();
}

function alight() {
  if (!riding || transit) return;
  const b = riding;
  // バスは歩道側、モノレールはホーム側へ降ろす。塞がっていたら順に試す
  const yaw = b.g.rotation.y;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const cands = b.isTrain
    ? [[3.4, 0], [3.4, 6], [3.4, -6], [-3.4, 0], [3.4, 12]]
    : [[2.6, 0], [3.4, 0], [2.6, 3], [2.6, -3], [-2.6, 0], [0, 5]];
  // 降車地点は変数に受ける。ここで player を書くと横移動が1フレームで
  // 終わってしまい、補間するのが高さだけになる(実際にそうなっていた)
  let tx = b.g.position.x + 3, tz = b.g.position.z;
  for (const [ox, oz] of cands) {
    const x = b.g.position.x + ox * cos + oz * sin;
    const z = b.g.position.z - ox * sin + oz * cos;
    // 降りた先の足場(ホームの天端も含む)で判定する
    const s = supportY(x, z);
    if (!blocked(x, z, RADIUS, s)) { tx = x; tz = z; break; }
  }
  // すぐには降ろさない。riding を保ったまま、座席から降車地点へ寄せる。
  // ここで player を書き換えてしまうと、次のフレームの座席貼り付けが
  // それを上書きして、降りる動きが1フレームも見えない
  transit = { mode: 'alight', t: 0, dur: 0.8,
              from: { x: player.x, y: player.y, z: player.z },
              to: { x: tx, z: tz, y: supportY(tx, tz) + EYE } };
  player.vy = 0; player.onGround = true;
  say('降車');
  updateRideUI();
}

/** 降車の補間が終わったところで、本当に降ろす。 */
function finishAlight() {
  const to = transit.to;
  player.x = to.x; player.z = to.z;
  player.y = supportY(to.x, to.z) + EYE;
  player.vy = 0; player.onGround = true;
  disposeCabin(cabin); cabin = null;
  riding = null;
  transit = null;
  document.body.classList.remove('riding');
  updateRideUI();
}


/**
 * 乗車中のカメラ。座席へ貼り付け、乗降のあいだだけ補間する。
 *
 * tick から切り出してあるのは、ペインが隠れて rAF が止まる環境でも
 * 合成 dt で直接回して確かめられるようにするため(stepTrain/stepCars と同じ)。
 */
function stepRide(dt) {
  if (!riding) return;
  {
    const s = seatOf(riding);
    const yaw = riding.g.rotation.y;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const sx = riding.g.position.x + s.x * cos + s.z * sin;
    const sz = riding.g.position.z - s.x * sin + s.z * cos;
    const sy = riding.g.position.y + s.y;

    if (transit) {
      transit.t += dt;
      const u = Math.min(1, transit.t / transit.dur);
      const e = smooth(u);
      const f = transit.from;
      const to = transit.mode === 'board' ? { x: sx, y: sy, z: sz } : transit.to;
      player.x = f.x + (to.x - f.x) * e;
      player.y = f.y + (to.y - f.y) * e;
      player.z = f.z + (to.z - f.z) * e;
      // 扉は乗り降りのあいだだけ開ける。閉じきってから走り出す
      if (cabin) {
        const open = Math.sin(Math.PI * u);      // 0 → 1 → 0
        cabin.userData.open = open;
        cabin.userData.setDoors(open);
      }
      if (u >= 1) {
        if (transit.mode === 'alight') { finishAlight(); }
        else { transit = null; cabin?.userData.setDoors(0); }
      }
    } else {
      player.x = sx; player.y = sy; player.z = sz;
    }
    player.vy = 0; player.onGround = true;
  }
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
  if (!started) return;
  if (e.code === 'KeyE') rideAction();
  else if (e.code === 'KeyF') fishAction();
});

$('fs-btn').addEventListener('click', fishAction);
$('fs-btn').addEventListener('touchstart', (e) => {
  e.preventDefault();
  fishAction();
}, { passive: false });

// ---------------------------------------------------------------- 議会パネル
const COUNCIL_R = 16;          // この距離まで近づくと出る(m)
let councilNear = null, councilIdx = 0, councilRead = 0;
let councilClosed = false;     // ✕で閉じた。離れるまで出し直さない
const cvEl = $('council');

// 発言の全文は council_full.json(1.4MB)。抜粋の10.2倍あるので council.json には
// 混ぜず、「全文」を押したときに一度だけ落とす。起動を止めない。
let councilFull = null, councilFullBusy = false, councilShowFull = false;
function loadCouncilFull() {
  if (councilFull || councilFullBusy) return Promise.resolve(councilFull);
  councilFullBusy = true;
  return fetch('./data/council_full.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { councilFull = j ?? {}; return councilFull; })
    .catch(() => { councilFull = {}; return councilFull; })
    .finally(() => { councilFullBusy = false; });
}

function showCouncil(g) {
  if (!g || councilClosed) { cvEl.classList.remove('on'); return; }
  const p = g.userData.place;
  const i = councilIdx % p.speeches.length;
  const s = p.speeches[i];
  // 収録は那覇市議会と沖縄県議会の両方。発言ごとにどちらかを名乗る
  $('cv-body').textContent = `${s.body || '議会'}で言及`;
  $('cv-place').textContent = p.label;
  // 地点の要約。**発言の中身は言い換えない**(実在の人の発言を機械が要約すると、
  // 言っていないことを言ったことにしかねない)。数えれば分かる事実だけ
  $('cv-sum').textContent = p.sum ?? '';
  $('cv-speaker').textContent = s.speaker || '(発言者不明)';
  $('cv-date').textContent = `${s.date}　${s.meeting}`;
  const full = councilShowFull ? councilFull?.[p.term]?.[i] : null;
  $('cv-quote').textContent = full ?? s.excerpt;
  $('cv-quote').classList.toggle('full', !!full);
  $('cv-all').textContent = councilShowFull ? '抜粋' : '全文';
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

/** 抜粋 ↔ 全文 を切り替える。全文は押されたときに一度だけ落とす。 */
function toggleCouncilFull() {
  if (!councilNear) return;
  if (councilShowFull) { councilShowFull = false; showCouncil(councilNear); return; }
  if (councilFull) { councilShowFull = true; showCouncil(councilNear); return; }
  $('cv-all').textContent = '…';
  loadCouncilFull().then(() => {
    councilShowFull = true;
    showCouncil(councilNear);
  });
}

$('cv-all').addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation(); toggleCouncilFull();
});
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

  stepRide(dt);
  stepUnderwater();
  stepWaves(dt);

  // 乗れる車両を探す(停車中で、十分近いもの)
  {
    const prev = boardable;
    boardable = null;
    if (active && !riding) {
      let best = Infinity;
      const cands = [...buses, ...trains.map((t) => t.ride)];
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

  // 釣りといきもの。castTarget は見ている向きへ 15 回ほど waterAt を撃つので、
  // 当たりを待っているあいだ以外は 8 フレームに1回に間引く
  stepFishing(dt);
  if (active && !inShop) stepCreatures(dt);
  if (fishing?.phase === 'bite' || (frame & 7) === 0) updateFishUI();

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
    // 水。足元が水面より下なら泳ぐ。ただし浅ければ歩いて渡れる
    // (膝下の水たまりで泳ぎ出すと、岸沿いがまともに歩けない)
    const feet0 = player.y - EYE;
    const surf = flying ? null : waterAt(player.x, player.z);
    const bed = surf === null ? 0 : supportY(player.x, player.z);
    const swimming = surf !== null && feet0 < surf - 0.15 && surf - bed > WADE;

    // 泳ぎも視線の上下に進む(飛行と同じ操作感にそろえる)
    let my = (flying || swimming) ? fwd.y * fb : 0;
    if (swimming) {
      const cp = Math.cos(player.pitch);
      fwd.set(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp);
      mx = fwd.x * fb + right.x * lr;
      mz = fwd.z * fb + right.z * lr;
      my = fwd.y * fb;
    }
    // 足元(地表 or 屋根)の高さ。飛行中の当たり判定にも使う
    const feet = feet0;
    const len = (flying || swimming) ? Math.hypot(mx, my, mz) : Math.hypot(mx, mz);
    if (len > 0) {
      const sp = (flying ? FLY : swimming ? SWIM : run ? RUN : WALK) * dt * throttle;
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
    } else if (swimming) {
      // 浮力。放っておくと目が水面のすこし上で落ち着く。
      // ジャンプで浮上、Shift で潜る。飛行と同じ割り当てにそろえてある
      const up = (jumpHeld ? 1 : 0) -
                 (descend || keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0);
      const rest = surf + FLOAT;                 // 立ち泳ぎで落ち着く目の高さ
      if (up !== 0) {
        player.vy = up * SWIM_V;
      } else {
        // 水面へ戻る力。速度ではなく位置で寄せると、水面で上下に跳ねない
        player.vy = Math.max(-SWIM_V, Math.min(SWIM_V, (rest - player.y) * 2.2));
      }
      player.y += player.vy * dt + my;
      // 水底は抜けない。頭が水面から出すぎないように蓋もする
      if (player.y < bed + EYE) { player.y = bed + EYE; player.vy = 0; }
      if (player.y > rest + 0.35) { player.y = rest + 0.35; player.vy = 0; }
      player.onGround = false;
    } else {
      if (player.onGround && (jumpHeld || jumpTap)) {
        player.vy = JUMP; player.onGround = false;
      }
      player.vy -= GRAVITY * dt;
      player.y += player.vy * dt;
      if (player.y <= gy) { player.y = gy; player.vy = 0; player.onGround = true; }
    }
    inWater = swimming;
    jumpTap = false;
  }

  camera.position.set(player.x, player.y, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');

  // 空ドームをプレイヤーの真上へ運ぶ(far で切れて黒い穴が開くのを防ぐ)。
  // 高さは 0 のまま。上げるとドームの底が地面の下から出てこなくなる
  sky.position.set(player.x, 0, player.z);

  // 太陽(影のカメラ)をプレイヤーに追従させる
  sun.target.position.set(player.x, groundAt(player.x, player.z), player.z);
  sun.position.set(player.x + 150, groundAt(player.x, player.z) + 260, player.z + 110);
  sun.target.updateMatrixWorld();

  stepTrain(dt);
  stepCars(dt, sigT);
  stepMachines(dt);

  // タイルの足し引き。毎フレームやる必要は無い(歩き 4.6m/s なので
  // 30フレーム=0.5秒で 2.3m しか進まない)し、fetch が絡むので間引く
  if ((frame & 31) === 0) syncTiles();
  if (bakes.length) stepBakes();      // 地面テクスチャを少しずつ焼く

  // 史跡の案内。近づいた1件を出す(議会より近い距離で、こちらは名前だけでも出す)
  {
    let near = null, nd = Infinity;
    for (const g of historicPosts) {
      const dd = Math.hypot(g.position.x - hereX(), g.position.z - hereZ());
      if (dd < nd) { nd = dd; near = g; }
    }
    const hit = nd < SITE_R ? near : null;
    if (hit !== siteNear) { siteNear = hit; siteClosed = false; showSite(hit); }
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
      councilShowFull = false;      // 別の地点に移ったら抜粋に戻す
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
      const L = p.L;
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

  // 史跡の名札も近くだけ。市域で400件を超えるので常時出すと画面が埋まる。
  // 無名の亀甲墓・拝所はさらに近づかないと出さない
  for (const g of historicPosts) {
    const d2 = Math.hypot(g.position.x - player.x, g.position.z - player.z);
    g.userData.label.visible = d2 < (g.userData.site.anon ? 26 : 55);
  }

  // シーサーの回収
  let nearest = Infinity;
  for (const s of seesaa) {
    if (s.userData.taken) continue;
    // タイルを捨てた先に取り残された個体は隠す。地形が無くなっているので、
    // 出したままだと受け皿(平らな緑地)の上に立って見える
    if (!finale) s.visible = tiles.has(s.userData.tile);
    // 店内に居るあいだは入る前の位置で測る(街から離れた舞台に居るため)
    const d = Math.hypot(s.position.x - hereX(), s.position.z - hereZ());
    if (d < nearest) nearest = d;
    stepSeesaa(s, d, dt, now);                    // 歩く・脚を振る・近いと早足
    s.userData.ring.rotation.z += dt * 1.1;
    s.userData.ring.position.y = 0.1 + Math.sin(now * 0.003 + s.position.x) * 0.25;
    // 店内に居る間は回収しない。距離は入る前の位置で測っているので、
    // 店の中に居るあいだにシーサーが表を通ると、見えない所で最後の1体が
    // 埋まってフィナーレが誰にも見られずに終わってしまう
    if (d < PICKUP && active && !inShop) {
      s.userData.taken = true;
      s.visible = false;
      taken++;
      if (taken >= SEESAA_TOTAL) startFinale();
      else say(`シーサーを保護した（${taken}/${SEESAA_TOTAL}）`);
    }
  }
  if (finale) stepFinale(dt, now);

  // HUD
  elapsed = running ? (now - t0) / 1000 : elapsed;
  $('found').textContent = `${taken} / ${SEESAA_TOTAL}`;
  $('dist').textContent = taken >= SEESAA_TOTAL ? 'ぜんぶ発見' :
    (nearest === Infinity ? '—' : `${nearest.toFixed(0)} m`);
  // 店内の舞台は街の外にあるので、標高は入る前の値のまま見せる
  $('alt').textContent = `${((inShop ? shopReturn.y : player.y) - EYE).toFixed(1)} m`;
  // いま立っている 250m メッシュの人口密度(令和2年国勢調査)
  if ((frame & 15) === 0) {
    const c = meshAt(hereX(), hereZ());
    $('pop').textContent = c
      ? `${Math.round(c.p / (c.w * c.d / 1e6) / 100) / 10}千人/km²`
      : (meshCells.length ? '—' : '');
  }
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
  // ペインが隠れていると rAF が止まり、canvas が古い絵のままになる。確認用に手で描く
  draw: () => renderer.render(scene, camera),
  world, renderer, degrade, quality: () => qLevel, setFly, railPaths, railAt,
  council, councilPosts, showCouncil, buses, trains, bstore, sigPhase, signals,
  rmap, bmap, hashInsert, hashRemove, distToBuilding,
  // タイル関係(検証用)
  tiles, tileOf, worldBounds, fetchTile, buildTileCore, buildTileProps, TILE, HALF,
  // 全線データ(検証用)。切り出しの効きを直接見られる
  corridor, clipToLoaded, nearLoaded, polyLen, CORRIDOR_PAD,
  // タイルの読み込み／破棄(検証用)。tick を待たずに足し引きできる
  WORLD_TILES, WORLD_B, tileDist, syncTiles, dropTile,
  tileRange: () => ({ load: TILE_LOAD, drop: TILE_DROP }),
  setTileRange: (load, drop) => { TILE_LOAD = load; TILE_DROP = drop; },
  rebuildDerived, dropWalkLines, addWalkLines, carLines, cars, stepCars, addCarLines,
  board, alight, get riding() { return riding; }, get transit() { return transit; },
  get cabin() { return cabin; }, buildCabin, disposeCabin, stepRide,
  spawnPoints, applySpawn, seatOnSpawn, goSpawn, get lastSpawn() { return lastSpawn; },
  waters, waterAt, addWater, dropWater, get inWater() { return inWater; },
  isSea, buildSea, coast, SEA, riverAt, buildRivers, riverData,
  stepUnderwater, get underwater() { return wasUnder; }, stepWaves, WAVE, bakeMap, buildApron, seesaaGroup,
  // 工事(検証用)。可動部の姿勢をそのまま読める
  machines, stepMachines, siteAreasOf, addFences, addMachines,
  makeExcavator, makeCrawlerCrane, makeDumpTruck,
  // 釣りと持ち物(検証用)。当たりを待たずに合わせられる
  get fishing() { return fishing; }, fishAction, stepFishing, castTarget,
  waterKindAt, landFish, stopFishing, updateFishUI, FISH,
  bag, seenFish, get coins() { return coins; }, addItem, savePurse,
  resetPurse: () => { bag.clear(); seenFish.clear(); seenCrea.clear(); coins = 0;
    savePurse(); updatePurseUI(); },
  // いきもの(検証用)。湧かし直しと記録を tick を待たずに回せる
  creatures, seenCrea, CREATURES, stepCreatures, spawnCreature, pickHome,
  recordCreature, makeCreature, get creaNear() { return creaNear; },
  bakes, stepBakes, bakeTileMap, drawMap, MAP_SPAN, settleCouncil, historicPosts,
  meshCells, meshAt, siteNotes: () => siteNotes,
  heritageByOsm, heritageSolo, heritageFor, addSoloHeritage,
  visitSite: (i = 0) => { const g = historicPosts[i]; if (!g) return null;
    siteNear = g; siteClosed = false; showSite(g); return g.userData.site.name; },
  SEESAA_TOTAL, busSigns, shopSigns,
  stationStops, trainStopDs: () => trainStopDs, trainPath: () => trainPath,
  // 列車(検証用)。tick を待たずに走らせられる
  stepTrain, retargetTrain, TRAIN_SPEED, TRAIN_DWELL,
  trainState: () => trains.map((tr) => ({
    d: +tr.d.toFixed(1), dir: tr.dir, wait: +tr.wait.toFixed(1) })),
  // シーサー(検証用)。tick を待たずに歩きだけ回せる
  stepSeesaa, seatSeesaa, walkLines, walkAt,
  // 完成アニメーション(検証用)。10体集めずに再生できる
  startFinale, stepFinale, finaleState: () => finale && {
    t: +finale.t.toFixed(2), 粒: finale.motes.im.count,
    見えている体数: seesaa.filter((s) => s.visible).length },
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
  // 議会パネル(検証用)。近づかずに開ける。全文の切り替えも試せる
  visitCouncil: (i = 0) => {
    const g = councilPosts.filter((q) => q.visible)[i] ?? councilPosts[i];
    if (!g) return null;
    councilNear = g; councilIdx = 0; councilClosed = false; councilShowFull = false;
    showCouncil(g);
    return g.userData.place.label;
  },
  toggleCouncilFull, councilState: () => ({
    地点: councilNear?.userData.place.label ?? null,
    全文表示: councilShowFull, 全文を読み込み済み: !!councilFull,
  }),
  leaveShop: () => exitShop(),
  // 検証用: i 本目の列車を k 番目の停車位置に着けて長く停める
  trainToStation: (sec = 60, k = 0, i = 0) => {
    if (!trainStopDs.length || !trains[i]) return false;
    trains[i].d = trainStopDs[Math.min(k, trainStopDs.length - 1)];
    trains[i].wait = sec;
    return true;
  },
  flyState: () => ({ flying, jumpHeld, holdUsed, held: performance.now() - jumpSince }) };

// ---------------------------------------------------------------- 紅型と おもろ
// 読み込み画面の地。紅型(びんがた)は琉球の型染めで、
//  - 白地や黄地に **朱・藍・黄** をはっきり載せる(中間色で濁らせない)
//  - 花鳥風月の型を **繰り返し** 並べる(型紙で染めるため)
//  - **隈取り(くまどり)** = ひとつの形の片側だけを濃く暈す。これが無いと
//    ただのフラットな図案になり、紅型に見えない
// 画像は持たず、canvas に手続きで描く(この world の他と同じ方針)。
function drawBingata(cv) {
  const w = cv.width, h = cv.height;
  const g = cv.getContext('2d');
  // 種を固定。読み込むたびに柄が変わると落ち着かない
  let sd = 20260809;
  const r = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const AI   = '#123f52';   // 琉球藍
  const AI2  = '#0d2c3b';   // 濃藍
  const AKA  = '#c8402c';   // 朱
  const KI   = '#e8b53c';   // 黄
  const MIDO = '#3f7a52';   // 緑
  const SHIRO = '#f4ecd8';  // 白地

  g.fillStyle = AI;
  g.fillRect(0, 0, w, h);

  /** 隈取り。形の中心から片側へ濃い色を落とす。 */
  const kuma = (x, y, rad, col) => {
    const grd = g.createRadialGradient(x - rad * 0.3, y - rad * 0.3, rad * 0.1,
                                       x, y, rad);
    grd.addColorStop(0, col + '00');
    grd.addColorStop(1, col + 'aa');
    g.fillStyle = grd;
  };

  /** 花(梅・桜の見立て)。5弁で、芯に黄。 */
  const hana = (x, y, rad, petal, ring) => {
    g.save(); g.translate(x, y);
    for (let i = 0; i < 5; i++) {
      g.save(); g.rotate(i / 5 * Math.PI * 2);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(rad * 0.62, -rad * 0.42, 0, -rad);
      g.quadraticCurveTo(-rad * 0.62, -rad * 0.42, 0, 0);
      g.closePath();
      g.fillStyle = petal; g.fill();
      g.strokeStyle = SHIRO; g.lineWidth = Math.max(1, rad * 0.075); g.stroke();
      g.restore();
    }
    kuma(0, 0, rad, ring);
    g.beginPath(); g.arc(0, 0, rad, 0, 7); g.fill();
    g.beginPath(); g.arc(0, 0, rad * 0.2, 0, 7);
    g.fillStyle = KI; g.fill();
    g.restore();
  };

  /** 瑞雲。紅型の雲は「渦を巻いた団子」を横に連ねた形。 */
  const kumo = (x, y, sc, col) => {
    g.save(); g.translate(x, y); g.scale(sc, sc);
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      g.arc(-24 + i * 16, (i % 2 ? -4 : 2), 12 - i * 1.2, 0, 7);
    }
    g.fillStyle = col; g.fill();
    g.strokeStyle = SHIRO; g.lineWidth = 2.2; g.stroke();
    // 渦
    g.beginPath();
    g.arc(-24, 2, 5, 0.4, 5.2);
    g.strokeStyle = SHIRO; g.lineWidth = 2; g.stroke();
    g.restore();
  };

  /** 千鳥。紅型の鳥は思い切って単純な三角と丸で作る。 */
  const tori = (x, y, sc, col, flip) => {
    g.save(); g.translate(x, y); g.scale(flip ? -sc : sc, sc);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(14, -12, 30, -4);   // 背
    g.quadraticCurveTo(16, 10, 0, 0);      // 腹
    g.closePath();
    g.fillStyle = col; g.fill();
    g.strokeStyle = SHIRO; g.lineWidth = 2; g.stroke();
    // 翼
    g.beginPath();
    g.moveTo(10, -3); g.quadraticCurveTo(18, -18, 26, -10);
    g.quadraticCurveTo(18, -4, 10, -3);
    g.closePath();
    g.fillStyle = SHIRO; g.fill();
    g.beginPath(); g.arc(28, -6, 1.8, 0, 7); g.fillStyle = AI2; g.fill();
    g.restore();
  };

  /** 波。丸みのある弧を重ねる(青海波に近い形)。 */
  const nami = (y, step, amp, col, lw) => {
    g.strokeStyle = col; g.lineWidth = lw;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      for (let x = -step; x < w + step; x += step) {
        g.arc(x, y + k * amp * 0.55, step / 2 - k * 1.5, Math.PI, 0);
      }
      g.stroke();
    }
  };

  // 地に濃藍の斜め暈し(型染めの地染めのむら)
  const gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, AI2); gr.addColorStop(0.5, AI); gr.addColorStop(1, AI2);
  g.fillStyle = gr; g.fillRect(0, 0, w, h);

  // 波を上下に
  nami(h * 0.93, 82, 13, 'rgba(244,236,216,.38)', 2.6);
  nami(h * 0.06, 82, 13, 'rgba(244,236,216,.30)', 2.4);

  // 型を格子に並べる。少しずらして「型紙を送った」感じにする
  const CW = 132, CH = 118;
  for (let row = -1; row * CH < h + CH; row++) {
    for (let col = -1; col * CW < w + CW; col++) {
      const ox = col * CW + (row % 2 ? CW / 2 : 0);
      const oy = row * CH;
      const k = (row * 31 + col * 17) % 4;
      if (k === 0) {
        hana(ox + 34, oy + 36, 30, AKA, '#7d1f14');
        hana(ox + 88, oy + 84, 21, KI, '#a06a12');
      } else if (k === 1) {
        kumo(ox + 66, oy + 44, 1.05, 'rgba(244,236,216,.92)');
        hana(ox + 28, oy + 92, 24, MIDO, '#1d4a2c');
      } else if (k === 2) {
        tori(ox + 22, oy + 48, 1.25, KI, false);
        hana(ox + 92, oy + 92, 26, SHIRO, '#8a7a52');
      } else {
        hana(ox + 52, oy + 38, 28, KI, '#a06a12');
        tori(ox + 92, oy + 94, 1.1, AKA, true);
      }
      // 葉。型と型のあいだを埋める
      g.save();
      g.translate(ox + 106, oy + 18);
      g.rotate(r() * Math.PI * 2);
      g.beginPath();
      g.moveTo(0, 0); g.quadraticCurveTo(11, -7, 22, 0);
      g.quadraticCurveTo(11, 7, 0, 0);
      g.closePath();
      g.fillStyle = MIDO; g.fill();
      g.strokeStyle = SHIRO; g.lineWidth = 1.6; g.stroke();
      g.restore();
    }
  }
}

/** 画面の大きさに合わせて紅型を焼き直す。 */
function layoutBingata() {
  const cv = $('bingata');
  if (!cv) return;
  const w = Math.max(640, Math.ceil(innerWidth));
  const h = Math.max(480, Math.ceil(innerHeight));
  if (cv.width === w && cv.height === h) return;
  cv.width = w; cv.height = h;
  drawBingata(cv);
}
layoutBingata();
addEventListener('resize', layoutBingata);

// おもろさうしの一節を1つ出す。原文は Wikisource(パブリックドメイン)から、
// 歌の頭句だけを引いている。大意は逐語訳ではない。
fetch('./data/omoro.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    const songs = d?.songs ?? [];
    if (!songs.length) return;
    const s = songs[(Math.random() * songs.length) | 0];
    $('omoro-v').innerHTML = s.kanji.split('／').join('<br>');
    $('omoro-g').textContent = s.gist;
    $('omoro-r').textContent = `おもろさうし ${s.ref}`;
    $('omoro').hidden = false;
  })
  .catch(() => {});

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
// 棟数は **世界ぜんぶ** を出す。読み込み済みタイルで数えると、起動直後は
// 1〜5枚しか読んでいないので「1タイル」と出てしまう(実際に出ていた)。
// 建物の数は index.json が持っている。
const nBuildings = WORLD_TILES.reduce((s, t) => s + (t.n ?? 0), 0);
$('meta').textContent =
  `建物 ${nBuildings.toLocaleString()} 棟 ／ ` +
  `1km タイル ${WORLD_TILES.length} 枚（${(WORLD_B.maxx - WORLD_B.minx) / 1000}` +
  `×${(WORLD_B.maxz - WORLD_B.minz) / 1000}km）／ ` +
  `地形 ${tile0.n}×${tile0.n}（${tile0.cell}m格子）`;
drawMap();
tick();
