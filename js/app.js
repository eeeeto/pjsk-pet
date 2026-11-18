/* ===== 世界计划 桌宠模拟器 - 主逻辑 ===== */
/* 模型资源来自 sekai.best (Sekai Viewer) 公开的 Project Sekai SD Spine 资源，同人性质使用 */

const STORE_KEY = "pjsk-pet-settings-v1";

const defaultStore = () => ({
  c1: { id: null, flip: false, drag: true, scale: 1, fx: 0.5, fy: 0.8, accessories: [] },
  c2: null, // { id, flip, drag, scale, fx, fy, accessories }
  theme: "cream",
  bgImage: null, // dataURL
  ui: "#f28ab2",
  decoLibrary: [], // 挂件库 [{ name, src }]，全角色共用
  charQuotes: {},  // 每角色词条库 { [charId]: [词条] }
});

let store = defaultStore();
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  if (saved && saved.c1 && typeof saved.c1.id === "number") store = Object.assign(defaultStore(), saved);
} catch (e) { /* ignore */ }

// 归一化旧存档：补齐 accessories / 挂件库 / 每角色词条库
function normalizeStore() {
  for (const cfg of [store.c1, store.c2]) {
    if (cfg && !Array.isArray(cfg.accessories)) cfg.accessories = [];
    if (cfg) cfg.accessories = cfg.accessories.filter((a) => a && a.src);
    // 默认涂鸦挂件已移除，清理引用旧路径的挂件
    if (cfg) cfg.accessories = cfg.accessories.filter((a) => !/^assets\/decos\//.test(a.src));
  }
  if (!Array.isArray(store.decoLibrary)) store.decoLibrary = [];
  store.decoLibrary = store.decoLibrary.filter((d) => d && d.src);
  if (!store.charQuotes || typeof store.charQuotes !== "object") store.charQuotes = {};
  // 旧版全局词条迁移：若用户自定义过，则并入当前生效角色的词条库
  if (Array.isArray(store.quotes) && store.quotes.length) {
    const isDefault = JSON.stringify(store.quotes) === JSON.stringify(DEFAULT_QUOTES) ||
                      (typeof LEGACY_DEFAULT_QUOTES !== "undefined" &&
                       JSON.stringify(store.quotes) === JSON.stringify(LEGACY_DEFAULT_QUOTES));
    if (!isDefault) {
      for (const cfg of [store.c1, store.c2]) {
        if (cfg && cfg.id && !store.charQuotes[cfg.id]) {
          const char = CHARACTERS.find((c) => c.id === cfg.id);
          store.charQuotes[cfg.id] = [...((char && char.quotes) || []), ...store.quotes];
        }
      }
    }
    delete store.quotes;
  }
}
normalizeStore();

/* 每角色词条库 */
function getQuotes(charId) {
  if (!store.charQuotes[charId]) {
    const char = CHARACTERS.find((c) => c.id === charId);
    store.charQuotes[charId] = [...((char && char.quotes) || []), ...DEFAULT_QUOTES];
    saveStore();
  }
  return store.charQuotes[charId];
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
}

/* ---------- 工具 ---------- */
const $ = (s) => document.querySelector(s);
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function weightedPick(items) {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = Math.random() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it; }
  return items[items.length - 1];
}

/* ---------- PIXI 初始化 ---------- */
const SKEL_URL = "assets/sd_main.skel";
let skelBuf = null;
let app = null;

function initPixi() {
  const stageEl = $("#stage");
  app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    width: stageEl.clientWidth,
    height: stageEl.clientHeight,
  });
  stageEl.appendChild(app.view);
  app.ticker.add(tickerUpdate);
  window.addEventListener("resize", onResize);
}

function onResize() {
  const stageEl = $("#stage");
  app.renderer.resize(stageEl.clientWidth, stageEl.clientHeight);
  for (const slot of [1, 2]) {
    const pet = pets[slot];
    if (pet && pet.spine) applyPetLayout(pet);
  }
}

/* ---------- 模型加载 ---------- */
const baseTextureCache = new Map();
const atlasTextCache = new Map();

async function loadAtlas(char) {
  const txtUrl = `assets/chibis/${char.spine}/sekai_atlas.atlas.txt`;
  const pngUrl = `assets/chibis/${char.spine}/sekai_atlas.png`;
  const emc = getEmbed() && getEmbed().chibis && getEmbed().chibis[char.spine];
  let txt = atlasTextCache.get(char.spine);
  if (!txt) {
    txt = emc ? emc.atlas : await (await fetch(txtUrl)).text();
    atlasTextCache.set(char.spine, txt);
  }
  let bt = baseTextureCache.get(char.spine);
  if (!bt) {
    const img = new Image();
    img.src = emc ? emc.png : pngUrl;
    await img.decode();
    bt = new PIXI.BaseTexture(img);
    baseTextureCache.set(char.spine, bt);
  }
  const atlas = new PIXI.spine.TextureAtlas(txt, (page, cb) => cb(bt));
  return atlas;
}

function buildSkeletonData(atlas) {
  const loader = new PIXI.spine.AtlasAttachmentLoader(atlas);
  const bin = new PIXI.spine.SkeletonBinary(loader);
  return bin.readSkeletonData(new Uint8Array(skelBuf));
}

function prefixFor(char) { return PERSONALITY_PREFIX[char.personality] || PERSONALITY_PREFIX.normal; }

/* ---------- file:// 离线支持 ----------
   file:// 协议下浏览器会拦截 fetch 与本地图片进 WebGL，
   因此离线打开时动态加载 assets/embed.js（资源内嵌包，由 tools/build_embed.py 生成）。 */
function getEmbed() { return window.PJSK_EMBED || null; }

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("加载 " + src + " 失败"));
    document.head.appendChild(s);
  });
}

async function ensureEmbed() {
  if (location.protocol !== "file:" || getEmbed()) return;
  $("#sel-status").textContent = "离线模式：加载内嵌资源包…";
  await loadScript("assets/embed.js");
  if (!getEmbed()) throw new Error("离线资源包 assets/embed.js 缺失（请运行 tools/build_embed.py 生成），或改用本地服务器访问");
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function animName(data, prefix, key) {
  const cands = {
    idle: ["idle01_f", "idle01_f_v2"],
    idle2: ["idle02_f_v2", "idle02_f"],
    laugh: ["laugh01_f_v2", "laugh01_f"],
    listen: ["listen01_f_v2", "listen01_f"],
    doubt: ["doubt01_f_v2", "doubt01_f"],
    surprise: ["surprise01_f_v2", "surprise01_f"],
    talk: ["talk01_f_v2", "talk01_f"],
    joy: ["joy01_f_v2", "joy01_f"],
    angry: ["angry01_f_v2", "angry01_f"],
    sad: ["sad01_f_v2", "sad01_f"],
    walk: ["n_general_walk_01_f_v2", "n_general_walk_01_f"],
    wait: ["n_general_wait_01_f_v2", "n_general_wait_01_f"],
  }[key].map((n) => prefix + n).concat({ wait: ["n_general_wait_01_f"], walk: ["n_general_walk_01_f"] }[key] || []);
  for (const n of cands) if (data.animations.find((a) => a.name === n)) return n;
  return null;
}

function buildActionPool(data, prefix) {
  const pool = [];
  const add = (key, w) => { const n = animName(data, prefix, key); if (n) pool.push({ key, anim: n, w }); };
  add("idle", 4);
  add("idle2", 2);
  add("laugh", 2);
  add("listen", 2);
  add("doubt", 1);
  add("surprise", 1);
  add("talk", 1);
  add("joy", 1);
  add("angry", 0.5);
  add("sad", 0.5);
  const walk = animName(data, prefix, "walk");
  if (walk) pool.push({ key: "walk", anim: walk, w: 2 });
  return pool;
}

/* ---------- 小人对象 ---------- */
const pets = { 1: null, 2: null };
const GROUND_MIN = 0.72, GROUND_MAX = 0.9;

async function spawnPet(slot) {
  const cfg = slot === 1 ? store.c1 : store.c2;
  if (!cfg || !cfg.id) return;
  const char = CHARACTERS.find((c) => c.id === cfg.id);
  const stageEl = $("#stage");
  const W = stageEl.clientWidth, H = stageEl.clientHeight;

  destroyPet(slot);
  const atlas = await loadAtlas(char);
  const data = buildSkeletonData(atlas);
  const spine = new PIXI.spine.Spine(data);

  const pet = {
    slot, char, cfg, spine, data,
    prefix: prefixFor(char),
    unitBounds: null, fitScale: 1,
    busy: false, pendingIdle: false,
    walkTarget: null,
    actionTimer: null,
    bubbleUntil: 0,
  };
  pets[slot] = pet;

  spine.eventMode = "static";
  spine.cursor = "pointer";
  spine.state.data.defaultMix = 0.15;
  app.stage.addChild(spine);

  // 记录默认动作完成后的回调
  spine.state.addListener({
    complete: () => {
      if (pet.pendingIdle) { pet.pendingIdle = false; playAnim(pet, animName(data, pet.prefix, "idle"), true); }
    },
  });

  // 计算单位包围盒（scale=1 时）
  const idleAnim = animName(data, pet.prefix, "idle");
  spine.state.setAnimation(0, idleAnim, true);
  spine.update(0.05);
  const b = spine.getBounds();
  pet.unitBounds = b;
  pet.fitScale = (H * 0.34) / b.height;

  applyPetLayout(pet);

  // 交互：拖动 + 点击
  setupDrag(pet);

  // 播放第一个随机动作并排程
  scheduleNextAction(pet, rand(2500, 6000));
  // 挂载挂件
  await mountAccessories(pet);
  return pet;
}

/* ---------- 挂件 ---------- */
// 挂件作为 spine 子对象会随骨骼容器一起缩放（fitScale*cfg.scale），
// 因此这里按"角色身高的固定比例"反算本地缩放，保证挂件与角色大小成比例。
const decoTextureCache = new Map();

async function getDecoTexture(src) {
  let bt = decoTextureCache.get(src);
  if (!bt) {
    const img = new Image();
    img.src = src;
    await img.decode();
    bt = new PIXI.BaseTexture(img);
    decoTextureCache.set(src, bt);
  }
  return new PIXI.Texture(bt);
}

function accSpriteScale(pet, texH, acc) {
  const unitH = pet.unitBounds ? pet.unitBounds.height : 766;
  return (unitH * 0.38 * (acc.scale || 1)) / texH;
}

async function mountAccessories(pet) {
  if (pet.accSprites) pet.accSprites.forEach((s) => s.destroy());
  pet.accSprites = [];
  for (const acc of (pet.cfg.accessories || [])) {
    if (!acc || !acc.src) continue;
    try {
      const tex = await getDecoTexture(acc.src);
      const sp = new PIXI.Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set(accSpriteScale(pet, tex.height, acc));
      sp.position.set(acc.dx != null ? acc.dx : 0, acc.dy != null ? acc.dy : -600);
      sp.eventMode = "static";
      sp.cursor = "grab";
      sp.on("pointerdown", (e) => { e.stopPropagation(); startAccDrag(pet, sp, acc); });
      pet.spine.addChild(sp);
      pet.accSprites.push(sp);
    } catch (err) { console.warn("挂件加载失败", acc, err); }
  }
}

function startAccDrag(pet, sp, acc) {
  const move = (ev) => {
    const local = pet.spine.toLocal(ev.global);
    acc.dx = local.x; acc.dy = local.y;
    sp.position.set(local.x, local.y);
    pet.accDragged = true;
  };
  const up = () => {
    sp.off("globalpointermove", move);
    sp.off("pointerup", up);
    sp.off("pointerupoutside", up);
    if (pet.accDragged) { pet.accDragged = false; saveStore(); }
  };
  sp.on("globalpointermove", move);
  sp.on("pointerup", up);
  sp.on("pointerupoutside", up);
}

function defaultAccPos(pet) {
  if (!pet || !pet.unitBounds) return { dx: 0, dy: -600 };
  const b = pet.unitBounds;
  return { dx: 0, dy: b.y + b.height * 0.08 }; // 头顶
}

async function addAccessory(slot, acc) {
  const cfg = getCfg(slot);
  if (!cfg) { toast("请先在设置里选择该角色，再挂挂件～"); return; }
  const pet = pets[slot];
  // 没有小人在场上：直接按默认位置挂上
  if (!pet || !pet.spine) {
    cfg.accessories.push(Object.assign({ scale: 1, dx: 0, dy: -600 }, acc));
    saveStore(); renderAccList(slot);
    toast(`已挂上「${acc.name}」`);
    return;
  }
  // 有小人在场上：进入"拖动摆放"模式，点确定后才锁定
  cancelPlacement();
  closeModal();
  const temp = Object.assign({ scale: 1 }, defaultAccPos(pet), acc);
  let tex;
  try {
    tex = await getDecoTexture(acc.src);
  } catch (err) {
    toast(`「${acc.name}」图片加载失败，已跳过`);
    $("#settings-modal").classList.remove("hidden");
    return;
  }
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5);
  sp.scale.set(accSpriteScale(pet, tex.height, temp));
  sp.position.set(temp.dx, temp.dy);
  sp.eventMode = "static";
  sp.cursor = "grab";
  sp.on("pointerdown", (e) => { e.stopPropagation(); dragPlacementSprite(pet, sp, temp); });
  pet.spine.addChild(sp);
  pet.busy = true; // 摆放期间角色原地待机不乱走
  playIdle(pet);
  pendingPlacement = { slot, acc: temp, sprite: sp, pet };
  showPlacementBar(slot, acc.name);
  toast("拖动挂件摆好位置，点「确定」挂稳～");
}

/* ---------- 挂件摆放确认 ---------- */
let pendingPlacement = null;

function dragPlacementSprite(pet, sp, acc) {
  const move = (ev) => {
    const local = pet.spine.toLocal(ev.global);
    acc.dx = local.x; acc.dy = local.y;
    sp.position.set(local.x, local.y);
  };
  const up = () => {
    sp.off("globalpointermove", move);
    sp.off("pointerup", up);
    sp.off("pointerupoutside", up);
  };
  sp.on("globalpointermove", move);
  sp.on("pointerup", up);
  sp.on("pointerupoutside", up);
}

function showPlacementBar(slot, name) {
  const bar = $("#place-bar");
  if (!bar) return;
  $("#place-tip").textContent = `拖动「${name}」放到 ${slot === 1 ? "角色1" : "角色2"} 身上`;
  bar.classList.remove("hidden");
}

function hidePlacementBar() {
  const bar = $("#place-bar");
  if (bar) bar.classList.add("hidden");
}

async function confirmPlacement() {
  const p = pendingPlacement;
  if (!p) return;
  pendingPlacement = null;
  hidePlacementBar();
  if (p.sprite && !p.sprite.destroyed) p.sprite.destroy();
  p.pet.busy = false;
  // 角色在摆放期间被更换/移除时不再挂载
  if (pets[p.slot] !== p.pet) { $("#settings-modal").classList.remove("hidden"); return; }
  const cfg = getCfg(p.slot);
  cfg.accessories.push(p.acc);
  saveStore();
  await mountAccessories(p.pet);
  renderAccList(p.slot);
  $("#settings-modal").classList.remove("hidden"); // 回到设置面板
  toast(`「${p.acc.name}」挂稳啦！`);
}

function cancelPlacement() {
  const p = pendingPlacement;
  if (!p) return;
  pendingPlacement = null;
  hidePlacementBar();
  if (p.sprite && !p.sprite.destroyed) p.sprite.destroy();
  p.pet.busy = false;
}

async function removeAccessory(slot, idx) {
  const cfg = getCfg(slot);
  cfg.accessories.splice(idx, 1);
  saveStore();
  if (pets[slot]) await mountAccessories(pets[slot]);
  renderAccList(slot);
}

function applyPetLayout(pet) {
  const stageEl = $("#stage");
  const W = stageEl.clientWidth, H = stageEl.clientHeight;
  const s = pet.fitScale * (pet.cfg.scale || 1);
  const sgn = pet.cfg.flip ? -1 : 1;
  pet.spine.scale.set(sgn * s, s);
  const b = pet.unitBounds;
  const centerX = ((b.x + (b.x + b.width)) / 2) * (pet.cfg.flip ? -1 : 1);
  pet.spine.x = pet.cfg.fx * W - centerX * s;
  pet.spine.y = pet.cfg.fy * H - (b.y + b.height) * s;
}

function destroyPet(slot) {
  const pet = pets[slot];
  if (!pet) return;
  // 若该角色正处于挂件摆放中，静默放弃摆放
  if (pendingPlacement && pendingPlacement.slot === slot) {
    pendingPlacement = null;
    hidePlacementBar();
  }
  if (pet.actionTimer) clearTimeout(pet.actionTimer);
  if (pet.tapTimer) clearTimeout(pet.tapTimer);
  if (pet.spine) { pet.spine.destroy(); }
  pets[slot] = null;
  hideBubble(slot);
}

/* ---------- 动作调度 ---------- */
function playAnim(pet, name, loop) {
  if (!name) return;
  pet.currentAnim = name;
  pet.spine.state.setAnimation(0, name, loop);
}

function playIdle(pet) {
  pet.walkTarget = null;
  playAnim(pet, animName(pet.data, pet.prefix, "idle"), true);
}

function scheduleNextAction(pet, delay) {
  if (pet.actionTimer) clearTimeout(pet.actionTimer);
  pet.actionTimer = setTimeout(() => doRandomAction(pet), delay != null ? delay : rand(5000, 15000));
}

function doRandomAction(pet) {
  if (!pets[pet.slot]) return;
  if (pet.busy) { scheduleNextAction(pet, 3000); return; }
  const pool = pet.actionPool || (pet.actionPool = buildActionPool(pet.data, pet.prefix));
  const act = weightedPick(pool);
  if (act.key === "walk") {
    startWalk(pet);
    return;
  }
  if (act.key === "idle" || act.key === "idle2") {
    playAnim(pet, act.anim, true);
    pet.pendingIdle = false;
  } else {
    playAnim(pet, act.anim, false);
    pet.pendingIdle = true;
  }
  scheduleNextAction(pet);
}

function startWalk(pet) {
  const walkAnim = animName(pet.data, pet.prefix, "walk");
  // 默认向左走；已经贴着左边界或偶尔（20%）向右走
  let dir = -1;
  if (pet.cfg.fx < 0.24 || Math.random() < 0.2) dir = 1;
  pet.walkDir = dir;
  const dist = rand(0.12, 0.3);
  pet.walkTarget = Math.max(0.08, Math.min(0.92, pet.cfg.fx + dir * dist));
  pet.walkFy = 0.82; // 走路时回到地面基准线，不乱飘
  // 朝向：向右走时镜像翻转（叠加在用户的水平反转设置上）
  const needMirror = (dir > 0) !== !!pet.cfg.flip;
  const s = pet.fitScale * (pet.cfg.scale || 1);
  pet.spine.scale.x = (needMirror ? -1 : 1) * s;
  playAnim(pet, walkAnim, true);
}

function speak(slot, text, mood) {
  const pet = pets[slot];
  const bubble = $(`#bubble-${slot}`);
  bubble.textContent = text;
  bubble.classList.remove("hidden");
  bubble.dataset.mood = mood || "normal";
  pet.bubbleUntil = performance.now() + Math.max(2200, text.length * 180);
  positionBubble(slot);
}

function hideBubble(slot) {
  const bubble = $(`#bubble-${slot}`);
  if (bubble) bubble.classList.add("hidden");
}

function positionBubble(slot) {
  const pet = pets[slot];
  if (!pet || !pet.spine) return;
  const bubble = $(`#bubble-${slot}`);
  const roomRect = $("#room").getBoundingClientRect();
  const s = pet.fitScale * (pet.cfg.scale || 1);
  const b = pet.unitBounds;
  const headY = pet.spine.y + ((b.y + b.height) - b.height) * s;
  const cx = pet.spine.x - ((b.x + (b.x + b.width)) / 2) * (pet.cfg.flip ? -1 : 1) * s;
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  let left = cx - roomRect.left - bw / 2;
  left = Math.max(8, Math.min(left, roomRect.width - bw - 8));
  // 气泡位置低一点：底部沉到头顶以下约半个气泡高度
  let top = headY - roomRect.top - bh * 0.55;
  top = Math.max(4, top);
  bubble.style.left = left + "px";
  bubble.style.top = top + "px";
}

/* ---------- 交互（拖动 / 点击） ---------- */
function setupDrag(pet) {
  const spine = pet.spine;
  let down = false, moved = false, sx = 0, sy = 0;
  spine.on("pointerdown", (e) => {
    // 无论是否允许拖动都要记录按下，点击（tap）才能生效
    down = true; moved = false;
    sx = e.global.x; sy = e.global.y;
    if (pet.cfg.drag) spine.alpha = 0.85;
  });
  spine.on("globalpointermove", (e) => {
    if (!down || !pet.cfg.drag) return;
    const dx = e.global.x - sx, dy = e.global.y - sy;
    if (!moved && Math.hypot(dx, dy) > 6) moved = true;
    if (moved) {
      const stageEl = $("#stage");
      const W = stageEl.clientWidth, H = stageEl.clientHeight;
      pet.cfg.fx = Math.max(0.06, Math.min(0.94, pet.cfg.fx + dx / W));
      pet.cfg.fy = Math.max(GROUND_MIN - 0.06, Math.min(GROUND_MAX + 0.04, pet.cfg.fy + dy / H));
      applyPetLayout(pet);
      sx = e.global.x; sy = e.global.y;
    }
  });
  const endDrag = () => {
    if (!down) return;
    down = false;
    spine.alpha = 1;
    if (!moved) onPetTap(pet);
    else saveStore();
  };
  spine.on("pointerup", endDrag);
  spine.on("pointerupoutside", endDrag);
}

function onPetTap(pet) {
  if (pet.busy) return;
  const now = Date.now();
  // 生气持续期（10~60秒随机）：点它只会得到生气反应
  if (pet.angryUntil) {
    if (now < pet.angryUntil) {
      speak(pet.slot, pick(TAP_ANGRY_QUOTES));
      const angry = animName(pet.data, pet.prefix, "angry");
      if (angry && !pet.walkTarget) { playAnim(pet, angry, false); pet.pendingIdle = true; capOneShot(pet, angry, 3200); }
      return;
    }
    pet.angryUntil = null; // 恢复正常
    toast(`${pet.char.name} 气消啦～`);
  }
  // 一分钟内被点 3 次以上 → 生气，并持续 10~60 秒
  pet.tapLog = (pet.tapLog || []).filter((t) => now - t < 60000);
  pet.tapLog.push(now);
  if (pet.tapLog.length >= 3) {
    pet.tapLog = [];
    pet.angryUntil = now + rand(10000, 60000);
    speak(pet.slot, pick(TAP_ANGRY_QUOTES));
    const angry = animName(pet.data, pet.prefix, "angry");
    if (angry && !pet.walkTarget) { playAnim(pet, angry, false); pet.pendingIdle = true; capOneShot(pet, angry, 3200); }
    return;
  }
  // 说一句该角色词条库里的话
  speak(pet.slot, pick(getQuotes(pet.char.id)));
  // 播放说话动作（动画较长，超时自动回到待机，保证下次点击有新反应）
  const talk = animName(pet.data, pet.prefix, "talk");
  if (talk && !pet.walkTarget) { playAnim(pet, talk, false); pet.pendingIdle = true; capOneShot(pet, talk, 2800); }
}

// 单次动作最长播放 ms 毫秒后自动回到待机（防止超长动画卡住交互）
function capOneShot(pet, animNameStr, ms) {
  if (pet.tapTimer) clearTimeout(pet.tapTimer);
  pet.tapTimer = setTimeout(() => {
    pet.tapTimer = null;
    if (pets[pet.slot] !== pet) return;
    const cur = pet.spine.state.getCurrent(0);
    if (cur && cur.animation.name === animNameStr && !pet.walkTarget && !pet.busy) playIdle(pet);
  }, ms);
}

/* ---------- ticker ---------- */
function tickerUpdate() {
  const stageEl = $("#stage");
  const W = stageEl.clientWidth, H = stageEl.clientHeight;
  const now = performance.now();
  for (const slot of [1, 2]) {
    const pet = pets[slot];
    if (!pet || !pet.spine) continue;
    // 行走移动（贴地走向目标点，方向由 walkDir 决定）
    if (pet.walkTarget != null) {
      const speed = W * 0.055 * (app.ticker.deltaMS / 1000);
      const tx = pet.walkTarget * W;
      const dx = tx - pet.spine.x;
      // 走路期间逐渐回到地面高度
      if (pet.walkFy != null) {
        const stepY = H * 0.05 * (app.ticker.deltaMS / 1000);
        const dy = pet.walkFy * H - pet.spine.y;
        if (Math.abs(dy) > stepY) pet.spine.y += Math.sign(dy) * stepY;
      }
      if (Math.abs(dx) < speed) {
        pet.walkTarget = null;
        applyPetLayout(pet); // 恢复用户设置的朝向与位置
        playIdle(pet);
      } else {
        pet.spine.x += Math.sign(dx) * speed;
        // 保持朝向
        const s = pet.fitScale * (pet.cfg.scale || 1);
        const needMirror = (pet.walkDir > 0) !== !!pet.cfg.flip;
        pet.spine.scale.x = (needMirror ? -1 : 1) * s;
      }
    }
    // 对话框跟随 + 超时隐藏
    const bubble = $(`#bubble-${slot}`);
    if (!bubble.classList.contains("hidden")) {
      if (now > pet.bubbleUntil) hideBubble(slot);
      else positionBubble(slot);
    }
  }
}

/* ---------- 表情/粒子特效 ---------- */
function spawnFx(slot, emojis, count) {
  const pet = pets[slot];
  if (!pet) return;
  const fxLayer = $("#fx-layer");
  const roomRect = $("#room").getBoundingClientRect();
  const s = pet.fitScale * (pet.cfg.scale || 1);
  const b = pet.unitBounds;
  const headY = pet.spine.y + ((b.y + b.height) - b.height) * s;
  const cx = pet.spine.x - ((b.x + (b.x + b.width)) / 2) * (pet.cfg.flip ? -1 : 1) * s;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("span");
    el.className = "fx-item";
    el.textContent = pick(emojis);
    el.style.left = cx - roomRect.left + rand(-40, 40) + "px";
    el.style.top = headY - roomRect.top + rand(-10, 20) + "px";
    el.style.animationDuration = rand(1.1, 1.8) + "s";
    el.style.fontSize = rand(18, 30) + "px";
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 1900);
  }
}

/* ---------- 喂食 ---------- */
function feed(slot, food, liked) {
  const pet = pets[slot];
  if (!pet || pet.busy) return;
  pet.busy = true;
  const animKey = liked ? (Math.random() < 0.5 ? "joy" : "laugh") : (Math.random() < 0.5 ? "sad" : "angry");
  const anim = animName(pet.data, pet.prefix, animKey);
  playAnim(pet, anim, false);
  pet.pendingIdle = true;
  const tpl = liked ? pick(LIKE_LINES) : pick(DISLIKE_LINES);
  speak(slot, tpl.replace(/\{food\}/g, food.name), liked ? "happy" : "sad");
  spawnFx(slot, liked ? ["❤️", "✨", "💖", "🎵"] : ["💧", "💦", "🌀"], liked ? 6 : 5);
  setTimeout(() => { if (pets[slot]) pets[slot].busy = false; }, 3500);
}

/* ---------- 拍照 ---------- */
async function photo(slot) {
  const pet = pets[slot] || pets[1] || pets[2];
  if (!pet) { toast("先选个角色再拍照吧～"); return; }
  const stageEl = $("#stage");
  const W = stageEl.clientWidth, H = stageEl.clientHeight;
  // 截取整个舞台（含所有小人），并合成房间底色/背景图
  const rt = PIXI.RenderTexture.create({ width: W, height: H });
  app.renderer.render(app.stage, { renderTexture: rt });
  const ex = app.renderer.extract.canvas(rt);
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");
  const theme = THEMES[store.theme] || THEMES.cream;
  if (store.bgImage) {
    const img = new Image();
    img.src = store.bgImage;
    await img.decode().catch(() => {});
    // cover
    const r = Math.max(W / img.width, H / img.height);
    ctx.drawImage(img, (W - img.width * r) / 2, (H - img.height * r) / 2, img.width * r, img.height * r);
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, theme.wall);
    grad.addColorStop(0.7, theme.wallDark);
    grad.addColorStop(0.7, theme.floor);
    grad.addColorStop(1, theme.floorDark);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    drawRoomFurniture(ctx, W, H, theme);
  }
  ctx.drawImage(ex, 0, 0, W, H);
  // 水印
  ctx.font = `${Math.round(H * 0.024)}px sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillText("♪ PJSK 桌宠模拟器", 12, H - 12);

  out.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pjsk-pet-${pet.char.name}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(`已保存 ${pet.char.name} 的照片！📷`);
  }, "image/png");
}

/* ---------- 拍照：2D 复刻房间家具（与 CSS 位置一致） ---------- */
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawRoomFurniture(ctx, W, H, theme) {
  const mobile = W <= 768;
  // 地毯（含深色环）
  const rug = (scale) => {
    ctx.beginPath();
    ctx.ellipse(W / 2, H * 0.81, W * 0.31 * scale, H * 0.12 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = theme.rugDark || theme.rug;
  rug(1);
  ctx.fillStyle = theme.rug;
  rug(0.56);
  ctx.globalAlpha = 1;

  // 窗户（左上）
  const winW = mobile ? 96 : 150, winH = mobile ? 70 : 110;
  const wx = W * 0.08, wy = H * 0.07;
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  rr(ctx, wx + 3, wy + 5, winW, winH, 12);
  const sky = ctx.createLinearGradient(wx, wy, wx + winW, wy + winH);
  sky.addColorStop(0, "#bfe3f2");
  sky.addColorStop(0.6, "#dff2fb");
  sky.addColorStop(1, "#eef8fd");
  ctx.fillStyle = sky;
  rr(ctx, wx, wy, winW, winH, 10);
  ctx.strokeStyle = theme.wood || "#c98d5f";
  ctx.lineWidth = 6;
  ctx.strokeRect(wx + 3, wy + 3, winW - 6, winH - 6);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(wx + winW / 2, wy + 3);
  ctx.lineTo(wx + winW / 2, wy + winH - 3);
  ctx.stroke();
  // 窗帘
  ctx.fillStyle = "#fff";
  const cw = mobile ? 22 : 30;
  rr(ctx, wx - 10, wy - 8, cw, winH * 0.8, 8);
  rr(ctx, wx + winW + 10 - cw, wy - 8, cw, winH * 0.8, 8);

  // 沙发（左，锚定地面）
  const sw = mobile ? 150 : 220, sh = mobile ? 92 : 130;
  const sx = W * 0.04, sy = H * (1 - 0.09) - sh;
  // 靠背
  ctx.fillStyle = theme.sofa;
  rr(ctx, sx, sy, sw, sh - sh * 0.23, 24);
  ctx.fillStyle = theme.sofaDark;
  rr(ctx, sx, sy + (sh - sh * 0.23) - 8, sw, 8, 4);
  // 坐垫
  ctx.fillStyle = theme.sofa;
  rr(ctx, sx + 8, sy + sh - 56, sw - 16, 42, 12);
  ctx.fillStyle = theme.sofaDark;
  rr(ctx, sx + 8, sy + sh - 20, sw - 16, 6, 3);
  // 扶手
  ctx.fillStyle = theme.sofaDark;
  rr(ctx, sx - 10, sy + sh - 70, 34, 64, 14);
  rr(ctx, sx + sw - 24, sy + sh - 70, 34, 64, 14);
  // 抱枕
  ctx.save();
  ctx.translate(sx + 68, sy + 44); ctx.rotate(-0.1);
  ctx.fillStyle = "#fff3c9"; rr(ctx, -22, -22, 44, 44, 10);
  ctx.restore();
  ctx.save();
  ctx.translate(sx + sw - 68, sy + 44); ctx.rotate(0.12);
  ctx.fillStyle = "#fdd9c4"; rr(ctx, -22, -22, 44, 44, 10);
  ctx.restore();

  // 桌子（右，锚定地面）
  const tw = mobile ? 92 : 130, th = mobile ? 86 : 120;
  const tx = W * (1 - 0.07) - tw, ty = H * (1 - 0.06) - th;
  const wood = theme.wood || "#c98d5f";
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  rr(ctx, tx + tw / 2 - 40, ty + th - 8, 80, 10, 6);
  ctx.fillStyle = wood;
  rr(ctx, tx + tw / 2 - 7, ty + 18, 14, th - 22, 5);
  rr(ctx, tx + tw / 2 - 40, ty + th - 14, 80, 10, 6);
  ctx.beginPath();
  ctx.ellipse(tx + tw / 2, ty + 13, tw / 2, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `${mobile ? 17 : 24}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("☕", tx + tw / 2, ty - 2);
  ctx.textAlign = "start";
}


let thumbApp = null;
async function makeThumb(char) {
  if (!thumbApp) {
    thumbApp = new PIXI.Application({
      width: 180, height: 200, backgroundAlpha: 0, antialias: true, autoStart: false,
    });
  }
  const atlas = await loadAtlas(char);
  const data = buildSkeletonData(atlas);
  const spine = new PIXI.spine.Spine(data);
  const prefix = prefixFor(char);
  const idle = animName(data, prefix, "idle") || animName(data, prefix, "wait");
  spine.state.setAnimation(0, idle || data.animations[0].name, true);
  spine.update(0.05);
  thumbApp.stage.addChild(spine);
  const b = spine.getBounds();
  const s = Math.min(140 / b.width, 165 / b.height);
  spine.scale.set(s);
  spine.x = 90 - ((b.x + (b.x + b.width)) / 2) * s;
  spine.y = 190 - (b.y + b.height) * s;
  thumbApp.render();
  const rt = PIXI.RenderTexture.create({ width: 180, height: 200 });
  thumbApp.renderer.render(thumbApp.stage, { renderTexture: rt });
  const ex = thumbApp.renderer.extract.canvas(rt);
  const url = ex.toDataURL("image/png");
  thumbApp.stage.removeChild(spine);
  spine.destroy();
  return url;
}

/* ---------- 选人界面 ---------- */
const selectState = { target: 1, thumbs: {} };

async function initSelectScreen() {
  const grid = $("#thumb-grid");
  grid.innerHTML = "";
  for (const char of CHARACTERS) {
    const card = document.createElement("div");
    card.className = "char-card";
    card.dataset.id = char.id;
    card.innerHTML = `
      <div class="thumb-box"><div class="thumb-loading">…</div></div>
      <div class="char-name">${char.name}</div>
      <div class="char-unit">${char.unit}</div>`;
    card.addEventListener("click", () => onCardClick(char, card));
    grid.appendChild(card);
  }
  // 逐个生成缩略图
  for (const char of CHARACTERS) {
    const card = grid.querySelector(`[data-id="${char.id}"]`);
    try {
      const url = await makeThumb(char);
      selectState.thumbs[char.id] = url;
      card.querySelector(".thumb-box").innerHTML = `<img src="${url}" alt="${char.name}">`;
    } catch (e) {
      card.querySelector(".thumb-box").textContent = "😵";
    }
    $("#sel-status").textContent = `正在生成模型预览 ${char.id}/${CHARACTERS.length} …`;
    await new Promise((r) => setTimeout(r, 0));
  }
  $("#sel-status").textContent = "加载完成！选择角色后开始吧 ♪";
  refreshCardSelection();
}

function onCardClick(char, card) {
  if (selectState.target === 1) {
    store.c1.id = char.id;
    // 选完角色1后自动切换到角色2
    selectState.target = 2;
    document.querySelector('input[name="target"][value="2"]').checked = true;
  } else {
    // 角色2：再次点击同一个则取消
    if (store.c2 && store.c2.id === char.id) store.c2 = null;
    else store.c2 = { id: char.id, flip: false, drag: true, scale: 1, fx: 0.68, fy: 0.8, accessories: [] };
    // 两个角色不能相同
    if (store.c2 && store.c2.id === store.c1.id) {
      toast("角色2不能和角色1相同哦！");
      store.c2 = null;
    }
  }
  saveStore();
  refreshCardSelection();
}

function refreshCardSelection() {
  const c1 = store.c1.id, c2 = store.c2 ? store.c2.id : null;
  document.querySelectorAll(".char-card").forEach((card) => {
    const id = +card.dataset.id;
    card.classList.toggle("sel-1", id === c1);
    card.classList.toggle("sel-2", id === c2);
  });
  $("#btn-start").disabled = !c1;
}

/* ---------- 主界面 ---------- */
async function enterMain() {
  $("#select-screen").classList.add("hidden");
  $("#main-screen").classList.remove("hidden");
  initPixi();
  applyTheme();
  // 布局：单人居中，双人左右
  if (store.c2 && store.c2.id) {
    if (!store.c1.customPos) store.c1.fx = 0.32;
    if (!store.c2.customPos) store.c2.fx = 0.68;
  } else {
    store.c1.fx = 0.5;
  }
  await spawnPet(1);
  if (store.c2 && store.c2.id) await spawnPet(2);
  buildPanels();
}

function buildPanels() {
  const panels = $("#panels");
  panels.innerHTML = "";
  for (const slot of [1, 2]) {
    const pet = pets[slot];
    if (!pet) continue;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="panel-title"><span class="slot-tag">角色${slot}</span>${pet.char.name}</div>
      <div class="panel-btns">
        <button class="btn feed-btn">🍪 喂食</button>
      </div>`;
    panel.querySelector(".feed-btn").addEventListener("click", () => openFeedModal(slot));
    panels.appendChild(panel);
  }
}

function openFeedModal(slot) {
  const pet = pets[slot];
  if (!pet) return;
  const modal = $("#feed-modal");
  const likeBox = modal.querySelector(".food-list.like");
  const dislikeBox = modal.querySelector(".food-list.dislike");
  modal.querySelector(".feed-char-name").textContent = pet.char.name;
  likeBox.innerHTML = "";
  pet.char.like.forEach((f) => {
    const b = document.createElement("button");
    b.className = "food-btn";
    b.innerHTML = `<span class="food-emoji">${f.emoji}</span>${f.name}`;
    b.addEventListener("click", () => { closeModal(); feed(slot, f, true); });
    likeBox.appendChild(b);
  });
  dislikeBox.innerHTML = "";
  if (pet.char.dislike.length === 0) {
    const note = pet.char.like.find((f) => f.note);
    dislikeBox.innerHTML = `<span class="food-empty">${note ? note.note : "没有讨厌的食物"}</span>`;
  } else {
    pet.char.dislike.forEach((f) => {
      const b = document.createElement("button");
      b.className = "food-btn";
      b.innerHTML = `<span class="food-emoji">${f.emoji}</span>${f.name}`;
      b.addEventListener("click", () => { closeModal(); feed(slot, f, false); });
      dislikeBox.appendChild(b);
    });
  }
  modal.classList.remove("hidden");
}

function closeModal() {
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
}

/* ---------- 主题 ---------- */
function applyTheme() {
  const theme = THEMES[store.theme] || THEMES.cream;
  const room = $("#room");
  for (const [k, v] of Object.entries(theme)) {
    if (k === "name") continue;
    room.style.setProperty(`--${k}`, v);
  }
  room.classList.toggle("custom-bg", !!store.bgImage);
  room.style.backgroundImage = store.bgImage ? `url("${store.bgImage}")` : "";
  document.documentElement.style.setProperty("--ui", store.ui);
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 2400);
}

/* ---------- 设置面板 ---------- */
function initSettings() {
  const modal = $("#settings-modal");
  $("#btn-settings").addEventListener("click", () => { syncSettingsUI(); modal.classList.remove("hidden"); });
  modal.querySelector(".modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  // 挂件摆放确认条
  $("#place-ok").addEventListener("click", confirmPlacement);
  $("#place-cancel").addEventListener("click", () => { cancelPlacement(); modal.classList.remove("hidden"); });

  // 挂件与词条库
  renderAccTools(1); renderAccTools(2);
  renderAccList(1); renderAccList(2);
  renderQuoteSections();
  // 角色1
  fillCharSelect($("#set-c1-char"), false);
  $("#set-c1-char").addEventListener("change", async (e) => {
    store.c1.id = +e.target.value;
    if (store.c2 && store.c2.id === store.c1.id) { store.c2 = null; toast("角色2已被移除（不能重复）"); }
    saveStore();
    await rebuildPets();
    buildPanels();
  });
  bindSlotToggles(1);
  fillCharSelect($("#set-c2-char"), true);
  $("#set-c2-char").addEventListener("change", async (e) => {
    const v = +e.target.value;
    if (!v) store.c2 = null;
    else {
      if (v === store.c1.id) { toast("不能和角色1相同哦！"); e.target.value = store.c2 ? store.c2.id : 0; return; }
      if (store.c2) store.c2.id = v;
      else store.c2 = { id: v, flip: false, drag: true, scale: 1, fx: 0.68, fy: 0.8, accessories: [] };
    }
    saveStore();
    await rebuildPets();
    buildPanels();
  });
  bindSlotToggles(2);

  // 背景
  const themeBox = $("#theme-swatches");
  for (const [key, t] of Object.entries(THEMES)) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.dataset.theme = key;
    b.title = t.name;
    b.style.background = `linear-gradient(${t.wall} 70%, ${t.floor} 70%)`;
    b.addEventListener("click", () => {
      store.theme = key; store.bgImage = null; saveStore(); applyTheme(); syncSettingsUI();
      toast(`背景已切换：${t.name}`);
    });
    themeBox.appendChild(b);
  }
  $("#set-bgfile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { store.bgImage = reader.result; saveStore(); applyTheme(); syncSettingsUI(); toast("背景图已应用！"); };
    reader.readAsDataURL(file);
    e.target.value = "";
  });
  $("#btn-reset-bg").addEventListener("click", () => {
    store.bgImage = null; store.theme = "cream"; saveStore(); applyTheme(); syncSettingsUI(); toast("已恢复默认背景");
  });

  // UI 颜色
  const uiBox = $("#ui-swatches");
  UI_COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "swatch ui-swatch";
    b.title = c.name;
    b.style.background = c.color;
    b.addEventListener("click", () => { store.ui = c.color; saveStore(); applyTheme(); syncSettingsUI(); });
    uiBox.appendChild(b);
  });
  $("#set-uicolor").addEventListener("input", (e) => {
    store.ui = e.target.value; saveStore(); applyTheme();
  });
}

function fillCharSelect(sel, optional) {
  sel.innerHTML = optional ? `<option value="0">（不使用）</option>` : "";
  CHARACTERS.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.name}（${c.unit}）`;
    sel.appendChild(opt);
  });
}

function bindSlotToggles(slot) {
  const p = `#set-c${slot}`;
  $(`${p}-flip`).addEventListener("change", (e) => {
    getCfg(slot).flip = e.target.checked; saveStore();
    const pet = pets[slot]; if (pet) applyPetLayout(pet);
  });
  $(`${p}-drag`).addEventListener("change", (e) => {
    getCfg(slot).drag = e.target.checked; saveStore();
  });
  $(`${p}-scale`).addEventListener("input", (e) => {
    getCfg(slot).scale = +e.target.value; saveStore();
    const pet = pets[slot]; if (pet) applyPetLayout(pet);
  });
}

function getCfg(slot) { return slot === 1 ? store.c1 : store.c2; }

/* ---------- 设置：挂件 UI ---------- */
function renderAccTools(slot) {
  const box = $(`#acc-tools-${slot}`);
  if (!box) return;
  box.innerHTML = "";
  const lib = store.decoLibrary || [];
  // 挂件库（全角色共用，点击挂载）
  if (!lib.length) {
    const tip = document.createElement("span");
    tip.className = "acc-empty-lib";
    tip.textContent = "挂件库是空的，导入 PNG 开始吧～";
    box.appendChild(tip);
  }
  lib.forEach((d, idx) => {
    const b = document.createElement("button");
    b.className = "acc-pick";
    b.title = `挂上「${d.name}」`;
    b.innerHTML = `<img src="${d.src}" alt="${d.name}">`;
    const del = document.createElement("span");
    del.className = "acc-lib-del";
    del.textContent = "✕";
    del.title = "从挂件库删除";
    del.addEventListener("click", (e) => { e.stopPropagation(); removeFromLibrary(idx); });
    b.appendChild(del);
    b.addEventListener("click", () => addAccessory(slot, { name: d.name, src: d.src }));
    box.appendChild(b);
  });
  // 导入 PNG：先存入挂件库，再进入摆放模式
  const label = document.createElement("label");
  label.className = "btn small acc-import";
  label.textContent = "＋ 导入PNG";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/png,image/*";
  file.multiple = true;
  file.style.display = "none";
  file.addEventListener("change", async () => {
    const files = [...file.files];
    if (!files.length) return;
    const added = [];
    for (const f of files) {
      try {
        const src = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = () => rej(new Error("读取失败"));
          reader.readAsDataURL(f);
        });
        // 校验是有效图片再入库
        const img = new Image();
        img.src = src;
        await img.decode();
        const item = { name: f.name.replace(/\.[^.]+$/, ""), src };
        store.decoLibrary.push(item);
        added.push(item);
      } catch (err) {
        toast(`「${f.name}」不是有效图片，已跳过`);
      }
    }
    if (added.length) {
      saveStore();
      renderAccTools(1); renderAccTools(2);
      if (store.decoLibrary.length + (store.c1.accessories.length + (store.c2 ? store.c2.accessories.length : 0)) > 12) {
        toast("提示：挂件图片存在浏览器里，太多可能存不下哦");
      }
      // 进入摆放模式（最后一个导入的）
      addAccessory(slot, added[added.length - 1]);
    }
    file.value = "";
  });
  label.appendChild(file);
  box.appendChild(label);
}

function removeFromLibrary(idx) {
  store.decoLibrary.splice(idx, 1);
  saveStore();
  renderAccTools(1); renderAccTools(2);
  toast("已从挂件库移除");
}

function renderAccList(slot) {
  const box = $(`#acc-list-${slot}`);
  if (!box) return;
  box.innerHTML = "";
  const cfg = getCfg(slot);
  const active = slot === 1 ? !!store.c1.id : !!(store.c2 && store.c2.id);
  if (!active) { box.innerHTML = `<div class="acc-empty">（先选择该角色）</div>`; return; }
  if (!cfg.accessories.length) { box.innerHTML = `<div class="acc-empty">（还没有挂件）</div>`; return; }
  cfg.accessories.forEach((acc, idx) => {
    const item = document.createElement("div");
    item.className = "acc-item";
    item.innerHTML = `
      <img src="${acc.src}" alt="">
      <span class="acc-name">${acc.name || "挂件"}</span>
      <label class="acc-size">大小<input type="range" min="0.3" max="3" step="0.1" value="${acc.scale || 1}"></label>
      <button class="acc-del" title="取下挂件">✕</button>`;
    item.querySelector("input").addEventListener("input", (e) => {
      acc.scale = +e.target.value;
      const pet = pets[slot];
      if (pet && pet.accSprites && pet.accSprites[idx]) {
        pet.accSprites[idx].scale.set(accSpriteScale(pet, pet.accSprites[idx].texture.height, acc));
      }
      saveStore();
    });
    item.querySelector(".acc-del").addEventListener("click", () => removeAccessory(slot, idx));
    box.appendChild(item);
  });
}

/* ---------- 设置：词条库 UI ---------- */
/* 每个生效角色一个词条库区块；charKey = "1" / "2"（面板位） */
function renderQuoteSections() {
  const box = $("#quote-sections");
  if (!box) return;
  box.innerHTML = "";
  const slots = [1, 2].filter((s) => {
    const cfg = s === 1 ? store.c1 : store.c2;
    return cfg && cfg.id;
  });
  if (!slots.length) {
    box.innerHTML = `<div class="acc-empty">（先选择角色，才能编辑它的词条库）</div>`;
    return;
  }
  slots.forEach((slot) => {
    const cfg = slot === 1 ? store.c1 : store.c2;
    const char = CHARACTERS.find((c) => c.id === cfg.id);
    const sec = document.createElement("div");
    sec.className = "qsec";
    sec.innerHTML = `
      <h4>${slot === 1 ? "角色1" : "角色2"} · ${char.name}</h4>
      <div class="quote-chips"></div>
      <div class="row">
        <input type="text" class="quote-input" placeholder="给 ${char.name} 添加新词条～">
        <button class="btn small q-add">添加</button>
      </div>
      <button class="btn small ghost q-reset">恢复默认词条</button>`;
    const chips = sec.querySelector(".quote-chips");
    const input = sec.querySelector(".quote-input");
    const quotes = getQuotes(char.id);
    const render = () => {
      chips.innerHTML = "";
      const list = getQuotes(char.id);
      if (!list.length) { chips.innerHTML = `<span class="food-empty">词条库空了，添加几个吧～</span>`; return; }
      list.forEach((q, idx) => {
        const chip = document.createElement("span");
        chip.className = "quote-chip";
        chip.textContent = q;
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = "删除这条词条";
        del.addEventListener("click", () => { list.splice(idx, 1); saveStore(); render(); });
        chip.appendChild(del);
        chips.appendChild(chip);
      });
    };
    const add = () => {
      const v = input.value.trim();
      if (!v) return;
      const list = getQuotes(char.id);
      if (list.length >= 200) { toast("词条太多啦，先删掉一些吧"); return; }
      list.push(v);
      input.value = "";
      saveStore(); render();
      toast(`${char.name} 的词条已添加，点它试试！`);
    };
    sec.querySelector(".q-add").addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    sec.querySelector(".q-reset").addEventListener("click", () => {
      const persona = (char.quotes || []);
      store.charQuotes[char.id] = [...persona, ...DEFAULT_QUOTES];
      saveStore(); render(); toast(`${char.name} 的词条已恢复默认`);
    });
    render();
    box.appendChild(sec);
  });
}

function syncSettingsUI() {
  const c1 = store.c1, c2 = store.c2 || { id: 0, flip: false, drag: true, scale: 1 };
  $("#set-c1-char").value = c1.id || "";
  $("#set-c1-flip").checked = !!c1.flip;
  $("#set-c1-drag").checked = !!c1.drag;
  $("#set-c1-scale").value = c1.scale || 1;
  $("#set-c2-char").value = c2.id || 0;
  $("#set-c2-flip").checked = !!c2.flip;
  $("#set-c2-drag").checked = c2.drag !== false;
  $("#set-c2-scale").value = c2.scale || 1;
  document.querySelectorAll("#theme-swatches .swatch").forEach((b) => b.classList.toggle("active", b.dataset.theme === store.theme && !store.bgImage));
  document.querySelectorAll("#ui-swatches .swatch").forEach((b) => b.classList.toggle("active", b.title && UI_COLORS.find((c) => c.color === store.ui && c.name === b.title)));
  $("#set-uicolor").value = store.ui;
  renderQuoteSections();
  renderAccList(1); renderAccList(2);
}

async function rebuildPets() {
  destroyPet(1); destroyPet(2);
  if (store.c2 && store.c2.id) {
    if (store.c1.fx === 0.5) store.c1.fx = 0.32;
    if (store.c2.fx === 0.5 || !store.c2.fx) store.c2.fx = 0.68;
  } else {
    store.c1.fx = store.c1.fx === 0.32 ? 0.5 : store.c1.fx;
  }
  await spawnPet(1);
  if (store.c2 && store.c2.id) await spawnPet(2);
  buildPanels();
}

/* ---------- 启动 ---------- */
async function boot() {
  // 离线（file://）时先加载内嵌资源包
  await ensureEmbed();
  // 加载共享骨骼
  $("#sel-status").textContent = "正在下载小人模型（sd_main.skel）…";
  skelBuf = getEmbed() ? b64ToBytes(getEmbed().skel) : await (await fetch(SKEL_URL)).arrayBuffer();
  applyTheme();
  initSettings();
  document.querySelectorAll('input[name="target"]').forEach((r) => {
    r.addEventListener("change", (e) => { selectState.target = +e.target.value; });
  });
  $("#btn-start").addEventListener("click", () => { if (!store.c1.id) return; enterMain(); });
  $("#btn-photo").addEventListener("click", () => photo(1));
  document.querySelectorAll(".modal-close").forEach((b) => b.addEventListener("click", closeModal));
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModal(); }));
  if (store.c1.id) {
    // 有存档，直接进入主界面
    $("#sel-status").textContent = "检测到存档，正在恢复…";
    await enterMain();
    if (!(store.c2 && store.c2.id)) { /* 单人 */ }
  } else {
    await initSelectScreen();
  }
}

boot().catch((e) => {
  console.error(e);
  $("#sel-status").textContent = "加载出错：" + (e && e.message || e);
});
