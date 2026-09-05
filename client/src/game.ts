import { state } from './state.ts';
import { ARMOR_SLOTS, BLOCKING_TILES, EQUIPMENT_SLOTS, SCALING_COEFFS, ABILITY_SLOTS, UNARMED_ATTACK_ID, WEAPON_ATTACK_ID, PLAYER_BASE_ACT_TICKS, TICK_MS, actTicks, resolveHotbar, xpForNext } from '../../shared/constants.ts';
import { buildSpriteColorMap, buildTileColorMap, pickSeamTile, pickTileVariant } from '../../shared/tileset.ts';
import { renderAbilityIcon } from '../../shared/abilityIcon.ts';
import { rarityColor } from '../../shared/itemVisuals.ts';
import { getPlayerSprite, whenLayerLoads } from './playerSprite.ts';
import { getItemIcon, itemIconEl } from './itemIcon.ts';
import type { VisualSource } from '../../shared/itemVisuals.ts';
import type { IconSpec } from '../../shared/abilityIcon.ts';
import {
  isWild, wildTile, wildEntities, wildActiveZones, wildWalkable, discoveredSites, revealedSites, getWildAtlas, getWildSeeds,
} from './wilderness.ts';
import { CHUNK_SIZE } from '../../shared/worldgen/config.ts';
import { wildTileAt } from '../../shared/worldgen/field.ts';
import { hash2d } from '../../shared/worldgen/noise.ts';
import type {
  AbilityDef, ActiveZoneSnapshot, CastFailedEvent, CastFailure, CcKind, ClassId, EntitySnapshot, EquipSlot,
  FeaturedStockEntry, InventoryStack, LootSlot, PlayerEntity, QuestDef, Range, RolledStats, StatId, TimedModifier, TrainOffer,
} from '../../shared/types.ts';

// The tile size the world is drawn at. Not a constant: the zoom (see camZoom
// below) rescales it, and every world-space computation in this file derives
// from it, so they all follow along.
const BASE_TILE = 32;
let TILE = BASE_TILE;
const corpseEmptiedAt = new Map<string, number>();

// Sprite image cache — keyed by sprite id. Populated on first use.
// Files are served from /sprites/<id>.png (client/public/sprites/).
const spriteImages = new Map<string, HTMLImageElement | null>();
function getSpriteImage(spriteId: string): HTMLImageElement | null {
  if (spriteImages.has(spriteId)) return spriteImages.get(spriteId)!;
  spriteImages.set(spriteId, null); // mark as loading
  const img = new Image();
  img.onload = () => spriteImages.set(spriteId, img);
  img.onerror = () => {}; // leave null — renderer falls back to color square
  img.src = `/sprites/${spriteId}.png`;
  return null;
}

// Tile-variant image cache — keyed by "<tileId>_<variant>". Separate from
// spriteImages (entities) because tiles are served from a different static
// dir (client/public/tiles/, baked by sprites/sprite_baker.py --kind tile).
// "<tileId>_<variant>" sprite ids, interned per tile id. The render loop needs
// one of these for every visible tile every frame; building the string fresh
// each time is thousands of throwaway allocations per second.
// Reused across frames — see the render loop. Grows to the largest viewport
// seen and is never shrunk, so a resize doesn't reallocate every frame.
let tileBuf: string[] = [];

const variantSpriteIds = new Map<string, string[]>();
function variantSpriteId(tileId: string, variant: number): string {
  let ids = variantSpriteIds.get(tileId);
  if (!ids) { ids = []; variantSpriteIds.set(tileId, ids); }
  return ids[variant] ?? (ids[variant] = `${tileId}_${variant}`);
}

const tileImages = new Map<string, HTMLImageElement | null>();
function getTileImage(spriteId: string): HTMLImageElement | null {
  if (tileImages.has(spriteId)) return tileImages.get(spriteId)!;
  tileImages.set(spriteId, null); // mark as loading
  const img = new Image();
  img.onload = () => tileImages.set(spriteId, img);
  img.onerror = () => {}; // leave null — renderer falls back to the flat color
  img.src = `/tiles/${spriteId}.png`;
  return null;
}
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function fitCanvas(): void {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

// Offscreen canvas used to composite the night overlay with radial light cutouts.
const DARKNESS_SCALE = 2;
const darknessCanvas = document.createElement('canvas');
const darknessCtx = darknessCanvas.getContext('2d')!;
const hud           = document.getElementById('hud')!;
let lastHudText = '';
const hotbar        = document.getElementById('hotbar')!;
const hbAttack      = document.getElementById('hb-attack')!;
const hbAttackIcon  = document.getElementById('hb-attack-icon')!;
const hbAttackLabel = document.getElementById('hb-attack-label')!;
const hbAttackReach = document.getElementById('hb-attack-reach')!;
const hbAttackCd    = document.getElementById('hb-attack-cd')!;
const hbPotion      = document.getElementById('hb-potion')!;
const hbPotionLabel = document.getElementById('hb-potion-label')!;
const hbPotionCd    = document.getElementById('hb-potion-cd')!;
const targetFrame  = document.getElementById('target-frame')!;
const tfPortrait   = document.getElementById('tf-portrait')! as HTMLElement;
const tfLevel      = document.getElementById('tf-level')!;
const tfName       = document.getElementById('tf-name')!;
const tfHpFill     = document.getElementById('tf-hp-fill')! as HTMLElement;
const tfHpText     = document.getElementById('tf-hp-text')!;
const tfMpRow      = document.getElementById('tf-mp-row')! as HTMLElement;
const tfMpFill     = document.getElementById('tf-mp-fill')! as HTMLElement;
const tfMpText     = document.getElementById('tf-mp-text')!;
const playerFrame   = document.getElementById('player-frame')!;
const pfPortrait    = document.getElementById('pf-portrait')! as HTMLElement;
const pfLevel       = document.getElementById('pf-level')!;
const pfName        = document.getElementById('pf-name')!;
const pfHpFill      = document.getElementById('pf-hp-fill')! as HTMLElement;
const pfHpText      = document.getElementById('pf-hp-text')!;
const pfMpFill      = document.getElementById('pf-mp-fill')! as HTMLElement;
const pfMpText      = document.getElementById('pf-mp-text')!;
const pfXpFill      = document.getElementById('pf-xp-fill')! as HTMLElement;
const pfXpText      = document.getElementById('pf-xp-text')!;
const pfStatus      = document.getElementById('pf-status')!;
const tfStatus      = document.getElementById('tf-status')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatLog = document.getElementById('chat-log')!;
const sheetBackdrop = document.getElementById('charsheet-backdrop')!;
const csPortrait = document.getElementById('cs-portrait')!;
const csName = document.getElementById('cs-name')!;
const csClass = document.getElementById('cs-class')!;
const csLevel = document.getElementById('cs-level')!;
const csXp = document.getElementById('cs-xp')!;
const csHp = document.getElementById('cs-hp')!;
const csStr = document.getElementById('cs-str')!;
const csDex = document.getElementById('cs-dex')!;
const csInt = document.getElementById('cs-int')!;
const csCon = document.getElementById('cs-con')!;
const csDmg = document.getElementById('cs-dmg')!;
const csDef = document.getElementById('cs-def')!;
const csDodge = document.getElementById('cs-dodge')!;
const csMoveSpeed = document.getElementById('cs-movespeed')!;
const csAtkSpeed = document.getElementById('cs-atkspeed')!;
const csPoints = document.getElementById('cs-points')!;
const csAlloc = document.getElementById('cs-alloc')!;
for (const stat of ['strength', 'dexterity', 'intelligence', 'constitution'] as StatId[]) {
  document.getElementById(`alloc-${stat}`)!.addEventListener('click', () => state.sendAllocate?.(stat));
}


function stackTooltip(stack: InventoryStack): string {
  const eq = stack.item?.components?.equipment;
  const rolled = eq?.rolled as RolledStats | undefined;
  const rarity = eq?.rarity as string | undefined;
  const lines = [(rarity && rarity !== 'common' ? `[${rarity.charAt(0).toUpperCase() + rarity.slice(1)}] ` : '') + (stack.name || stack.base || 'Item')];
  if (stack.item_slot === 'consumable') {
    lines.push('Click to use');
    return lines.join('\n');
  }
  if (Array.isArray(rolled?.damage)) {
    lines.push(`Damage: ${rolled.damage[0]}–${rolled.damage[1]}`);
  }
  if (rolled?.scaling) {
    const scl = Object.entries(rolled.scaling)
      .filter(([, v]) => v && v !== '-')
      .map(([k, v]) => `${k.slice(0, 3).toUpperCase()} ${v}`)
      .join('  ');
    if (scl) lines.push(`Scaling: ${scl}`);
  }
  if (Array.isArray(rolled?.defense)) {
    lines.push(`Defense: ${rolled.defense[0]}–${rolled.defense[1]}`);
  }
  if (rolled) {
    const SKIP = new Set(['damage', 'defense', 'speed', 'scaling']);
    for (const [k, v] of Object.entries(rolled)) {
      if (SKIP.has(k) || v === null || v === undefined) continue;
      if (typeof v === 'number') {
        const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        lines.push(`${label}: +${v}`);
      }
    }
  }
  if (rolled?.speed != null) {
    lines.push(`Speed: ${rolled.speed.toFixed(2)}`);
  }
  return lines.join('\n');
}

const invBackdrop = document.getElementById('inv-backdrop')!;
const invSlots = document.getElementById('inv-slots')!;
const invEquip = document.getElementById('inv-equip')!;
const invGold = document.getElementById('inv-gold')!;
const invDetail = document.getElementById('inv-detail')!;

const lootBackdrop  = document.getElementById('loot-backdrop')!;
const lootTitle     = document.getElementById('loot-title')!;
const lootBody      = document.getElementById('loot-body')!;
const lootAllBtn    = document.getElementById('loot-all-btn') as HTMLButtonElement;
const lootCloseBtn  = document.getElementById('loot-close-btn')!;

const signBackdrop  = document.getElementById('sign-backdrop')!;
const signTitle     = document.getElementById('sign-title')!;
const signBody      = document.getElementById('sign-body')!;
const signCloseBtn  = document.getElementById('sign-close-btn')!;

const boardBackdrop   = document.getElementById('board-backdrop')!;
const boardTitle      = document.getElementById('board-title')!;
const boardTabRead    = document.getElementById('board-tab-read')!;
const boardTabPost    = document.getElementById('board-tab-post')!;
const boardReadView   = document.getElementById('board-read-view')!;
const boardPostView   = document.getElementById('board-post-view')!;
const boardMsgsEl     = document.getElementById('board-messages')!;
const boardTextarea   = document.getElementById('board-textarea') as HTMLTextAreaElement;
const boardCharCount  = document.getElementById('board-char-count')!;
const boardPostBtn    = document.getElementById('board-post-btn') as HTMLButtonElement;
const boardPostErr    = document.getElementById('board-post-err')!;
const boardCloseBtn   = document.getElementById('board-close-btn')!;

const tradeBackdrop  = document.getElementById('trade-backdrop')!;
const tradeTitle     = document.getElementById('trade-title')!;
const tradeTabBuy    = document.getElementById('trade-tab-buy')!;
const tradeTabSell   = document.getElementById('trade-tab-sell')!;
const tradeList      = document.getElementById('trade-list')!;
const tradeConfirm   = document.getElementById('trade-confirm')!;
const tradeGoldEl    = document.getElementById('trade-gold')!;
const tradeErr       = document.getElementById('trade-err')!;
const trainerBackdrop = document.getElementById('trainer-backdrop')!;
const trainerTitle    = document.getElementById('trainer-title')!;
const trainerList     = document.getElementById('trainer-list')!;
const trainerGoldEl   = document.getElementById('trainer-gold')!;
const trainerErr      = document.getElementById('trainer-err')!;
const skillsBackdrop  = document.getElementById('skills-backdrop')!;
const skillsList      = document.getElementById('skills-list')!;

const EQ_LAYOUT: (EquipSlot | null)[][] = [
  [null,       'helmet',    'amulet'  ],
  ['mainhand', 'chest',     'gloves'  ],
  ['ring1',    'leggings',  'ring2'   ],
  [null,       'boots',     null      ],
];

function invOpen(): boolean { return invBackdrop.classList.contains('open'); }

// Overlays are fetched lazily, so art can land after a panel has already drawn
// its text fallback. The inventory's signature check would hold that fallback
// until something else changed, so force the panels that derive art to repaint.
whenLayerLoads(() => {
  if (invOpen()) renderInventory(true);
  if (sheetBackdrop.classList.contains('open')) renderCharSheet();
  // Force the attack slot to rebuild: its key hasn't changed, but the art it
  // would have drawn now exists.
  attackSlotKey = '';
});

// Which item the inventory panel is showing. Left-clicking a cell only ever
// SELECTS it; every verb (equip, unequip, use, drop) is a button in the detail
// panel. That keeps the action buttons on DOM nodes that only change when the
// selection does, rather than on grid cells that the render rebuilds.
type InvSelection =
  | { kind: 'bag'; slot: number }
  | { kind: 'equip'; slot: EquipSlot };
let invSelection: InvSelection | null = null;

/** The stack the current selection points at, or null if it's gone (equipped
 *  away, dropped, sold) — selections are positions, and positions empty out. */
function selectedStack(): InventoryStack | null {
  const s = state.self;
  if (!s || !invSelection) return null;
  return invSelection.kind === 'bag'
    ? (s.components?.inventory?.slots?.[invSelection.slot] ?? null)
    : (s.components?.equipment?.[invSelection.slot] ?? null);
}

function selectInv(sel: InvSelection | null): void {
  invSelection = sel;
  renderInventory(true);
}

function renderCharSummary(): void {
  const s = state.self;
  if (!s) { invDetail.innerHTML = '<div class="idd-empty">—</div>'; return; }
  const prog = s.components?.progress || { level: 1, xp: 0, unspent_points: 0 };
  const stats = s.components?.stats || {};
  const hp = s.components?.health || { current: 0, max: 0 };
  const dmg = effectiveDamageRange(s);
  const def = totalDefense(s);
  const dex = stats.dexterity || 0;
  const dodgePct = Math.min(30, dex);
  const xpNext = xpForNext(prog.level);
  const xpPct = xpNext > 0 ? Math.round((prog.xp / xpNext) * 100) : 0;
  const hpPct = hp.max > 0 ? Math.round((hp.current / hp.max) * 100) : 0;

  const row = (lbl: string, val: string | number) =>
    `<div class="idd-row"><span class="lbl">${lbl}</span><span class="val">${val}</span></div>`;

  let html = `<div class="idd-name">${s.name || 'Player'}</div>`;
  html += `<div class="idd-slot">${classDisplay(s.klass)} · Lv ${prog.level}</div>`;
  html += '<hr class="idd-divider">';
  html += row('HP', `${hp.current} / ${hp.max} <span style="opacity:0.45;font-size:10px">(${hpPct}%)</span>`);
  html += row('XP', `${prog.xp} / ${xpNext} <span style="opacity:0.45;font-size:10px">(${xpPct}%)</span>`);
  html += '<hr class="idd-divider">';
  html += row('Strength', stats.strength ?? 0);
  html += row('Dexterity', stats.dexterity ?? 0);
  html += row('Intelligence', stats.intelligence ?? 0);
  html += row('Constitution', stats.constitution ?? 0);
  html += '<hr class="idd-divider">';
  html += row('Damage', `${dmg[0]}–${dmg[1]}`);
  html += row('Defense', def);
  html += row('Dodge', `${dodgePct}%`);
  if ((prog.unspent_points || 0) > 0) {
    html += `<div style="color:#ffd84a;font-size:11px;margin-top:8px">▲ ${prog.unspent_points} unspent point${prog.unspent_points !== 1 ? 's' : ''} — press C</div>`;
  }
  invDetail.innerHTML = html;
}

function renderItemDetail(stack: InventoryStack | null): void {
  if (!stack) { renderCharSummary(); return; }
  const eq = stack.item?.components?.equipment;
  const rolled = eq?.rolled as RolledStats | undefined;
  const rarity = (eq?.rarity as string | undefined) ?? 'common';
  const slot = stack.item_slot ?? '';
  const color = rarityColor(rarity);

  let html = '';
  // Placeholder the icon slot in the markup, then fill it after — the rest of
  // this panel is built as an HTML string and a canvas can't go in one.
  if (getItemIcon(stack)) html += '<div class="idd-icon"></div>';
  html += `<div class="idd-name" style="color:${color}">${stack.name || stack.base || 'Item'}</div>`;
  if (rarity !== 'common') {
    html += `<div class="idd-rarity" style="color:${color}">${rarity}</div>`;
  }
  if (slot && slot !== 'quest' && slot !== 'currency' && slot !== 'consumable') {
    html += `<div class="idd-slot">${slot}</div>`;
  }

  const hasStats = rolled && (
    Array.isArray(rolled.damage) || Array.isArray(rolled.defense) ||
    rolled.speed != null || rolled.scaling
  );
  if (hasStats) {
    html += '<hr class="idd-divider">';
    if (Array.isArray(rolled!.damage)) {
      html += `<div class="idd-row"><span class="lbl">Damage</span><span class="val">${rolled!.damage[0]}–${rolled!.damage[1]}</span></div>`;
    }
    if (Array.isArray(rolled!.defense)) {
      html += `<div class="idd-row"><span class="lbl">Defense</span><span class="val">${rolled!.defense[0]}–${rolled!.defense[1]}</span></div>`;
    }
    if (rolled!.speed != null) {
      html += `<div class="idd-row"><span class="lbl">Speed</span><span class="val">${(rolled!.speed as number).toFixed(2)}</span></div>`;
    }
    if (rolled!.scaling) {
      const scalingEntries = Object.entries(rolled!.scaling as Record<string, string>)
        .filter(([, v]) => v && v !== '-')
        .map(([k, v]) => `${k.slice(0, 3).toUpperCase()} ${v}`)
        .join('  ');
      if (scalingEntries) {
        html += `<div class="idd-row"><span class="lbl">Scaling</span><span class="val">${scalingEntries}</span></div>`;
      }
    }
    const SKIP = new Set(['damage', 'defense', 'speed', 'scaling']);
    for (const [k, v] of Object.entries(rolled!)) {
      if (SKIP.has(k) || v === null || v === undefined) continue;
      if (typeof v === 'number') {
        const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        html += `<div class="idd-row"><span class="lbl">${label}</span><span class="val bonus">+${v}</span></div>`;
      }
    }
  }

  // Projected character stat impact if equipped
  const s = state.self;
  if (s) {
    const eqSlot = (slot) as import('../../shared/types.ts').EquipSlot;
    const curDmg = effectiveDamageRange(s);
    const curDef = totalDefense(s);
    let newDmg: Range | null = null;
    let newDef: number | null = null;

    if (slot === 'mainhand' && Array.isArray(rolled?.damage)) {
      const stats = s.components?.stats || {};
      const base = rolled!.damage as Range;
      let bonus = 0;
      if (rolled!.scaling) {
        for (const [stat, letter] of Object.entries(rolled!.scaling as Record<string, string>)) {
          const c = SCALING_COEFFS[letter];
          if (c) bonus += ((stats as Record<string, unknown>)[stat] as number || 0) * c;
        }
      }
      const b = Math.round(bonus);
      newDmg = [base[0] + b, base[1] + b];
    }

    if ((ARMOR_SLOTS as readonly string[]).includes(slot) && Array.isArray(rolled?.defense)) {
      const curSlotDef = s.components?.equipment?.[eqSlot]?.item?.components?.equipment?.rolled?.defense;
      const curAvg = Array.isArray(curSlotDef) ? Math.round((curSlotDef[0] + curSlotDef[1]) / 2) : 0;
      const newAvg = Math.round((rolled!.defense[0] + rolled!.defense[1]) / 2);
      newDef = curDef - curAvg + newAvg;
    }

    const dmgChanged = newDmg && (newDmg[0] !== curDmg[0] || newDmg[1] !== curDmg[1]);
    const defChanged = newDef !== null && newDef !== curDef;

    if (dmgChanged || defChanged) {
      html += '<hr class="idd-divider">';
      html += '<div class="idd-compare-lbl">If Equipped</div>';
      if (dmgChanged) {
        const diff = (newDmg![0] + newDmg![1]) - (curDmg[0] + curDmg[1]);
        const cls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
        const sign = diff > 0 ? '+' : '';
        html += `<div class="idd-row"><span class="lbl">Damage</span><span class="val ${cls}">${curDmg[0]}–${curDmg[1]} → ${newDmg![0]}–${newDmg![1]} <span style="opacity:0.6;font-size:10px">(${sign}${diff})</span></span></div>`;
      }
      if (defChanged) {
        const diff = newDef! - curDef;
        const cls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
        const sign = diff > 0 ? '+' : '';
        html += `<div class="idd-row"><span class="lbl">Defense</span><span class="val ${cls}">${curDef} → ${newDef} <span style="opacity:0.6;font-size:10px">(${sign}${diff})</span></span></div>`;
      }
    }
  }

  if (stack.sell_value != null || slot !== 'quest') {
    const price = Math.max(1, stack.sell_value ?? 0);
    if (slot !== 'quest' && slot !== 'currency') {
      html += `<div class="idd-sell">Sell value: ${price}g</div>`;
    }
  }

  invDetail.innerHTML = html;
  const iconBox = invDetail.querySelector('.idd-icon');
  if (iconBox) iconBox.appendChild(itemIconEl(stack, 112)!);
  appendItemActions(stack);
}

// Every verb available on the selected item. Built as real elements with
// listeners rather than markup, and rebuilt only when the selection changes —
// so a button can't be swapped out from under a click the way the grid cells
// used to be.
function appendItemActions(stack: InventoryStack): void {
  if (!invSelection) return;
  const sel = invSelection;
  const row = document.createElement('div');
  row.className = 'idd-actions';

  const act = (label: string, cls: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.className = 'idd-btn' + (cls ? ` ${cls}` : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    row.appendChild(b);
  };

  if (sel.kind === 'equip') {
    act('Unequip', '', () => {
      state.sendUnequip?.(sel.slot);
      // The item lands in the bag; which slot is the server's call, so drop the
      // selection rather than guess at one and pin the panel to the wrong item.
      selectInv(null);
    });
  } else if (stack.item_slot === 'consumable') {
    act('Use', '', () => {
      void (async () => {
        const r = await state.sendUseItem(sel.slot);
        if (r.ok && r.healed && r.healed > 0) {
          state.pickupFloats.push({ kind: 'item', name: `+${r.healed} HP`, t: performance.now() });
        }
        if (r.ok && r.restored && r.restored > 0) {
          state.pickupFloats.push({ kind: 'item', name: `+${r.restored} MP`, t: performance.now() });
        }
        // A scroll that finds nothing to do is refused rather than spent, so
        // say why — otherwise the click reads as a dud item.
        if (!r.ok && r.reason === 'nothing_to_reveal') {
          state.pickupFloats.push({ kind: 'item', name: 'Nothing left to chart', t: performance.now() });
        }
        // A stack that's been consumed away leaves the slot empty; renderInventory
        // clears a selection that no longer points at anything.
        renderInventory();
      })();
    });
  } else if (stack.item_slot && stack.item_slot !== 'quest' && stack.item_slot !== 'currency') {
    act('Equip', '', () => {
      state.sendEquip?.(sel.slot);
      selectInv(null);
    });
  }

  if (sel.kind === 'bag') {
    act('Drop', 'danger', () => {
      state.sendDropItem?.(sel.slot);
      state.pickupFloats.push({ kind: 'item', name: `Dropped ${stack.name || stack.base}`, t: performance.now() });
      selectInv(null);
    });
  }

  if (row.children.length > 0) invDetail.appendChild(row);
  const hint = document.createElement('div');
  hint.className = 'idd-hint';
  hint.textContent = 'Click the item again to deselect';
  invDetail.appendChild(hint);
}

// What the inventory grids actually draw. The panel re-renders on every `self`
// and every zone snapshot — which in a populated zone is every 100ms tick —
// and rebuilding identical DOM that often is what made equipping unreliable: a
// `click` only fires when mousedown and mouseup land on the SAME element, and
// the cell under the cursor was usually replaced in between. Skipping the
// rebuild when nothing the grids show has changed keeps the cells alive.
function inventorySignature(s: PlayerEntity): string {
  const key = (st: InventoryStack | null | undefined) =>
    st ? `${st.base}|${st.name}|${st.item?.id ?? ''}|${st.item_slot ?? ''}` : '';
  const bag = (s.components?.inventory?.slots ?? []).map(key).join(',');
  const worn = EQUIPMENT_SLOTS.map((sl) => key(s.components?.equipment?.[sl])).join(',');
  const sel = invSelection ? `${invSelection.kind}:${invSelection.slot}` : '';
  return `${s.components?.wallet?.gold ?? 0}~${bag}~${worn}~${sel}`;
}
let lastInventorySignature = '';

function renderInventory(force = false): void {
  const s = state.self;
  if (!s) return;

  // A selection is a position, and the item in it can leave (equipped away,
  // dropped, consumed, sold). Drop the selection before it can point at nothing.
  if (invSelection && !selectedStack()) invSelection = null;

  const signature = inventorySignature(s);
  if (!force && signature === lastInventorySignature) return;
  lastInventorySignature = signature;

  const inv = s.components?.inventory?.slots || [];
  const equipment = s.components?.equipment;
  const gold = s.components?.wallet?.gold || 0;
  invGold.textContent = String(gold);

  // Selection is the only thing that drives the detail panel. It used to follow
  // the mouse, which would have been actively dangerous here: moving toward an
  // action button over another item would swap the panel — and the buttons —
  // out from under the click.
  const selected = selectedStack();
  if (selected) renderItemDetail(selected);
  else renderCharSummary();

  invEquip.innerHTML = '';
  for (const row of EQ_LAYOUT) {
    for (const slot of row) {
      const cell = document.createElement('div');
      if (!slot) {
        cell.style.visibility = 'hidden';
        cell.className = 'eq-cell';
        invEquip.appendChild(cell);
        continue;
      }
      const eq = equipment?.[slot];
      const isSelected = invSelection?.kind === 'equip' && invSelection.slot === slot;
      cell.className = 'eq-cell' + (eq ? ' filled' : '') + (isSelected ? ' selected' : '');
      // An icon says what the item IS at a glance; the name is the fallback for
      // everything still without art, so only one of the two is ever shown.
      const icon = eq ? itemIconEl(eq, 32) : null;
      if (icon) cell.appendChild(icon);
      else {
        const label = document.createElement('div');
        label.className = 'eq-item-name';
        label.textContent = eq ? (eq.name || eq.base || '?') : '—';
        if (eq?.item?.components?.equipment?.rarity) {
          label.style.color = rarityColor(eq.item.components.equipment.rarity as string);
        }
        cell.appendChild(label);
      }
      const sub = document.createElement('div');
      sub.className = 'eq-slot-name';
      sub.textContent = slot;
      cell.appendChild(sub);
      if (eq) {
        cell.title = stackTooltip(eq);
        // pointerdown, not click: it fires on press, so it can't be lost to a
        // re-render landing between the press and the release. Primary button
        // only — see the bag cells below for why that guard matters.
        cell.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          selectInv(isSelected ? null : { kind: 'equip', slot });
        });
      }
      invEquip.appendChild(cell);
    }
  }

  invSlots.innerHTML = '';
  for (let i = 0; i < inv.length; i++) {
    const cell = document.createElement('div');
    const stack = inv[i];
    const rarity = stack?.item?.components?.equipment?.rarity as string | undefined;
    const isSelected = invSelection?.kind === 'bag' && invSelection.slot === i;
    cell.className = 'slot' + (stack ? ' filled' : ' empty') + (rarity ? ` rarity-${rarity}` : '') +
      (isSelected ? ' selected' : '');
    const icon = stack ? itemIconEl(stack, 34) : null;
    if (icon) cell.appendChild(icon);
    else {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'slot-item-name';
      nameSpan.textContent = stack ? (stack.name || stack.base || '?') : '·';
      cell.appendChild(nameSpan);
    }
    if (stack && rarity) cell.style.color = rarityColor(rarity);
    cell.dataset.slot = String(i);
    if (stack) {
      cell.title = stackTooltip(stack) + '\n(right-click to drop)';
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        state.sendDropItem?.(i);
        state.pickupFloats.push({ kind: 'item', name: `Dropped ${stack.name || stack.base}`, t: performance.now() });
        selectInv(null);
      });
      // Primary button only. Selecting re-renders, which replaces this very
      // element — so reacting to a right-click here would destroy the node
      // before its `contextmenu` handler above could fire, silently breaking
      // right-click-to-drop.
      cell.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        selectInv(isSelected ? null : { kind: 'bag', slot: i });
      });
    }
    invSlots.appendChild(cell);
  }
}

function openInventory(): void {
  invBackdrop.classList.add('open');
  invSelection = null;
  renderInventory(true);
}
function closeInventory(): void {
  invBackdrop.classList.remove('open');
  invSelection = null;
}
window.addEventListener('mmo:self', () => {
  if (!invOpen()) return;
  renderInventory();
  // The grids are signature-guarded, but the character summary tracks HP/XP and
  // stats the signature deliberately ignores, so refresh it here. Only when
  // nothing is selected: with a selection the panel belongs to the item, and
  // redrawing it every tick would destroy its action buttons mid-click — the
  // same failure this change exists to fix.
  if (!invSelection) renderCharSummary();
});
window.addEventListener('mmo:zone', () => { if (invOpen()) renderInventory(); });

// ─── Trade modal ────────────────────────────────────────────────────────────

const BACKEND_URL = import.meta.env.VITE_SERVER_URL ?? '';

interface ShopItem {
  item: string;
  price: number;
  name: string;
  sprite: string;
  slot?: string;
  base_damage?: Range;
  base_defense?: Range;
  base_speed?: number;
  scaling?: Partial<Record<StatId, string>>;
}
let activeTradeMob: EntitySnapshot | null = null;
let tradeTab: 'buy' | 'sell' = 'buy';
let shopItems: ShopItem[] = [];
// The merchant's rotating high-end shelf, and the epoch ms it re-rolls at.
// Server-derived from the wall clock, so the countdown is the real one and
// every player's agrees.
let featuredItems: FeaturedStockEntry[] = [];
let featuredRefreshAt = 0;
let featuredTimer: ReturnType<typeof setInterval> | null = null;
let pendingSell: { slotIndex: number; stack: InventoryStack } | null = null;

const TRADE_ERR_MSG: Record<string, string> = {
  insufficient_gold: 'Not enough gold.',
  inventory_full: 'Inventory full.',
  out_of_range: 'Too far away.',
  cannot_sell: 'Cannot sell quest or currency items.',
  sold_out: 'Someone beat you to it — that one is gone.',
};

/** Whether this merchant has a rotating shelf at all — the server sends
 *  `refreshAt` only for merchants that do, so an empty `featuredItems` means
 *  sold out rather than absent. */
function hasFeaturedShelf(): boolean { return featuredRefreshAt !== 0; }

/** "42m 08s" / "1h 05m" — the wait until the shelf re-rolls. */
function countdownText(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

// ─── Loot panel ──────────────────────────────────────────────────────────────

let openCorpseId: string | null = null;

function lootOpen(): boolean { return lootBackdrop.classList.contains('open'); }
function closeLoot(): void { lootBackdrop.classList.remove('open'); openCorpseId = null; }

function renderLootBody(loot: LootSlot[]): void {
  lootBody.innerHTML = '';
  if (loot.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.45;font-size:12px;padding:8px 0';
    empty.textContent = 'Nothing left.';
    lootBody.appendChild(empty);
    lootAllBtn.disabled = true;
    return;
  }
  lootAllBtn.disabled = false;
  for (const slot of loot) {
    const row = document.createElement('div');
    row.className = 'loot-row';
    // Loot slots carry the same base/item shape a bag stack does, which is all
    // the icon needs — no extra wire field for the corpse window.
    const lootIcon = slot.gold > 0 ? null : itemIconEl(slot, 20);
    if (lootIcon) row.appendChild(lootIcon);
    const nameEl = document.createElement('span');
    nameEl.className = 'loot-item-name';
    nameEl.textContent = slot.gold > 0 ? `${slot.gold} Gold` : slot.name;
    if (slot.gold > 0) nameEl.style.color = '#ffd84a';
    else if (slot.item?.components?.equipment?.rarity)
      nameEl.style.color = rarityColor(slot.item.components.equipment.rarity as string);
    const btn = document.createElement('button');
    btn.textContent = 'Take';
    btn.addEventListener('click', async () => {
      if (!openCorpseId) return;
      const r = await state.sendLootCorpse(openCorpseId, slot.id);
      if (r.ok && r.self) state.self = r.self;
    });
    row.appendChild(nameEl);
    row.appendChild(btn);
    lootBody.appendChild(row);
  }
}

function openLoot(snap: EntitySnapshot): void {
  openCorpseId = snap.id;
  lootTitle.textContent = snap.name;
  renderLootBody(snap.loot ?? []);
  lootBackdrop.classList.add('open');
}

lootAllBtn.addEventListener('click', async () => {
  if (!openCorpseId) return;
  const r = await state.sendLootCorpse(openCorpseId, 'all');
  if (r.ok && r.self) state.self = r.self;
});
lootCloseBtn.addEventListener('click', closeLoot);

function signOpen(): boolean { return signBackdrop.classList.contains('open'); }
function closeSign(): void { signBackdrop.classList.remove('open'); }
function openSign(snap: EntitySnapshot): void {
  signTitle.textContent = snap.name;
  signBody.textContent = (snap.signText ?? []).join('\n');
  signBackdrop.classList.add('open');
}
signCloseBtn.addEventListener('click', closeSign);

// ─── Message board modal ──────────────────────────────────────────────────────

import type { BoardMessage } from './state.ts';

let activeBoardId: string | null = null;

const BOARD_POST_ERR: Record<string, string> = {
  out_of_range: 'Move closer to post.',
  rate_limited: 'Wait a moment before posting again.',
  too_long: 'Message too long (max 200 characters).',
  empty: 'Message cannot be empty.',
};

function boardOpen(): boolean { return boardBackdrop.classList.contains('open'); }
function closeBoard(): void {
  boardBackdrop.classList.remove('open');
  activeBoardId = null;
  boardPostErr.textContent = '';
  boardTextarea.value = '';
  boardCharCount.textContent = '0 / 200';
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Format the world time-of-day (0=midnight, 0.5=noon) as a 24h clock. */
function formatWorldTime(timeOfDay: number | undefined): string {
  const t = ((timeOfDay ?? 0.5) % 1 + 1) % 1;
  const totalMin = Math.floor(t * 24 * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function renderBoardMessages(messages: BoardMessage[]): void {
  boardMsgsEl.innerHTML = '';
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.45;font-size:12px;padding:8px 0';
    empty.textContent = 'No messages yet. Be the first to post!';
    boardMsgsEl.appendChild(empty);
    return;
  }
  for (const msg of messages) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 0;border-bottom:1px solid #333';
    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px;opacity:0.55;margin-bottom:3px';
    header.textContent = `${msg.authorName} · ${timeAgo(msg.postedAt)}`;
    const body = document.createElement('div');
    body.style.cssText = 'font-size:13px;color:#ddd;word-break:break-word';
    body.textContent = msg.text;
    row.appendChild(header);
    row.appendChild(body);
    boardMsgsEl.appendChild(row);
  }
}

function switchBoardTab(tab: 'read' | 'post'): void {
  boardTabRead.classList.toggle('active', tab === 'read');
  boardTabPost.classList.toggle('active', tab === 'post');
  boardReadView.style.display = tab === 'read' ? '' : 'none';
  boardPostView.style.display = tab === 'post' ? '' : 'none';
  boardPostErr.textContent = '';
}

async function openBoard(snap: EntitySnapshot): Promise<void> {
  if (!snap.boardId) return;
  activeBoardId = snap.boardId;
  boardTitle.textContent = snap.name;
  boardMsgsEl.innerHTML = '<div style="opacity:0.45;font-size:12px;padding:8px 0">Loading…</div>';
  switchBoardTab('read');
  boardBackdrop.classList.add('open');
  const r = await state.sendReadBoard(snap.boardId);
  if (r.ok && r.messages) renderBoardMessages(r.messages);
}

boardTabRead.addEventListener('click', () => switchBoardTab('read'));
boardTabPost.addEventListener('click', () => switchBoardTab('post'));

boardTextarea.addEventListener('input', () => {
  boardCharCount.textContent = `${boardTextarea.value.length} / 200`;
});

boardPostBtn.addEventListener('click', async () => {
  if (!activeBoardId) return;
  const text = boardTextarea.value.trim();
  if (!text) { boardPostErr.textContent = 'Message cannot be empty.'; return; }
  boardPostBtn.disabled = true;
  boardPostErr.textContent = '';
  const r = await state.sendPostToBoard(activeBoardId, text);
  boardPostBtn.disabled = false;
  if (!r.ok) {
    boardPostErr.textContent = BOARD_POST_ERR[r.reason ?? ''] || r.reason || 'Post failed.';
    return;
  }
  boardTextarea.value = '';
  boardCharCount.textContent = '0 / 200';
  switchBoardTab('read');
  // Refresh messages
  const r2 = await state.sendReadBoard(activeBoardId);
  if (r2.ok && r2.messages) renderBoardMessages(r2.messages);
});

boardCloseBtn.addEventListener('click', closeBoard);

window.addEventListener('mmo:zone', () => {
  if (!lootOpen() || !openCorpseId) return;
  const entities = isWild() ? wildEntities() : state.zone?.entities;
  const corpse = entities?.find((e) => e.id === openCorpseId);
  if (!corpse || corpse.type !== 'corpse') { closeLoot(); return; }
  renderLootBody(corpse.loot ?? []);
  if ((corpse.loot?.length ?? 0) === 0) closeLoot();
});

// ─── World map modal ──────────────────────────────────────────────────────────

const BIOME_COLORS: Record<string, string> = {
  ocean:     '#1a4a7a',
  tundra:    '#b0c4d8',
  plains:    '#c8b560',
  grassland: '#4a8c3f',
  forest:    '#1f5c2e',
  swamp:     '#4a6741',
  desert:    '#c9a84c',
  mountain:  '#7a7a8c',
};
const MAP_SETTLEMENT_STYLE: Record<string, { fill: string; stroke: string }> = {
  city:    { fill: '#f5c842', stroke: '#8a6f00' },
  village: { fill: '#ffffff', stroke: '#555555' },
};

const mapBackdrop   = document.getElementById('map-backdrop')!;
const mapCanvas     = document.getElementById('map-canvas') as HTMLCanvasElement;
const mapCanvasWrap = document.getElementById('map-canvas-wrap')!;
const mapStatus     = document.getElementById('map-status')!;
const mapCellInfo   = document.getElementById('map-cell-info')!;
const mapTooltip    = document.getElementById('map-tooltip')!;
const mapCloseBtn   = document.getElementById('map-close-btn')!;
const mapZoomInBtn  = document.getElementById('map-zoom-in')!;
const mapZoomOutBtn = document.getElementById('map-zoom-out')!;
const mapZoomResetBtn = document.getElementById('map-zoom-reset')!;
const mapZoomLabel  = document.getElementById('map-zoom-label')!;
const mapZoomControls = document.getElementById('map-zoom-controls')!;

interface WorldMapCell { worldBiome: string; zoneName: string; zoneId: string }
interface WorldMapSettlement { type: string; gridX: number; gridY: number; name: string }
interface WorldMapData { cols: number; rows: number; originX: number; originY: number; cells: (WorldMapCell | null)[][]; settlements: WorldMapSettlement[] }

let mapData: WorldMapData | null = null;
let mapFitPx = 8;   // auto-fit cell size at 100% zoom
let mapZoom = 1;    // zoom multiplier
let mapCellPx = 8;  // = mapFitPx * mapZoom
let mapSelected: { row: number; col: number } | null = null;

const MAP_ZOOM_MIN = 0.5;
const MAP_ZOOM_MAX = 8;
const MAP_ZOOM_STEP = 1.25;

function mapOpen(): boolean { return mapBackdrop.classList.contains('open'); }
function closeMap(): void { mapBackdrop.classList.remove('open'); cancelMapRender(); }

// The panel refreshers hang off 'mmo:zone', and out in the wilderness that is
// one event per streamed chunk per tick (WildernessManager.broadcast) — a full
// redraw each time re-samples the field thousands of times and strobes the
// canvas. Coalesce to at most one redraw per MAP_REFRESH_MS.
const MAP_REFRESH_MS = 250;
let mapRenderTimer: number | null = null;
let mapRenderedAt = 0;

function cancelMapRender(): void {
  if (mapRenderTimer !== null) { clearTimeout(mapRenderTimer); mapRenderTimer = null; }
}

function scheduleMapRender(): void {
  if (!mapOpen() || mapRenderTimer !== null) return;
  const wait = Math.max(0, MAP_REFRESH_MS - (performance.now() - mapRenderedAt));
  mapRenderTimer = window.setTimeout(() => {
    mapRenderTimer = null;
    mapRenderedAt = performance.now();
    if (!mapOpen()) return;
    if (isWild()) renderWildernessMap(); else renderMap();
  }, wait);
}

function renderMap(): void {
  if (!mapData) return;
  const ctx = mapCanvas.getContext('2d')!;
  const px = mapCellPx;
  mapCanvas.width  = mapData.cols * px;
  mapCanvas.height = mapData.rows * px;

  for (let row = 0; row < mapData.rows; row++) {
    for (let col = 0; col < mapData.cols; col++) {
      const cell = mapData.cells[row]?.[col];
      if (!cell) {
        ctx.fillStyle = BIOME_COLORS['ocean']!;
      } else {
        ctx.fillStyle = BIOME_COLORS[cell.worldBiome] ?? '#333';
      }
      ctx.fillRect(col * px, row * px, px, px);
    }
  }

  // Settlement overlays
  for (const s of mapData.settlements) {
    const style = MAP_SETTLEMENT_STYLE[s.type] ?? MAP_SETTLEMENT_STYLE['village']!;
    const x = s.gridX * px;
    const y = s.gridY * px;
    ctx.fillStyle = style.fill + '99';
    ctx.fillRect(x, y, px, px);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = Math.max(1, px * 0.1);
    ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, px - ctx.lineWidth, px - ctx.lineWidth);
    ctx.fillStyle = style.stroke;
    ctx.beginPath();
    ctx.arc(x + px / 2, y + px / 2, Math.max(1, px * 0.18), 0, Math.PI * 2);
    ctx.fill();
  }

  // Player position marker
  const zoneId = state.zone?.id ?? '';
  const zm = /^(?:zone|city|village)_(-?\d+)_(-?\d+)$/.exec(zoneId);
  if (zm) {
    const gx = parseInt(zm[1]!, 10) - mapData.originX;
    const gy = parseInt(zm[2]!, 10) - mapData.originY;
    const cx = gx * px + px / 2;
    const cy = gy * px + px / 2;
    const r = Math.max(3, px * 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(1, px * 0.1), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  // Selected cell highlight
  if (mapSelected && mapSelected.row < mapData.rows && mapSelected.col < mapData.cols) {
    const lw = Math.max(2, px * 0.18);
    const x = mapSelected.col * px;
    const y = mapSelected.row * px;
    ctx.strokeStyle = '#7acdf5';
    ctx.lineWidth = lw;
    ctx.strokeRect(x + lw / 2, y + lw / 2, px - lw, px - lw);
  }
}

// World map for the wilderness. The client holds the atlas AND the same field
// module the server generates from, so it can draw the whole world coarsely
// without the player having visited any of it — there is no fog layer, and
// deliberately so: the wilds re-roll on the epoch clock (shared/worldgen/
// epoch.ts), so a per-chunk "explored" reveal would be wiped every rotation and
// could never mean anything. What persists instead is DISCOVERY: a named
// dungeon found once is marked forever, at whatever position this epoch put it.
const MAP_MIN_RADIUS = 500;      // world tiles — always show at least this much
const MAP_MAX_SAMPLES = 150;     // grid cells per axis; sets the sampling step
const MAP_RING_STEP = 10;        // draw a danger ring every N levels

function renderWildernessMap(): void {
  const ctx = mapCanvas.getContext('2d')!;
  const atlas = getWildAtlas();
  const seeds = getWildSeeds();
  const colors = state._tileColors ?? {};
  const me = state.self;
  const known = discoveredSites();
  const charted = revealedSites();

  if (!atlas || !seeds) { mapStatus.textContent = 'Loading…'; return; }

  // The window grows to hold everything worth showing: the player, every
  // settlement gate, and every discovered or charted site (a site that is
  // neither must not widen the view — that would leak its position).
  let radius = MAP_MIN_RADIUS;
  const reach = (x: number, y: number) => { radius = Math.max(radius, Math.hypot(x, y) * 1.15); };
  for (const st of atlas.settlements) reach(st.portalX, st.portalY);
  for (const site of atlas.sites) {
    if (known.has(site.id) || charted.has(site.id)) reach(site.worldX, site.worldY);
  }
  if (me) reach(me.position.x, me.position.y);
  radius = Math.round(radius);

  const span = radius * 2;
  const step = Math.max(CHUNK_SIZE / 2, Math.ceil(span / MAP_MAX_SAMPLES));
  const cells = Math.ceil(span / step);

  const wrapW = mapCanvasWrap.clientWidth || 800;
  const wrapH = mapCanvasWrap.clientHeight || 600;
  const px = Math.max(2, Math.floor(Math.min(wrapW, wrapH) / cells));
  mapCanvas.width = cells * px;
  mapCanvas.height = cells * px;

  // World tile -> canvas pixel. The window is square and origin-centered, so
  // the village always sits dead center whatever the epoch did to the terrain.
  const toPx = (wx: number, wy: number) => ({
    x: ((wx + radius) / step) * px,
    y: ((wy + radius) / step) * px,
  });

  // Terrain, sampled straight from the field rather than through wildTile's
  // per-chunk cache — a coarse sweep of the whole world would otherwise
  // materialize thousands of 32x32 chunk arrays for one modal.
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const wx = -radius + col * step;
      const wy = -radius + row * step;
      ctx.fillStyle = colors[wildTileAt(wx, wy, seeds, atlas)] ?? '#333';
      ctx.fillRect(col * px, row * px, px, px);
    }
  }

  // Danger rings. Danger is radial and seed-independent, so these are the one
  // part of the map that means the same thing in every epoch — they are the
  // reason a rotating world stays navigable.
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '10px monospace';
  ctx.lineWidth = 1;
  const center = toPx(0, 0);
  for (let level = MAP_RING_STEP; level <= 100; level += MAP_RING_STEP) {
    const r = (level / 100) * atlas.dangerRadius;
    if (r > radius) break;
    const rPx = (r / step) * px;
    ctx.beginPath();
    ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`L${level}`, center.x + 3, center.y - rPx - 3);
  }
  ctx.restore();

  // Discovered dungeons: solid diamond + name. Sites merely CHARTED by a
  // scribe's scroll get a hollow diamond and a parenthesised name — the marker
  // reads as second-hand, and it is gone at the next rotation. A site that is
  // neither is simply absent: the map never hints at a place the character has
  // no claim on.
  ctx.save();
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  for (const site of atlas.sites) {
    const found = known.has(site.id);
    if (!found && !charted.has(site.id)) continue;
    const { x, y } = toPx(site.worldX, site.worldY);
    const r = Math.max(4, px * 0.6);
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath();
    if (found) {
      ctx.fillStyle = '#e0b155';
      ctx.fill();
      ctx.strokeStyle = '#2b1d08';
    } else {
      ctx.strokeStyle = '#e0b155';
    }
    ctx.stroke();
    const label = found ? site.name : `(${site.name})`;
    ctx.fillStyle = found ? '#e0b155' : '#bda87d';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, x, y - r - 4);
    ctx.fillText(label, x, y - r - 4);
    ctx.lineWidth = 1;
  }
  ctx.restore();

  // Settlement gates (green dots).
  for (const st of atlas.settlements) {
    const { x, y } = toPx(st.portalX, st.portalY);
    ctx.fillStyle = '#5acc7a';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, px * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  // Player marker.
  if (me) {
    const { x, y } = toPx(me.position.x, me.position.y);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, px * 0.5), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.stroke();
  }

  const found = atlas.sites.filter(st => known.has(st.id)).length;
  const chartedCount = atlas.sites.filter(st => !known.has(st.id) && charted.has(st.id)).length;
  mapStatus.textContent =
    `The Wilds · epoch ${atlas.epoch} · ${found}/${atlas.sites.length} sites discovered`
    + (chartedCount ? ` · ${chartedCount} charted` : '');
}

// Fetches the world map once and caches it; shared by the map modal and the
// minimap compass. Refreshes the compass hints once data arrives.
async function ensureMapData(): Promise<void> {
  if (mapData) return;
  const r = await fetch(`${BACKEND_URL}/api/world-map`);
  mapData = await r.json() as WorldMapData;
  updateMinimapCompass();
}

async function openMap(): Promise<void> {
  mapBackdrop.classList.add('open');
  mapStatus.textContent = 'Loading…';
  mapRenderedAt = performance.now();
  // In the wilderness the map is a fog-of-war overview of the field, not the
  // enclosed-zone grid — the grid's cell readout and zoom mean nothing there.
  if (isWild()) {
    mapSelected = null;   // a cell picked in some zone must not resurface out here
    mapCellInfo.textContent = '';
    mapZoomControls.hidden = true;
    renderWildernessMap();
    return;
  }
  mapZoomControls.hidden = false;
  try {
    await ensureMapData();
    if (!mapData) return;

    // Auto-fit cell size to the wrap dimensions
    const wrapW = mapCanvasWrap.clientWidth  || 800;
    const wrapH = mapCanvasWrap.clientHeight || 600;
    mapFitPx = Math.max(1, Math.floor(Math.min(wrapW / mapData.cols, wrapH / mapData.rows)));
    mapZoom = 1;
    mapCellPx = mapFitPx;
    updateMapZoomLabel();

    renderMap();
    mapStatus.textContent = `${mapData.cols}×${mapData.rows} · ${mapData.settlements.length} settlements`;
  } catch {
    mapStatus.textContent = 'Failed to load map.';
  }
}

mapCloseBtn.addEventListener('click', closeMap);
mapBackdrop.addEventListener('click', (e) => { if (e.target === mapBackdrop) closeMap(); });

mapCanvas.addEventListener('mousemove', (e) => {
  if (isWild()) { mapTooltip.style.display = 'none'; return; }
  if (!mapData) return;
  const at = mapCellAt(e.clientX, e.clientY);
  if (!at) {
    mapTooltip.style.display = 'none';
    updateMapCellInfo();
    return;
  }
  const { row, col } = at;
  const cell = mapData.cells[row]?.[col];
  if (!cell) { mapTooltip.style.display = 'none'; return; }

  mapTooltip.style.display = 'block';
  mapTooltip.style.left = (e.clientX + 14) + 'px';
  mapTooltip.style.top  = (e.clientY + 14) + 'px';
  mapTooltip.innerHTML = `<b style="color:#e94560">${cell.zoneName}</b><br><span style="color:#aaa">${cell.worldBiome}</span>`;
  mapCellInfo.textContent = `${cell.zoneId}`;
});
mapCanvas.addEventListener('mouseleave', () => {
  mapTooltip.style.display = 'none';
  updateMapCellInfo();
});

// Returns the cell under a client point, or null if out of bounds.
function mapCellAt(clientX: number, clientY: number): { row: number; col: number } | null {
  if (!mapData) return null;
  const rect = mapCanvas.getBoundingClientRect();
  const scaleX = mapCanvas.width  / rect.width;
  const scaleY = mapCanvas.height / rect.height;
  const col = Math.floor((clientX - rect.left) * scaleX / mapCellPx);
  const row = Math.floor((clientY - rect.top)  * scaleY / mapCellPx);
  if (row < 0 || row >= mapData.rows || col < 0 || col >= mapData.cols) return null;
  return { row, col };
}

// Shows the selected cell in the status bar (used when not hovering).
function updateMapCellInfo(): void {
  if (!mapData || !mapSelected) { mapCellInfo.textContent = ''; return; }
  const cell = mapData.cells[mapSelected.row]?.[mapSelected.col];
  mapCellInfo.textContent = cell ? `${cell.zoneName} · ${cell.zoneId}` : 'Ocean';
}

function updateMapZoomLabel(): void {
  mapZoomLabel.textContent = `${Math.round(mapZoom * 100)}%`;
}

// Sets zoom, keeping the point under (anchorClientX, anchorClientY) — or the
// viewport center — fixed on screen. Re-renders and adjusts scroll.
function setMapZoom(newZoom: number, anchorClientX?: number, anchorClientY?: number): void {
  if (isWild() || !mapData) return;   // zoom belongs to the enclosed-zone grid map
  const clamped = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, newZoom));
  if (Math.abs(clamped - mapZoom) < 1e-4) return;

  const wrap = mapCanvasWrap;
  const wrapRect = wrap.getBoundingClientRect();
  const cx = anchorClientX ?? (wrapRect.left + wrap.clientWidth  / 2);
  const cy = anchorClientY ?? (wrapRect.top  + wrap.clientHeight / 2);

  const rect = mapCanvas.getBoundingClientRect();
  const fx = Math.min(1, Math.max(0, (cx - rect.left) / rect.width));
  const fy = Math.min(1, Math.max(0, (cy - rect.top)  / rect.height));

  mapZoom = clamped;
  mapCellPx = Math.max(1, Math.round(mapFitPx * mapZoom));
  updateMapZoomLabel();
  renderMap();

  wrap.scrollLeft = fx * mapCanvas.width  - (cx - wrapRect.left);
  wrap.scrollTop  = fy * mapCanvas.height - (cy - wrapRect.top);
}

mapCanvas.addEventListener('click', (e) => {
  if (isWild()) return;   // the wilderness map has no cell grid to select
  const at = mapCellAt(e.clientX, e.clientY);
  if (!at) return;
  mapSelected = at;
  updateMapCellInfo();
  renderMap();
});

mapZoomInBtn.addEventListener('click',  () => setMapZoom(mapZoom * MAP_ZOOM_STEP));
mapZoomOutBtn.addEventListener('click', () => setMapZoom(mapZoom / MAP_ZOOM_STEP));
mapZoomResetBtn.addEventListener('click', () => setMapZoom(1));

mapCanvasWrap.addEventListener('wheel', (e) => {
  if (isWild() || !mapData) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? MAP_ZOOM_STEP : 1 / MAP_ZOOM_STEP;
  setMapZoom(mapZoom * factor, e.clientX, e.clientY);
}, { passive: false });

window.addEventListener('mmo:open_map', () => { void openMap(); });
window.addEventListener('mmo:zone', scheduleMapRender);

function tradeOpen(): boolean { return tradeBackdrop.classList.contains('open'); }

function closeTrade(): void {
  stopFeaturedCountdown();
  tradeBackdrop.classList.remove('open');
  activeTradeMob = null;
  pendingSell = null;
  tradeConfirm.innerHTML = '';
  tradeErr.textContent = '';
}

// ─── Ability icon helpers ────────────────────────────────────────────────────

function buildIconSpec(def: AbilityDef, rank: number): IconSpec {
  const primary = def.effects[0];
  const kind = (primary?.kind ?? 'damage') as IconSpec['kind'];
  const shape = def.targeting.shape as IconSpec['shape'];
  const brand = primary?.kind === 'damage' ? (primary as { brand?: string }).brand : undefined;
  return { id: def.id, kind, shape, brand, rank, seed: 0 };
}

function drawAbilityIcon(canvas: HTMLCanvasElement, def: AbilityDef, rank: number): void {
  const size = canvas.width;
  const pixels = renderAbilityIcon(buildIconSpec(def, rank), size);
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.putImageData(new ImageData(pixels, size, size), 0, 0);
}

function abilityEffectSummary(def: AbilityDef, rank?: number): string {
  const parts: string[] = [];
  for (const eff of def.effects) {
    if (eff.kind === 'damage') {
      const [lo, hi] = eff.base as [number, number];
      const brandStr = (eff as { brand?: string }).brand
        ? (eff as { brand: string }).brand.replace('_damage', '') + ' '
        : '';
      parts.push(`${lo}–${hi} ${brandStr}dmg`);
      if (eff.scaling) {
        const stat = Object.keys(eff.scaling)[0];
        if (stat) parts.push(`${stat.charAt(0).toUpperCase() + stat.slice(1)} scaling`);
      }
    } else if (eff.kind === 'heal') {
      const [lo, hi] = eff.base as [number, number];
      parts.push(`${lo}–${hi} heal`);
      if (eff.scaling) {
        const stat = Object.keys(eff.scaling)[0];
        if (stat) parts.push(`${stat.charAt(0).toUpperCase() + stat.slice(1)} scaling`);
      }
    } else if (eff.kind === 'modifier') {
      const stats = Object.keys(eff.stats).slice(0, 2).join(', ');
      parts.push(stats ? `Buff (${stats})` : 'Modifier');
    } else if (eff.kind === 'move') {
      parts.push(eff.motion.charAt(0).toUpperCase() + eff.motion.slice(1));
    }
  }
  const cd = abilityCooldownTicks(def, rank) / 10;
  parts.push(`${cd}s CD`);
  const mana = def.cast.cost?.mana;
  if (mana) parts.push(`${mana} mana`);
  return parts.join(' · ');
}

// ─── Class trainer modal ────────────────────────────────────────────────────
let activeTrainerMob: EntitySnapshot | null = null;
let trainerOffers: TrainOffer[] = [];

const TRAIN_ERR_MSG: Record<string, string> = {
  under_level: 'You are not high enough level.',
  insufficient_gold: 'Not enough gold.',
  max_rank: 'Already at max rank.',
  wrong_class: "This trainer can't teach your class.",
  out_of_range: 'Move closer to the trainer.',
  no_trainer: 'Not a trainer.',
};

function trainerOpen(): boolean { return trainerBackdrop.classList.contains('open'); }
function closeTrainer(): void {
  trainerBackdrop.classList.remove('open');
  activeTrainerMob = null;
  trainerOffers = [];
  trainerErr.textContent = '';
}

async function openTrainer(snap: EntitySnapshot): Promise<void> {
  activeTrainerMob = snap;
  trainerTitle.textContent = snap.name || 'Trainer';
  trainerErr.textContent = '';
  trainerBackdrop.classList.add('open');
  const r = await state.sendTrainList(snap.id);
  trainerOffers = r.ok ? (r.offers ?? []) : [];
  if (!r.ok) trainerErr.textContent = TRAIN_ERR_MSG[r.reason ?? ''] || r.reason || 'Trainer unavailable.';
  renderTrainer();
}

function renderTrainer(): void {
  const s = state.self;
  if (!s || !activeTrainerMob) return;
  trainerGoldEl.textContent = String(s.components?.wallet?.gold || 0);
  trainerList.innerHTML = '';
  if (trainerOffers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ab-empty';
    empty.textContent = 'Nothing to teach you.';
    trainerList.appendChild(empty);
    return;
  }
  for (const o of trainerOffers) {
    const def = state.abilityDefs?.[o.abilityId];
    const maxed = !o.nextRank;
    const totalRanks = def?.ranks?.length ?? 0;
    const currentRank = o.currentRank;

    // Card element
    const card = document.createElement('div');
    card.className = 'ab-card' +
      (maxed ? ' ab-maxed' : currentRank > 0 ? ' ab-learned' : '') +
      (o.locked ? ' ab-locked' : '');

    // Icon canvas
    const iconCanvas = document.createElement('canvas');
    iconCanvas.className = 'ab-icon';
    iconCanvas.width = 36;
    iconCanvas.height = 36;
    if (def) drawAbilityIcon(iconCanvas, def, Math.max(1, currentRank));

    // Body: name + description
    const body = document.createElement('div');
    body.className = 'ab-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'ab-name';
    nameEl.textContent = o.name;
    const descEl = document.createElement('div');
    descEl.className = 'ab-desc';
    descEl.textContent = def ? abilityEffectSummary(def, Math.max(1, currentRank)) : '';
    body.appendChild(nameEl);
    body.appendChild(descEl);

    // Right column: rank dots + price + button
    const right = document.createElement('div');
    right.className = 'ab-right';

    if (totalRanks > 0) {
      const dots = document.createElement('div');
      dots.className = 'ab-ranks';
      for (let r = 1; r <= totalRanks; r++) {
        const dot = document.createElement('span');
        dot.className = 'ab-rdot' + (r <= currentRank ? ' filled' : '');
        dots.appendChild(dot);
      }
      right.appendChild(dots);
    }

    if (maxed) {
      const badge = document.createElement('span');
      badge.className = 'ab-max';
      badge.textContent = 'Max';
      right.appendChild(badge);
    } else {
      const priceEl = document.createElement('div');
      priceEl.className = 'ab-price' + (o.locked === 'under_level' || o.locked === 'insufficient_gold' ? ' err' : '');
      priceEl.textContent = o.costGold === 0 ? 'Free' : `${o.costGold}g · L${o.requiresLevel}`;
      right.appendChild(priceEl);

      const btn = document.createElement('button');
      btn.className = 'ab-btn' + (currentRank > 0 ? ' upgrade' : '');
      btn.textContent = currentRank === 0 ? 'Learn' : 'Upgrade';
      btn.disabled = !!o.locked;
      if (o.locked) btn.title = TRAIN_ERR_MSG[o.locked] || o.locked;
      btn.addEventListener('click', async () => {
        if (!activeTrainerMob) return;
        const r = await state.sendTrain({ mobId: activeTrainerMob.id, abilityId: o.abilityId });
        if (r.ok && r.self) {
          state.self = r.self;
          const lr = await state.sendTrainList(activeTrainerMob.id);
          if (lr.ok) trainerOffers = lr.offers ?? [];
          renderTrainer();
        } else {
          trainerErr.textContent = TRAIN_ERR_MSG[r.reason ?? ''] || r.reason || 'Could not train.';
        }
      });
      right.appendChild(btn);
    }

    card.appendChild(iconCanvas);
    card.appendChild(body);
    card.appendChild(right);
    trainerList.appendChild(card);
  }
}

// ─── Skills panel (known abilities + hotbar editor) ──────────────────────────
function skillsOpen(): boolean { return skillsBackdrop.classList.contains('open'); }
function openSkills(): void { skillsBackdrop.classList.add('open'); renderSkills(); }
function closeSkills(): void { skillsBackdrop.classList.remove('open'); }

// Read-only list of every ability the player knows, with its current rank. Each
// card is a drag source for binding the ability to a hotbar slot.
function renderSkills(): void {
  const s = state.self;
  if (!s) return;
  const known = s.components.knownAbilities ?? {};
  skillsList.innerHTML = '';
  const ids = Object.keys(known).sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ab-empty';
    empty.textContent = 'You have not learned any skills yet.';
    skillsList.appendChild(empty);
    return;
  }
  for (const id of ids) {
    const def = state.abilityDefs?.[id];
    const rank = known[id];
    const totalRanks = def?.ranks?.length ?? 0;

    const card = document.createElement('div');
    card.className = 'ab-card ab-learned sk-card';
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      hbDrag = { kind: 'skill', abilityId: id };
      e.dataTransfer?.setData('text/plain', id);
      card.classList.add('sk-dragging');
    });
    card.addEventListener('dragend', () => { hbDrag = null; card.classList.remove('sk-dragging'); clearDropHighlights(); });

    const iconCanvas = document.createElement('canvas');
    iconCanvas.className = 'ab-icon';
    iconCanvas.width = 36;
    iconCanvas.height = 36;
    if (def) drawAbilityIcon(iconCanvas, def, rank);

    const body = document.createElement('div');
    body.className = 'ab-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'ab-name';
    nameEl.textContent = def?.name ?? prettifyAbility(id);
    const descEl = document.createElement('div');
    descEl.className = 'ab-desc';
    descEl.textContent = def ? abilityEffectSummary(def, rank) : '';
    body.appendChild(nameEl);
    body.appendChild(descEl);

    const right = document.createElement('div');
    right.className = 'ab-right';
    if (totalRanks > 0) {
      const dots = document.createElement('div');
      dots.className = 'ab-ranks';
      for (let r = 1; r <= totalRanks; r++) {
        const dot = document.createElement('span');
        dot.className = 'ab-rdot' + (r <= rank ? ' filled' : '');
        dots.appendChild(dot);
      }
      right.appendChild(dots);
    }
    const rankEl = document.createElement('div');
    rankEl.className = 'sk-rank';
    rankEl.textContent = totalRanks > 0 ? `Rank ${rank} / ${totalRanks}` : `Rank ${rank}`;
    right.appendChild(rankEl);

    card.appendChild(iconCanvas);
    card.appendChild(body);
    card.appendChild(right);
    skillsList.appendChild(card);
  }
}
window.addEventListener('mmo:self', () => { if (skillsOpen()) renderSkills(); });

// The compact one-line stat summary under a trade row's name. Takes the four
// fields both a base profile (ShopItem) and a rolled item (RolledStats) have,
// under their different names.
function statParts(
  damage: unknown, defense: unknown, speed: unknown, scaling?: Record<string, string>,
): string[] {
  const parts: string[] = [];
  if (Array.isArray(damage)) parts.push(`Dmg ${damage[0]}–${damage[1]}`);
  if (Array.isArray(defense)) parts.push(`Def ${defense[0]}–${defense[1]}`);
  if (typeof speed === 'number') parts.push(`Spd ${speed.toFixed(2)}`);
  if (scaling) {
    const scl = Object.entries(scaling)
      .filter(([, v]) => v && v !== '-')
      .map(([k, v]) => `${k.slice(0, 3).toUpperCase()} ${v}`)
      .join(' ');
    if (scl) parts.push(scl);
  }
  return parts;
}

function shopItemStatParts(si: ShopItem): string[] {
  return statParts(si.base_damage, si.base_defense, si.base_speed, si.scaling);
}

function shopItemTooltip(si: ShopItem): string {
  return [si.name, ...shopItemStatParts(si)].join('\n');
}

// A featured row is a rolled item, not a base: same four fields under their
// rolled names, plus the affixes the roll actually landed.
function rolledStatParts(rolled: RolledStats): string[] {
  const SKIP = new Set(['damage', 'defense', 'speed', 'scaling', 'weapon_brand']);
  const bonuses = Object.entries(rolled)
    .filter(([k, v]) => !SKIP.has(k) && typeof v === 'number')
    .map(([k, v]) => `+${v} ${k.replace(/_/g, ' ')}`);
  return [
    ...statParts(rolled.damage, rolled.defense, rolled.speed, rolled.scaling as Record<string, string> | undefined),
    ...bonuses,
  ];
}

// A section heading inside the trade list, with an optional right-aligned note
// (the featured shelf uses it for the refresh countdown).
function appendTradeSection(label: string, sub?: string): void {
  const head = document.createElement('div');
  head.className = 'trade-section';
  const lbl = document.createElement('span');
  lbl.className = 'trade-section-lbl';
  lbl.textContent = label;
  head.appendChild(lbl);
  if (sub !== undefined) {
    const subEl = document.createElement('span');
    subEl.className = 'trade-section-sub';
    subEl.textContent = sub;
    head.appendChild(subEl);
  }
  tradeList.appendChild(head);
}

function renderFeatured(gold: number): void {
  if (!hasFeaturedShelf()) return;
  appendTradeSection('◆ FEATURED STOCK', `refreshes in ${countdownText(featuredRefreshAt - Date.now())}`);
  if (featuredItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'trade-empty';
    empty.textContent = 'Sold out. Check back after the next refresh.';
    tradeList.appendChild(empty);
    return;
  }
  for (const fi of featuredItems) {
    const eq = fi.stack.item!.components.equipment;
    const stats = rolledStatParts(eq.rolled);
    appendTradeRow(
      fi.stack.name, `${fi.price}g`, 'trade-row-price', 'Buy', 'trade-btn buy', gold < fi.price,
      async () => {
        if (!activeTradeMob) return;
        const r = await state.sendTrade({ mobId: activeTradeMob.id, action: 'buy', featuredId: fi.id });
        if (r.ok && r.self) {
          state.self = r.self;
          // One copy per roll: a bought row is gone until the shelf turns over.
          featuredItems = featuredItems.filter((e) => e.id !== fi.id);
        } else {
          tradeErr.textContent = TRADE_ERR_MSG[r.reason ?? ''] || r.reason || 'Trade failed.';
          if (r.reason === 'sold_out') featuredItems = featuredItems.filter((e) => e.id !== fi.id);
        }
        renderTrade();
      },
      `${stackTooltip(fi.stack)}\nItem level: ${fi.ilvl}`,
      stats.join('  ·  '),
      { rowClass: 'featured', nameColor: rarityColor(eq.rarity), stack: fi.stack },
    );
  }
}

function appendTradeRow(
  label: string,
  priceText: string,
  priceClass: string,
  btnLabel: string,
  btnClass: string,
  disabled: boolean,
  onClick: () => void,
  tooltip?: string,
  statLine?: string,
  opts: { rowClass?: string; nameColor?: string; stack?: VisualSource } = {},
): void {
  const row = document.createElement('div');
  row.className = 'trade-row' + (opts.rowClass ? ` ${opts.rowClass}` : '');
  if (tooltip) row.title = tooltip;
  const rowIcon = opts.stack ? itemIconEl(opts.stack, 22) : null;
  if (rowIcon) row.appendChild(rowIcon);
  const name = document.createElement('span');
  name.className = 'trade-row-name';
  const nameText = document.createElement('span');
  nameText.textContent = label;
  if (opts.nameColor) nameText.style.color = opts.nameColor;
  name.appendChild(nameText);
  if (statLine) {
    const stats = document.createElement('span');
    stats.className = 'trade-row-stats';
    stats.textContent = statLine;
    name.appendChild(stats);
  }
  const price = document.createElement('span');
  price.className = priceClass;
  price.textContent = priceText;
  const btn = document.createElement('button');
  btn.className = btnClass;
  btn.textContent = btnLabel;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  row.appendChild(name);
  row.appendChild(price);
  row.appendChild(btn);
  tradeList.appendChild(row);
}

function renderTrade(): void {
  const s = state.self;
  if (!s || !activeTradeMob) return;
  const gold = s.components?.wallet?.gold || 0;
  tradeGoldEl.textContent = String(gold);
  tradeList.innerHTML = '';
  tradeErr.textContent = '';

  if (tradeTab === 'buy') {
    // The rotating shelf leads — it's the reason to come back, and it's the
    // part that expires.
    renderFeatured(gold);
    if (shopItems.length === 0) {
      if (!hasFeaturedShelf()) {
        const empty = document.createElement('div');
        empty.className = 'trade-empty';
        empty.textContent = 'Nothing for sale.';
        tradeList.appendChild(empty);
      }
      return;
    }
    if (hasFeaturedShelf()) appendTradeSection('STOCK');
    for (const si of shopItems) {
      appendTradeRow(si.name, `${si.price}g`, 'trade-row-price', 'Buy', 'trade-btn buy', gold < si.price, async () => {
        if (!activeTradeMob) return;
        const r = await state.sendTrade({ mobId: activeTradeMob.id, action: 'buy', itemBase: si.item });
        if (r.ok && r.self) { state.self = r.self; renderTrade(); }
        else tradeErr.textContent = TRADE_ERR_MSG[r.reason ?? ''] || r.reason || 'Trade failed.';
      }, shopItemTooltip(si), shopItemStatParts(si).join('  ·  '),
        // Plain stock is a base id and a price, no rolled item — which is all
        // an icon needs, since shape and ramp both come from the base.
        { stack: { base: si.item } });
    }
  } else {
    const inv = s.components?.inventory?.slots || [];
    const grid = document.createElement('div');
    grid.className = 'slot-grid';
    let hasItems = false;
    for (let i = 0; i < inv.length; i++) {
      const stack = inv[i];
      const rarity = stack?.item?.components?.equipment?.rarity as string | undefined;
      const unsellable = stack?.item_slot === 'quest' || stack?.item_slot === 'currency';
      const cell = document.createElement('div');
      cell.className = 'slot' + (stack ? (unsellable ? ' unsellable' : ' filled') : ' empty');
      if (rarity && !unsellable) cell.style.color = rarityColor(rarity);
      if (pendingSell?.slotIndex === i) cell.classList.add('selected');
      const sellIcon = stack ? itemIconEl(stack, 34) : null;
      if (sellIcon) cell.appendChild(sellIcon);
      else cell.textContent = stack ? (stack.name || stack.base || '?') : '·';
      if (stack) cell.title = stackTooltip(stack);
      if (stack && !unsellable) {
        hasItems = true;
        cell.addEventListener('click', () => {
          pendingSell = { slotIndex: i, stack };
          tradeErr.textContent = '';
          renderTrade();
        });
      }
      grid.appendChild(cell);
    }
    tradeList.appendChild(grid);
    if (!hasItems) {
      const empty = document.createElement('div');
      empty.className = 'trade-empty';
      empty.textContent = 'Nothing to sell.';
      tradeList.appendChild(empty);
    }

    tradeConfirm.innerHTML = '';
    if (pendingSell) {
      const { slotIndex, stack } = pendingSell;
      const price = Math.max(1, stack.sell_value ?? 0);
      const nameEl = document.createElement('div');
      nameEl.className = 'conf-item';
      nameEl.innerHTML = `Sell <b>${stack.name || stack.base || 'item'}</b> for <span class="conf-price">${price}g</span>?`;
      const actions = document.createElement('div');
      actions.className = 'conf-actions';
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'trade-btn';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.addEventListener('click', async () => {
        if (!activeTradeMob || !pendingSell) return;
        const r = await state.sendTrade({ mobId: activeTradeMob.id, action: 'sell', slotIndex });
        if (r.ok && r.self) { state.self = r.self; pendingSell = null; tradeErr.textContent = ''; }
        else tradeErr.textContent = TRADE_ERR_MSG[r.reason ?? ''] || r.reason || 'Trade failed.';
        renderTrade();
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'trade-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => { pendingSell = null; tradeConfirm.innerHTML = ''; renderTrade(); });
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      tradeConfirm.appendChild(nameEl);
      tradeConfirm.appendChild(actions);
    }
  }
}

async function openTrade(snap: EntitySnapshot): Promise<void> {
  if (!snap.templateId) return;
  activeTradeMob = snap;
  tradeTab = 'buy';
  tradeTitle.textContent = snap.name;
  tradeErr.textContent = '';
  tradeList.innerHTML = '';
  tradeTabBuy.classList.add('active');
  tradeTabSell.classList.remove('active');
  tradeBackdrop.classList.add('open');
  featuredItems = [];
  featuredRefreshAt = 0;
  try {
    const r = await fetch(`${BACKEND_URL}/api/shop/${snap.templateId}`);
    if (r.ok) {
      const body = (await r.json()) as { items: ShopItem[]; featured?: FeaturedStockEntry[]; refreshAt?: number };
      shopItems = body.items ?? [];
      featuredItems = body.featured ?? [];
      featuredRefreshAt = body.refreshAt ?? 0;
    } else shopItems = [];
  } catch { shopItems = []; }
  startFeaturedCountdown();
  renderTrade();
}

// Tick the shelf's countdown once a second while the modal is open. When it hits
// zero the shelf has re-rolled server-side, so refetch rather than counting into
// the negative — the player watching the timer gets the new stock as it lands.
function startFeaturedCountdown(): void {
  stopFeaturedCountdown();
  if (!hasFeaturedShelf()) return;
  featuredTimer = setInterval(() => {
    if (!tradeOpen() || !activeTradeMob) { stopFeaturedCountdown(); return; }
    const left = featuredRefreshAt - Date.now();
    // Stop first: openTrade only restarts the timer after its fetch resolves,
    // so a live interval would fire another refetch every second until then.
    if (left <= 0) { const mob = activeTradeMob; stopFeaturedCountdown(); void openTrade(mob); return; }
    // The list is rebuilt on every purchase, so look the element up rather than
    // holding a handle that goes stale. Absent on the sell tab.
    const sub = tradeList.querySelector('.trade-section-sub');
    if (sub) sub.textContent = `refreshes in ${countdownText(left)}`;
  }, 1000);
}

function stopFeaturedCountdown(): void {
  if (featuredTimer) clearInterval(featuredTimer);
  featuredTimer = null;
}

tradeTabBuy.addEventListener('click', () => {
  tradeTab = 'buy';
  tradeTabBuy.classList.add('active');
  tradeTabSell.classList.remove('active');
  pendingSell = null;
  tradeConfirm.innerHTML = '';
  tradeErr.textContent = '';
  renderTrade();
});
tradeTabSell.addEventListener('click', () => {
  tradeTab = 'sell';
  tradeTabSell.classList.add('active');
  tradeTabBuy.classList.remove('active');
  pendingSell = null;
  tradeConfirm.innerHTML = '';
  tradeErr.textContent = '';
  renderTrade();
});

window.addEventListener('mmo:self', () => { if (tradeOpen()) renderTrade(); });

// ─── Hover tooltip + click-to-talk + quest modals ─────────────────────────
const tooltipEl = document.getElementById('world-tooltip')!;
const qgBackdrop = document.getElementById('questgiver-backdrop')!;
const qgTitle = document.getElementById('qg-title')!;
const qgBody = document.getElementById('qg-body')!;
const qlBackdrop = document.getElementById('questlog-backdrop')!;
const qlBody = document.getElementById('ql-body')!;

interface CameraTransform { offsetX: number; offsetY: number }
let lastCamera: CameraTransform = { offsetX: 0, offsetY: 0 };

// Camera smoothing. self.position is a whole tile, so deriving the camera
// straight from it snapped the world a full TILE at a time — a stutter no
// framerate can fix. A float camera eased toward the player's tile turns that
// into continuous motion; the final offset is still rounded to whole pixels so
// the pixel-art tiles stay crisp (32x finer than before, no subpixel blur).
//
// The ease is a critically damped spring, NOT a plain exponential lerp, and the
// difference matters here. Steps land on whole 100ms server ticks via a
// fractional accumulator, so the input cadence is uneven by construction — how
// uneven depends on AUTOPATH_TILES_PER_SEC (at 6 it was a repeating
// 200/200/100ms pattern; at 5.1 it is 200ms with an occasional 100ms catch-up).
// A plain lerp restarts from zero velocity on every step, so it re-radiates
// that unevenness as a visible surge-rest-surge bounce. A spring carries
// velocity across steps, which low-passes the irregular input into near-
// constant motion — and stays smooth whatever the walk rate is tuned to.
const CAM_SMOOTH_TIME = 0.30;  // seconds to converge; lower = tighter, higher = floatier
// Past this the move isn't a walk — a portal, respawn, or blink. Cut, don't pan.
const CAM_SNAP_TILES = 6;
let camX = 0, camY = 0;
let camVx = 0, camVy = 0;
let camReady = false;
let camLastMs = 0;
let camZoneRef = '';

// Zoom. Browser zoom is not a substitute: it rescales the HUD and the DOM
// panels along with the world, and on a hi-dpi display it resamples the tiles
// instead of showing more of them. This is a world-only zoom — it changes how
// many tiles fit on screen and nothing else.
//
// The wheel drives a *velocity* in log-zoom space rather than stepping the zoom
// directly, so a flick coasts to a stop and a held scroll accelerates smoothly.
// Log space is what makes a notch feel the same at every zoom: a fixed additive
// step is a big jump when zoomed out and a nudge when zoomed in.
const ZOOM_MIN = 0.55, ZOOM_MAX = 2.4;
const ZOOM_IMPULSE = 0.011;  // log-zoom velocity per unit of wheel delta
const ZOOM_DAMP = 9;         // 1/s; total travel per flick is impulse / damp
let camZoomLog = 0;
let camZoomVel = 0;

// Integrates the zoom velocity. Split out of render() only because the clamp
// has to kill the velocity at the stops — otherwise a long scroll past the
// limit banks momentum that plays back when you scroll the other way.
function stepZoom(dt: number): void {
  if (camZoomVel !== 0) {
    camZoomLog += camZoomVel * dt;
    camZoomVel *= Math.exp(-ZOOM_DAMP * dt);
    if (Math.abs(camZoomVel) < 0.001) camZoomVel = 0;
    const lo = Math.log(ZOOM_MIN), hi = Math.log(ZOOM_MAX);
    if (camZoomLog < lo) { camZoomLog = lo; camZoomVel = 0; }
    if (camZoomLog > hi) { camZoomLog = hi; camZoomVel = 0; }
  }
  // Whole pixels. The renderer's crispness rests on integer tile sizes (see the
  // offset rounding in render()), so the continuous zoom is quantised here, on
  // the way to the renderer, not in the input.
  TILE = Math.round(BASE_TILE * Math.exp(camZoomLog));
}
let camZoomLastMs = 0;
let hoveredEntity: EntitySnapshot | null = null;
let hoveredTile: { x: number; y: number } | null = null;
let mousePx = { x: 0, y: 0 };

function qgOpen(): boolean { return qgBackdrop.classList.contains('open'); }
function qlOpen(): boolean { return qlBackdrop.classList.contains('open'); }
function closeQuestgiver(): void { qgBackdrop.classList.remove('open'); }
function closeQuestlog(): void { qlBackdrop.classList.remove('open'); }

// Per-player, per-quest-state cache: which templates have a pending-quest
// `!` (offered but not yet accepted/completed) and which have an active
// talk-objective targeting them right now. Rebuilt on `mmo:quests` only —
// the canvas render and mousemove handlers hit these every frame/event.
// Per-giver-key → offerable quest ids. Kept as id lists (not flat key sets) so a
// mob's marker can also check each quest's `zone` against the mob's zone — a
// template giver only lights up in the quest's own region, not on every mob of
// that template across the map.
let offerableByGiver = new Map<string, string[]>();
let repeatableByGiver = new Map<string, string[]>();
let talkTargetKeys = new Set<string>();

/** Returns the quest-giver key for a mob snapshot.
 *  Prefers spawnId when present (specific instance), falls back to templateId. */
function giverKey(snap: EntitySnapshot): string | null {
  if (snap.type !== 'mob') return null;
  return snap.spawnId ?? snap.templateId ?? null;
}

function isQuestLocked(questId: string, completed: Set<string>): boolean {
  const def = state.questDefs[questId];
  if (!def?.unlock_after) return false;
  const prereqs = Array.isArray(def.unlock_after) ? def.unlock_after : [def.unlock_after];
  return !prereqs.every((id) => completed.has(id));
}

function rebuildQuestInteractionCaches(): void {
  const accepted = new Set(state.quests.active.map((q) => q.questId));
  const completed = new Set(state.quests.completed);
  offerableByGiver = new Map();
  repeatableByGiver = new Map();
  for (const [key, ids] of Object.entries(state.questsByGiver)) {
    const nonRepeatable = ids.filter((id) => {
      const def = state.questDefs[id];
      return def && !def.repeatable && !accepted.has(id) && !completed.has(id) && !isQuestLocked(id, completed);
    });
    const repeatable = ids.filter((id) => {
      const def = state.questDefs[id];
      return !!def?.repeatable && !accepted.has(id) && !isQuestLocked(id, completed);
    });
    if (nonRepeatable.length) offerableByGiver.set(key, nonRepeatable);
    if (repeatable.length) repeatableByGiver.set(key, repeatable);
  }
  talkTargetKeys = new Set();
  for (const entry of state.quests.active) {
    const def = state.questDefs[entry.questId];
    if (!def) continue;
    const stage = def.stages?.find((s) => s.id === entry.stage);
    const obj = stage?.objective ?? (def.giver ? { kind: 'talk' as const, target_template: def.giver } : null);
    if (obj?.kind === 'talk') talkTargetKeys.add(obj.target_template);
  }
}

// A quest offers on this mob only if its zone is unset (global) or matches the
// mob's current zone — so a template giver's marker stays in the quest's region.
function anyQuestInZone(ids: string[] | undefined, zone: string): boolean {
  return !!ids?.some((id) => { const z = state.questDefs[id]?.zone; return !z || z === zone; });
}

function isQuestgiver(snap: EntitySnapshot): boolean {
  if (snap.type !== 'mob') return false;
  const zone = snap.position.zone;
  return anyQuestInZone(snap.spawnId != null ? offerableByGiver.get(snap.spawnId) : undefined, zone)
      || anyQuestInZone(snap.templateId != null ? offerableByGiver.get(snap.templateId) : undefined, zone);
}

function isRepeatableQuestgiver(snap: EntitySnapshot): boolean {
  if (snap.type !== 'mob') return false;
  const zone = snap.position.zone;
  return anyQuestInZone(snap.spawnId != null ? repeatableByGiver.get(snap.spawnId) : undefined, zone)
      || anyQuestInZone(snap.templateId != null ? repeatableByGiver.get(snap.templateId) : undefined, zone);
}

function isTalkTarget(snap: EntitySnapshot): boolean {
  if (snap.type !== 'mob') return false;
  return (snap.templateId != null && talkTargetKeys.has(snap.templateId))
      || (snap.spawnId   != null && talkTargetKeys.has(snap.spawnId));
}

// Resolve the active stage's objective for a quest, falling back to the
// "talk to giver" default the server also uses when YAML omits one.
function resolveActiveObjective(def: QuestDef): NonNullable<QuestDef['stages']>[number]['objective'] | null {
  const entry = state.quests.active.find((q) => q.questId === def.id);
  if (!entry) return null;
  const stage = def.stages?.find((s) => s.id === entry.stage);
  if (!stage) return null;
  if (stage.objective) return stage.objective;
  if (def.giver) return { kind: 'talk', target_template: def.giver };
  return null;
}

function progressText(def: QuestDef): string | null {
  const entry = state.quests.active.find((q) => q.questId === def.id);
  if (!entry) return null;
  const obj = resolveActiveObjective(def);
  if (!obj) return null;
  if (obj.kind === 'kill_count') {
    return `Killed: ${entry.progress?.killed ?? 0} / ${obj.target}`;
  }
  if (obj.kind === 'collect_count') {
    return `Collected: ${entry.progress?.collected ?? 0} / ${obj.target} ${obj.item_base}`;
  }
  if (obj.kind === 'kill_specific') {
    return entry.progress?.killed ? 'Target defeated' : 'Target still at large';
  }
  return null;
}

function questgiverBlock(
  def: QuestDef,
  state_: 'available' | 'active' | 'completed',
  clickedTemplate: string,
  clickedSpawnId?: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'quest-block';
  const name = document.createElement('div');
  name.className = 'quest-name';
  name.textContent = def.name || def.id;
  wrap.appendChild(name);
  if (def.description) {
    const desc = document.createElement('div');
    desc.className = 'quest-desc';
    desc.textContent = String(def.description).trim();
    wrap.appendChild(desc);
  }
  if (def.rewards && def.rewards.length > 0) {
    const r = document.createElement('div');
    r.className = 'quest-rewards';
    const parts: string[] = [];
    for (const reward of def.rewards) {
      if (reward.gold) parts.push(`${reward.gold} gold`);
      if (reward.item) parts.push(reward.item);
    }
    r.textContent = parts.length ? `Rewards: ${parts.join(', ')}` : '';
    wrap.appendChild(r);
  }
  const status = document.createElement('div');
  status.className = 'quest-status';
  if (state_ === 'active') {
    const entry = state.quests.active.find((q) => q.questId === def.id);
    const stage = def.stages?.find((s) => s.id === entry?.stage);
    const prog = progressText(def);
    const parts = [stage?.text || entry?.stage || '', prog].filter(Boolean);
    status.textContent = `In progress — ${parts.join(' · ')}`;
  } else if (state_ === 'completed') {
    status.textContent = 'Completed';
  }
  if (state_ !== 'available') wrap.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (state_ === 'available') {
    const accept = document.createElement('button');
    accept.className = 'primary';
    accept.textContent = 'Accept';
    accept.addEventListener('click', async () => {
      const r = await state.sendQuestAction(def.id, 'accept', clickedTemplate);
      if (!r.ok && r.reason === 'out_of_range') {
        showFloatingMessage('Move closer to talk.');
        return;
      }
      closeQuestgiver();
    });
    const decline = document.createElement('button');
    decline.textContent = 'Decline';
    decline.addEventListener('click', () => closeQuestgiver());
    actions.appendChild(decline);
    actions.appendChild(accept);
  } else if (state_ === 'active') {
    const obj = resolveActiveObjective(def);
    const talkTarget = obj?.kind === 'talk'
      ? (obj.target_template === clickedSpawnId ? clickedSpawnId : clickedTemplate)
      : undefined;
    if (obj?.kind === 'talk' && (obj.target_template === clickedTemplate || obj.target_template === clickedSpawnId)) {
      const report = document.createElement('button');
      report.className = 'primary';
      report.textContent = 'Report';
      report.addEventListener('click', async () => {
        const r = await state.sendQuestAction(def.id, 'talk', talkTarget);
        if (!r.ok && r.reason === 'out_of_range') {
          showFloatingMessage('Move closer to talk.');
          return;
        }
        closeQuestgiver();
      });
      actions.appendChild(report);
    }
    const abandon = document.createElement('button');
    abandon.textContent = 'Abandon';
    abandon.addEventListener('click', async () => {
      await state.sendQuestAction(def.id, 'abandon');
      closeQuestgiver();
    });
    actions.appendChild(abandon);
  }
  wrap.appendChild(actions);
  return wrap;
}

function showFloatingMessage(text: string): void {
  let banner = document.getElementById('qg-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'qg-banner';
    banner.className = 'quest-status';
    banner.style.color = '#ffd84a';
    banner.style.marginTop = '6px';
    qgBody.appendChild(banner);
  }
  banner.textContent = text;
}

function openQuestgiver(snap: EntitySnapshot): void {
  const key = giverKey(snap);
  if (!key) return;
  qgTitle.textContent = snap.name;
  qgBody.innerHTML = '';

  // questsByGiver is keyed by templateId; giverKey() may return spawnId, so check both.
  const offered = state.questsByGiver[key] ?? state.questsByGiver[snap.templateId ?? ''] ?? [];

  const active = new Set(state.quests.active.map((q) => q.questId));
  const completed = new Set(state.quests.completed);

  // Build the full queue: quests offered by this NPC plus active quests
  // with a talk objective targeting this NPC (inter-NPC handoffs).
  const queue = new Set(offered);
  for (const entry of state.quests.active) {
    const def = state.questDefs[entry.questId];
    if (!def) continue;
    const stage = def.stages?.find((s) => s.id === entry.stage);
    const obj = stage?.objective ?? (def.giver ? { kind: 'talk' as const, target_template: def.giver } : null);
    if (obj?.kind === 'talk' && (obj.target_template === key || obj.target_template === snap.templateId)) {
      queue.add(entry.questId);
    }
  }

  if (queue.size === 0) {
    const speech = state.speech.get(snap.id);
    const hint = document.createElement('div');
    hint.className = 'quest-desc';
    hint.textContent = speech?.text || `${snap.name} has nothing for you right now.`;
    qgBody.appendChild(hint);
    qgBackdrop.classList.add('open');
    return;
  }

  for (const qid of queue) {
    const def = state.questDefs[qid];
    if (!def) continue;
    if (!active.has(qid) && !completed.has(qid) && isQuestLocked(qid, completed)) continue;
    const st = active.has(qid) ? 'active' : completed.has(qid) ? 'completed' : 'available';
    qgBody.appendChild(questgiverBlock(def, st, snap.templateId ?? key, snap.spawnId));
  }
  qgBackdrop.classList.add('open');
}

// Completed quests are collapsed by default to keep the log readable as it grows.
let completedExpanded = false;

function renderQuestlog(): void {
  qlBody.innerHTML = '';
  const active = state.quests.active;
  const completed = state.quests.completed;

  const activeHeader = document.createElement('div');
  activeHeader.className = 'ql-section';
  activeHeader.textContent = `Active (${active.length})`;
  qlBody.appendChild(activeHeader);
  if (active.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ql-empty';
    empty.textContent = 'No active quests.';
    qlBody.appendChild(empty);
  } else {
    for (const entry of active) {
      const def = state.questDefs[entry.questId];
      const row = document.createElement('div');
      row.className = 'quest-row';
      const name = document.createElement('div');
      name.className = 'ql-name';
      name.textContent = def?.name || entry.questId;
      const stage = def?.stages?.find((s) => s.id === entry.stage);
      const stageText = document.createElement('div');
      stageText.className = 'ql-stage';
      stageText.textContent = stage?.text?.trim() || `Current stage: ${entry.stage}`;
      row.appendChild(name);
      row.appendChild(stageText);
      if (def) {
        const prog = progressText(def);
        if (prog) {
          const progEl = document.createElement('div');
          progEl.className = 'ql-stage';
          progEl.style.color = '#7acdf5';
          progEl.textContent = prog;
          row.appendChild(progEl);
        }
      }
      qlBody.appendChild(row);
    }
  }

  if (completed.length > 0) {
    const cHeader = document.createElement('div');
    cHeader.className = 'ql-section ql-collapsible';
    const caret = document.createElement('span');
    caret.className = 'ql-caret';
    caret.textContent = completedExpanded ? '▾' : '▸';
    cHeader.appendChild(caret);
    cHeader.appendChild(document.createTextNode(`Completed (${completed.length})`));
    cHeader.addEventListener('click', () => {
      completedExpanded = !completedExpanded;
      renderQuestlog();
    });
    qlBody.appendChild(cHeader);
    if (completedExpanded) {
      for (const qid of completed) {
        const def = state.questDefs[qid];
        const row = document.createElement('div');
        row.className = 'quest-row';
        const name = document.createElement('div');
        name.className = 'ql-name';
        name.textContent = def?.name || qid;
        row.appendChild(name);
        qlBody.appendChild(row);
      }
    }
  }
}

function openQuestlog(): void { qlBackdrop.classList.add('open'); renderQuestlog(); }

const questTrackerEl = document.getElementById('quest-tracker')!;

function renderQuestTracker(): void {
  questTrackerEl.innerHTML = '';
  const active = state.quests?.active ?? [];
  if (active.length === 0) return;
  const header = document.createElement('div');
  header.className = 'qt-header';
  header.textContent = 'Active Quests';
  questTrackerEl.appendChild(header);
  const shown = active.slice(0, 3);
  for (const entry of shown) {
    const def = state.questDefs[entry.questId];
    const wrap = document.createElement('div');
    wrap.className = 'qt-entry';
    const name = document.createElement('div');
    name.className = 'qt-name';
    name.textContent = def?.name || entry.questId;
    wrap.appendChild(name);
    const stageDef = def?.stages?.find((s) => s.id === entry.stage);
    const isReturnStage = stageDef && !stageDef.objective;
    const isTalkStage = stageDef?.objective?.kind === 'talk';
    if (stageDef?.text) {
      const stageEl = document.createElement('div');
      stageEl.className = 'qt-stage';
      const txt = stageDef.text.trim();
      stageEl.textContent = txt.length > 70 ? txt.slice(0, 67) + '…' : txt;
      wrap.appendChild(stageEl);
    }
    if (def) {
      const prog = progressText(def);
      if (prog) {
        const progEl = document.createElement('div');
        progEl.className = 'qt-progress';
        progEl.textContent = prog;
        wrap.appendChild(progEl);
      }
    }
    if (isReturnStage || isTalkStage) {
      const returnEl = document.createElement('div');
      returnEl.className = 'qt-return';
      returnEl.textContent = '↩ Return to NPC';
      wrap.appendChild(returnEl);
    }
    questTrackerEl.appendChild(wrap);
  }
  if (active.length > 3) {
    const more = document.createElement('div');
    more.className = 'qt-more';
    more.textContent = `+${active.length - 3} more — press Q`;
    questTrackerEl.appendChild(more);
  }
}

window.addEventListener('mmo:quests', () => {
  rebuildQuestInteractionCaches();
  renderQuestTracker();
  if (qlOpen()) renderQuestlog();
});
window.addEventListener('mmo:ready', () => {
  rebuildQuestInteractionCaches();
  renderQuestTracker();
  void ensureMapData();   // preload world map so the minimap compass has neighbor names
});

// ---------------------------------------------------------------------------
// Hotbar
// ---------------------------------------------------------------------------

function findFirstConsumable(): { slot: number; stack: InventoryStack } | null {
  const slots = state.self?.components?.inventory?.slots;
  if (!slots) return null;
  for (let i = 0; i < slots.length; i++) {
    const stack = slots[i];
    if (stack && stack.item_slot === 'consumable') return { slot: i, stack };
  }
  return null;
}

function prettifyAbility(id: string): string {
  return id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Effective range of an ability at the player's current rank — mirrors the
// server's currentRank/range-override lookup (server/game/systems/abilities.ts)
// so range-based UI (armed cursor, tile highlight, hotbar out-of-range stripe)
// agrees with what the server will actually accept.
function abilityRange(id: string): number {
  const def = state.abilityDefs?.[id];
  if (!def) return 0;
  const myRank = state.self?.components.knownAbilities?.[id] ?? 1;
  const row = def.ranks?.find((r) => r.rank === myRank) ?? def.ranks?.[0];
  return row?.range ?? def.targeting.range;
}

// Effective cooldown (ticks) at the player's current rank — same lookup as
// abilityRange, mirroring the server's cooldown override in abilities.ts.
function abilityCooldownTicks(def: AbilityDef, rank?: number): number {
  const myRank = rank ?? state.self?.components.knownAbilities?.[def.id] ?? 1;
  const row = def.ranks?.find((r) => r.rank === myRank) ?? def.ranks?.[0];
  return row?.cooldown_ticks ?? def.cast.cooldown_ticks;
}

// Per-ability client-side cooldown tracking (visual only; server is authoritative).
const abilityLastCast = new Map<string, number>();
const abilityCdDuration = new Map<string, number>();
const abilityCdOverlays = new Map<string, HTMLElement>();
const abilitySlotEls = new Map<string, HTMLElement>();

// One queued ability: pressing an ability while the global cooldown is active
// stores it here instead of dropping it, so auto-attack (which keeps re-arming
// the GCD) can't perpetually eat your casts. The frame loop fires it the instant
// the GCD clears, ahead of the next auto-attack. Last press wins.
let queuedAbilityId: string | null = null;
function setQueuedAbility(id: string | null): void {
  if (queuedAbilityId === id) return;
  if (queuedAbilityId) abilitySlotEls.get(queuedAbilityId)?.classList.remove('hb-queued');
  queuedAbilityId = id;
  if (id) abilitySlotEls.get(id)?.classList.add('hb-queued');
}

function castAbility(abilityId: string): void {
  const now = performance.now();
  const def = state.abilityDefs?.[abilityId];
  const cdMs = def ? abilityCooldownTicks(def) * 100 : 1000;
  const lastCast = abilityLastCast.get(abilityId) ?? 0;
  // The ability's own cooldown is still ticking — it isn't usable yet, so there's
  // nothing to queue.
  if (now - lastCast < cdMs) return;

  const manaCost = def?.cast.cost?.mana ?? 0;
  if (manaCost > 0 && (state.self?.components?.mana?.current ?? 0) < manaCost) return;

  // Ground-targeted cast (e.g. blink): arm the spell instead of firing now —
  // the next canvas click supplies the target tile (see the click handler).
  if (def?.targeting.shape === 'point') { setAbilityArmed(abilityId); return; }

  // Blocked only by the global cooldown: queue it to fire the moment the GCD ends.
  if (now < gcdUntil) { setQueuedAbility(abilityId); return; }

  commitCast(abilityId);
}

// Fire an ability now: burn its cooldown/GCD, flash the slot, and send it. A
// ground-targeted cast passes (tx,ty); otherwise the current selected target.
function commitCast(abilityId: string, tx?: number, ty?: number): void {
  const now = performance.now();
  const def = state.abilityDefs?.[abilityId];
  const cdMs = def ? abilityCooldownTicks(def) * 100 : 1000;

  setQueuedAbility(null);
  abilityLastCast.set(abilityId, now);
  abilityCdDuration.set(abilityId, cdMs);
  triggerGcd(now);

  const slotEl = abilitySlotEls.get(abilityId);
  if (slotEl) {
    slotEl.classList.remove('hb-flash');
    void slotEl.offsetWidth; // reflow to restart animation
    slotEl.classList.add('hb-flash');
    setTimeout(() => slotEl.classList.remove('hb-flash'), 200);
  }

  cancelAutopath();
  const groundCast = tx !== undefined && ty !== undefined;
  state.sendAbility?.(abilityId, groundCast ? undefined : (selectedTargetId ?? undefined), tx, ty);
  // An offensive cast on a mob also flips auto-attack on, so you keep swinging
  // after the spell lands (heals / self-buffs leave engagement untouched).
  if (def?.effects.some(ef => ef.kind === 'damage')) {
    const t = selectedTargetId ? state.zone?.entities.find(e => e.id === selectedTargetId) : null;
    if (isSelectableMob(t)) engaged = true;
  }
}

// The server rejected a cast (out of range, dead target, etc). The client casts
// optimistically (flashing the slot + arming the GCD before the server validates),
// so on rejection we roll that back — clear the failed ability's local cooldown
// and the GCD — and float the reason above the player. Range is the common case:
// the client doesn't range-check, so a too-far cast only fails server-side.
const CAST_FAIL_MESSAGES: Record<CastFailure, string> = {
  no_target: 'No target in range',
  mana: 'Not enough mana',
  cooldown: 'Not ready',
  not_learned: 'Not learned',
  stunned: 'Stunned!',
  silenced: 'Silenced!',
};
interface CastFailFloat { text: string; t: number }
const castFailFloats: CastFailFloat[] = [];
function onCastFailed(ev: CastFailedEvent): void {
  abilityLastCast.delete(ev.abilityId); // clear the optimistic per-ability cooldown
  if (queuedAbilityId === ev.abilityId) setQueuedAbility(null);
  gcdUntil = 0;                          // release the GCD so the player can retry at once
  castFailFloats.push({ text: CAST_FAIL_MESSAGES[ev.reason] ?? 'Cast failed', t: performance.now() });
}
window.addEventListener('mmo:cast_failed', (e) => onCastFailed((e as CustomEvent<CastFailedEvent>).detail));

// Ability slots (hotbar keys 1..9). The layout comes from resolveHotbar — a
// player's stored custom bar, or the derived default when they haven't edited
// it. Rebuilt when the resolved layout, ranks, or edit mode changes.
let abilitySlotSig = '';
const abilitySlots: HTMLElement[] = [];

// An in-flight drag: a skill dragged from the Skills panel, or a hotbar slot
// dragged onto another. Null when nothing is being dragged.
type HbDrag = { kind: 'skill'; abilityId: string } | { kind: 'slot'; index: number };
let hbDrag: HbDrag | null = null;

// The current 9-length ability-slot layout (index 0 = slot key "1").
function currentHotbarLayout(): (string | null)[] {
  const self = state.self;
  if (!self) return new Array(ABILITY_SLOTS).fill(null);
  return resolveHotbar(self.components.knownAbilities ?? {}, self.klass, self.components.hotbar);
}

// Persist a new layout: optimistic local update + server save, reverting if the
// server rejects it.
function applyHotbar(next: (string | null)[]): void {
  const self = state.self;
  if (!self) return;
  const prev = self.components.hotbar;
  self.components.hotbar = next;
  renderAbilitySlots();
  void state.sendHotbar(next).then((r) => {
    if (!r.ok && state.self) { state.self.components.hotbar = prev; renderAbilitySlots(); }
  });
}

function clearDropHighlights(): void {
  for (const el of abilitySlots) el.classList.remove('hb-droptarget');
}

function clearHotbarSlot(index: number): void {
  const next = currentHotbarLayout();
  if (!next[index]) return;
  next[index] = null;
  applyHotbar(next);
}

function dropOnSlot(targetIndex: number): void {
  if (!hbDrag) return;
  const next = currentHotbarLayout();
  if (hbDrag.kind === 'skill') {
    const id = hbDrag.abilityId;
    // An ability lives in at most one slot — pull it from wherever it was.
    for (let i = 0; i < next.length; i++) if (next[i] === id) next[i] = null;
    next[targetIndex] = id;
  } else {
    const from = hbDrag.index;
    if (from === targetIndex) { hbDrag = null; return; }
    [next[from], next[targetIndex]] = [next[targetIndex], next[from]];
  }
  hbDrag = null;
  applyHotbar(next);
}

function renderAbilitySlots(): void {
  const self = state.self;
  const layout = currentHotbarLayout();
  const editing = skillsOpen();
  // Show slots up to the last bound one; while editing show all 9 so every slot
  // is an available drop target.
  let lastBound = -1;
  for (let i = 0; i < layout.length; i++) if (layout[i]) lastBound = i;
  const count = editing ? ABILITY_SLOTS : lastBound + 1;

  // Include rank (icon redraw on rank-up) and edit mode in the sig.
  const sig = `${editing ? 'e' : 'v'}|${layout.slice(0, count)
    .map((id) => `${id ?? ''}:${id ? self?.components.knownAbilities?.[id] ?? 0 : 0}`)
    .join(',')}`;
  if (sig === abilitySlotSig) return;
  abilitySlotSig = sig;
  for (const el of abilitySlots) el.remove();
  abilitySlots.length = 0;
  abilityCdOverlays.clear();
  abilitySlotEls.clear();

  for (let i = 0; i < count; i++) {
    const id = layout[i];
    const slot = document.createElement('div');
    slot.className = 'hb-slot hb-ability' + (id ? '' : ' hb-empty');

    const keyEl = document.createElement('span');
    keyEl.className = 'hb-key';
    keyEl.textContent = String(i + 1);
    slot.appendChild(keyEl);

    if (id) {
      const def = state.abilityDefs?.[id];
      const rank = self?.components.knownAbilities?.[id] ?? 1;
      let iconEl: HTMLElement | HTMLCanvasElement;
      if (def) {
        const c = document.createElement('canvas');
        c.className = 'hb-icon-canvas';
        c.width = 32;
        c.height = 32;
        drawAbilityIcon(c, def, rank);
        iconEl = c;
      } else {
        const sp = document.createElement('span');
        sp.className = 'hb-icon';
        sp.textContent = '✦';
        iconEl = sp;
      }

      const labelEl = document.createElement('span');
      labelEl.className = 'hb-label';
      labelEl.textContent = prettifyAbility(id);

      const manaCost = def?.cast.cost?.mana;
      const manaBadge = document.createElement('span');
      manaBadge.className = 'hb-mana-cost';
      manaBadge.textContent = manaCost ? String(manaCost) : '';

      const cdOverlay = document.createElement('div');
      cdOverlay.className = 'hb-cd-overlay';

      slot.appendChild(iconEl);
      slot.appendChild(labelEl);
      slot.appendChild(manaBadge);
      slot.appendChild(cdOverlay);
      slot.addEventListener('click', () => castAbility(id));
      // Drag a bound slot onto another to move/swap; right-click to clear.
      slot.draggable = true;
      slot.addEventListener('dragstart', (e) => {
        hbDrag = { kind: 'slot', index: i };
        e.dataTransfer?.setData('text/plain', id);
        slot.classList.add('sk-dragging');
      });
      slot.addEventListener('dragend', () => { hbDrag = null; slot.classList.remove('sk-dragging'); clearDropHighlights(); });
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); clearHotbarSlot(i); });

      abilityCdOverlays.set(id, cdOverlay);
      abilitySlotEls.set(id, slot);
    }

    // Every slot (bound or empty) is a drop target.
    slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('hb-droptarget'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('hb-droptarget'));
    slot.addEventListener('drop', (e) => { e.preventDefault(); slot.classList.remove('hb-droptarget'); dropOnSlot(i); });

    hotbar.insertBefore(slot, hbPotion);
    abilitySlots.push(slot);
  }
}

// Slot 0 names the attack you're actually making — "Bolt", "Swing", "Unarmed
// Strike" — rather than a generic "Attack", and draws that ability's own
// proc-gen icon like every other slot on the bar. The weapon supplying it is the
// subtitle, and the badge carries the reach, so a ranged attack announces itself
// instead of the player inferring it from not walking into melee.
//
// Keyed so the DOM is only touched when the attack, weapon or reach changes;
// updateHotbar runs every frame.
let attackSlotKey = '';
function updateAttackSlot(): void {
  const mainhand = state.self?.components?.equipment?.mainhand ?? null;
  const def = selfAttackAbility();
  const reach = selfAttackRange();
  const rarity = mainhand?.item?.components?.equipment?.rarity as string | undefined;
  const brand = mainhand?.item?.components?.equipment?.rolled?.weapon_brand as string | undefined;
  // Base and brand, not just the display name: they're what change the icon,
  // and two weapons can share a name while differing in both.
  const key = `${def?.id ?? ''}|${mainhand?.base ?? ''}|${mainhand?.name ?? ''}|${reach}|${rarity ?? ''}|${brand ?? ''}`;
  if (key === attackSlotKey) return;
  attackSlotKey = key;

  hbAttackIcon.replaceChildren();
  // Slot 0 is whatever you're holding, so show the weapon itself when it has
  // art — the same icon the bag and the character's hand show. The proc-gen
  // ability glyph stays the fallback: unarmed has no weapon to draw, and
  // neither does an archetype nobody has drawn yet.
  const weaponIcon = mainhand ? itemIconEl(mainhand, 34) : null;
  if (weaponIcon) {
    hbAttackIcon.appendChild(weaponIcon);
  } else if (def) {
    const c = document.createElement('canvas');
    c.className = 'hb-icon-canvas';
    c.width = 32;
    c.height = 32;
    drawAbilityIcon(c, def, 1);
    hbAttackIcon.appendChild(c);
  } else {
    hbAttackIcon.textContent = '⚔'; // defs not loaded yet
  }
  // The weapon is the subtitle: the ability names what you do, and an equipped
  // weapon is what decides it, so seeing both is what makes the link legible.
  hbAttackLabel.textContent = mainhand?.name || def?.name || 'Unarmed';
  hbAttackLabel.style.color = rarity ? rarityColor(rarity) : '';
  hbAttackReach.textContent = reach > 1 ? `${reach}` : '';
  hbAttack.title = def
    ? `${def.name} — ${reach > 1 ? `reaches ${reach} tiles` : 'melee'}`
    : 'Attack';
}

function updateHotbar(): void {
  if (!state.self) {
    hotbar.classList.remove('visible');
    return;
  }
  hotbar.classList.add('visible');
  renderAbilitySlots();
  hbAttack.classList.toggle('engaged', engaged);
  updateAttackSlot();
  const now = performance.now();

  // Shared global cooldown: any cast sweeps every slot until it elapses.
  const gcdFraction = now < gcdUntil ? (gcdUntil - now) / GCD_MS : 0;

  // Attack cooldown overlay shrinks from top as cooldown expires (or the GCD,
  // whichever is longer — e.g. when an ability cast triggered the lockout).
  const atkElapsed = now - lastAttackAt;
  const atkCd = attackCooldownMs();
  const atkFraction = atkElapsed < atkCd ? (atkCd - atkElapsed) / atkCd : 0;
  hbAttackCd.style.transform = `scaleY(${Math.max(atkFraction, gcdFraction).toFixed(3)})`;

  // Potion slot: reflect first consumable in inventory
  const consumable = findFirstConsumable();
  if (consumable) {
    hbPotion.classList.remove('empty');
    hbPotionLabel.textContent = consumable.stack.name || 'Potion';
  } else {
    hbPotion.classList.add('empty');
    hbPotionLabel.textContent = '—';
  }

  // Potion cooldown overlay
  const potionFraction = now < potionCooldownUntil
    ? (potionCooldownUntil - now) / POTION_COOLDOWN_MS : 0;
  hbPotionCd.style.transform = `scaleY(${potionFraction.toFixed(3)})`;

  // Per-ability cooldown overlays and OOM dimming
  const currentMana = state.self?.components?.mana?.current ?? 0;
  // Instant-cast (non-ground-target) abilities fire at whatever's currently
  // selected — flag the slot the moment that target drifts out of the
  // ability's own range, instead of only finding out via a failed-cast toast.
  // Ground-target abilities (blink) get live range feedback via the armed
  // cursor/tile highlight instead, since they aren't tied to a fixed target.
  const rangeTarget = selectedTargetId ? state.zone?.entities.find(e => e.id === selectedTargetId) : null;
  for (const [id, cdEl] of abilityCdOverlays) {
    const lastCast = abilityLastCast.get(id) ?? 0;
    const cdMs = abilityCdDuration.get(id) ?? 0;
    const elapsed = now - lastCast;
    const ownFraction = elapsed < cdMs ? (cdMs - elapsed) / cdMs : 0;
    const fraction = Math.max(ownFraction, gcdFraction);
    cdEl.style.transform = `scaleY(${fraction.toFixed(3)})`;
    const slotEl = abilitySlotEls.get(id);
    if (slotEl) {
      const manaCost = state.abilityDefs?.[id]?.cast.cost?.mana ?? 0;
      slotEl.classList.toggle('oom', fraction === 0 && manaCost > 0 && currentMana < manaCost);
      const def = state.abilityDefs?.[id];
      const outOfRange = !!def && def.targeting.shape !== 'point' && !!rangeTarget && !!state.self
        && chebyshev(state.self.position.x, state.self.position.y, rangeTarget.position.x, rangeTarget.position.y) > abilityRange(id);
      slotEl.classList.toggle('oor', outOfRange);
    }
  }
}

function updatePlayerFrame(): void {
  const self = state.self;
  if (!self) { playerFrame.classList.remove('visible'); return; }
  playerFrame.classList.add('visible');
  pfPortrait.style.background = self.color || '#6ec6f0';
  pfName.textContent = self.name || 'Player';
  pfLevel.textContent = String(self.components?.progress?.level ?? 1);

  const hp = self.components?.health;
  if (hp) {
    pfHpFill.style.width = `${Math.max(0, (hp.current / hp.max) * 100).toFixed(1)}%`;
    pfHpText.textContent = `${Math.max(0, hp.current)}/${hp.max}`;
  }
  const mp = self.components?.mana;
  if (mp && mp.max > 0) {
    pfMpFill.style.width = `${Math.max(0, (mp.current / mp.max) * 100).toFixed(1)}%`;
    pfMpText.textContent = `${Math.max(0, mp.current)}/${mp.max}`;
  } else {
    pfMpFill.style.width = '0%';
    pfMpText.textContent = '0/0';
  }

  const prog = self.components?.progress;
  if (prog) {
    const pct = Math.min(100, (prog.xp / xpForNext(prog.level)) * 100);
    pfXpFill.style.width = `${pct.toFixed(1)}%`;
    pfXpText.textContent = `${Math.floor(pct)}%`;
  }

  renderStatusRow(pfStatus, self.components?.modifiers);
}

function updateTargetFrame(): void {
  const target = selectedTargetId && state.zone
    ? state.zone.entities.find(e => e.id === selectedTargetId)
    : null;
  // Selection only survives on a live mob — when it dies/despawns the frame hides
  // and engagement drops.
  if (!isSelectableMob(target)) {
    if (selectedTargetId) { selectedTargetId = null; engaged = false; }
    targetFrame.classList.remove('visible');
    return;
  }
  targetFrame.classList.add('visible');
  targetFrame.classList.toggle('friendly', !!target.npc);

  // Show the mob's actual sprite, falling back to its tint when it has none.
  if (target.sprite) {
    tfPortrait.style.backgroundImage = `url(/sprites/${target.sprite}.png)`;
    tfPortrait.style.backgroundColor = '#1a160e';
  } else {
    tfPortrait.style.backgroundImage = 'none';
    tfPortrait.style.backgroundColor = target.color || '#888';
  }
  tfName.textContent = target.name || target.type;
  if (target.level != null) { tfLevel.textContent = String(target.level); tfLevel.style.display = ''; }
  else tfLevel.style.display = 'none';

  const hp = (target.components as { health?: { current: number; max: number } })?.health;
  if (hp) {
    tfHpFill.style.width = `${Math.max(0, (hp.current / hp.max) * 100).toFixed(1)}%`;
    tfHpText.textContent = `${Math.max(0, hp.current)}/${hp.max}`;
  } else {
    tfHpFill.style.width = '100%';
    tfHpText.textContent = '';
  }

  const mp = (target.components as { mana?: { current: number; max: number } })?.mana;
  if (mp && mp.max > 0) {
    tfMpRow.style.display = '';
    tfMpFill.style.width = `${Math.max(0, (mp.current / mp.max) * 100).toFixed(1)}%`;
    tfMpText.textContent = `${Math.max(0, mp.current)}/${mp.max}`;
  } else {
    tfMpRow.style.display = 'none';
  }

  renderStatusRow(tfStatus, (target.components as { modifiers?: TimedModifier[] })?.modifiers);
}

hbAttack.addEventListener('click', () => {
  if (!state.self) return;
  // With a unit selected, toggle auto-attack engagement on it. With nothing
  // selected, arm target-selection: the next map click picks a mob (NPCs too)
  // and immediately engages it.
  const t = selectedTargetId ? state.zone?.entities.find(e => e.id === selectedTargetId) : null;
  if (isSelectableMob(t)) {
    if (engaged) engaged = false;
    else engageSelected();
    return;
  }
  setAttackArmed(!attackArmed);
});

hbPotion.addEventListener('click', () => {
  const consumable = findFirstConsumable();
  if (!consumable) return;
  const now = performance.now();
  if (now < potionCooldownUntil) return;
  potionCooldownUntil = now + POTION_COOLDOWN_MS;
  void state.sendUseItem?.(consumable.slot);
});

interface Pick {
  tile: { x: number; y: number } | null;
  entity: EntitySnapshot | null;
}

function pickAt(clientX: number, clientY: number): Pick {
  if (!state.zone) return { tile: null, entity: null };
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const cx = (clientX - rect.left) * sx;
  const cy = (clientY - rect.top) * sy;
  const rawTx = Math.floor((cx - lastCamera.offsetX) / TILE);
  const rawTy = Math.floor((cy - lastCamera.offsetY) / TILE);
  const z = state.zone;
  const wild = isWild();
  // Wilderness coords are signed + unbounded; enclosed zones clamp to the grid.
  const tx = wild ? rawTx : Math.max(0, Math.min(z.width  - 1, rawTx));
  const ty = wild ? rawTy : Math.max(0, Math.min(z.height - 1, rawTy));
  const tile = { x: tx, y: ty };
  let entity: EntitySnapshot | null = null;
  const rank = (e: EntitySnapshot) =>
    (e.type === 'ground_item' || e.type === 'corpse') ? 0 : e.type === 'player' ? 2 : 1;
  // z.entities is kept pointing at the flattened per-chunk list by render(), so
  // there's no need to re-flatten it here (pickAt runs every frame).
  for (const e of z.entities) {
    if (e.position.x !== tx || e.position.y !== ty) continue;
    if (!entity || rank(e) >= rank(entity)) entity = e;
  }
  return { tile, entity };
}

function updateTooltip(): void {
  if (!hoveredEntity) { tooltipEl.classList.remove('open'); return; }
  const snap = hoveredEntity;
  tooltipEl.innerHTML = '';
  const name = document.createElement('div');
  name.className = 'tt-name';
  name.textContent = snap.name || snap.type;
  if (snap.type === 'ground_item' && snap.item?.components?.equipment?.rarity) {
    name.style.color = rarityColor(snap.item.components.equipment.rarity as string);
  }
  tooltipEl.appendChild(name);
  if (snap.type === 'mob' && snap.level != null && !snap.fixture) {
    const lvl = document.createElement('div');
    lvl.className = 'tt-level';
    lvl.textContent = `Level ${snap.level}`;
    tooltipEl.appendChild(lvl);
  }
  const hp = (snap.components as { health?: { current: number; max: number } } | undefined)?.health;
  if (hp && typeof hp.current === 'number' && typeof hp.max === 'number' && !snap.fixture) {
    const track = document.createElement('div');
    track.className = 'tt-hp-track';
    const fill = document.createElement('div');
    fill.className = 'tt-hp-fill';
    const pct = Math.max(0, Math.min(1, hp.current / Math.max(1, hp.max)));
    fill.style.width = `${pct * 100}%`;
    fill.style.background = pct > 0.5 ? '#5acc5a' : pct > 0.25 ? '#cc8a3a' : '#cc3a3a';
    track.appendChild(fill);
    tooltipEl.appendChild(track);
    const txt = document.createElement('div');
    txt.className = 'tt-hp-text';
    txt.textContent = `HP ${hp.current} / ${hp.max}`;
    tooltipEl.appendChild(txt);
  }
  if (isTalkTarget(snap)) {
    const q = document.createElement('div');
    q.className = 'tt-quest';
    q.style.color = '#7acdf5';
    q.textContent = '? Quest return';
    tooltipEl.appendChild(q);
  } else if (isQuestgiver(snap)) {
    const q = document.createElement('div');
    q.className = 'tt-quest';
    q.textContent = '! Has a quest';
    tooltipEl.appendChild(q);
  }
  if (snap.hasShop) {
    const shopEl = document.createElement('div');
    shopEl.className = 'tt-quest';
    shopEl.style.color = '#ffd84a';
    shopEl.textContent = '$ Shop';
    tooltipEl.appendChild(shopEl);
  }
  if (snap.type === 'corpse') {
    const hasLoot = (snap.loot?.length ?? 0) > 0;
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = hasLoot ? 'Click to loot' : 'Empty';
    tooltipEl.appendChild(hint);
  } else if (snap.signText?.length) {
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = 'Click to read';
    tooltipEl.appendChild(hint);
  } else if (snap.boardId) {
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = 'Click to read & post';
    tooltipEl.appendChild(hint);
  } else if (snap.hasShop || hasQuestInteraction(snap)) {
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = snap.hasShop && !hasQuestInteraction(snap) ? 'Click to trade' : 'Click to talk';
    tooltipEl.appendChild(hint);
  }
  tooltipEl.classList.add('open');
  repositionTooltip();
}

function repositionTooltip(): void {
  if (!tooltipEl.classList.contains('open')) return;
  const pad = 14;
  const rect = tooltipEl.getBoundingClientRect();
  let x = mousePx.x + pad;
  let y = mousePx.y + pad;
  if (x + rect.width > window.innerWidth)  x = mousePx.x - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = mousePx.y - rect.height - pad;
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y}px`;
}

canvas.addEventListener('mousemove', (e) => {
  mousePx = { x: e.clientX, y: e.clientY };
  const p = pickAt(e.clientX, e.clientY);
  hoveredTile = p.tile;
  const changed = p.entity?.id !== hoveredEntity?.id;
  hoveredEntity = p.entity;
  if (changed) updateTooltip();
  else if (p.entity) repositionTooltip();
  updateTargetingCursor();
});
canvas.addEventListener('wheel', (e) => {
  // Always preventDefault: an unhandled wheel over the canvas is either page
  // scroll or (with ctrl/⌘ held, which is how a trackpad pinch arrives) browser
  // zoom, and both fight this one.
  e.preventDefault();
  // Firefox reports lines and pages; normalise to something px-like first.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  // A trackpad can deliver one enormous delta; cap it so a flick can't slam
  // into the stop in a single frame.
  const delta = Math.max(-120, Math.min(120, e.deltaY * unit));
  camZoomVel -= delta * ZOOM_IMPULSE;
}, { passive: false });

canvas.addEventListener('mouseleave', () => {
  hoveredEntity = null;
  hoveredTile = null;
  tooltipEl.classList.remove('open');
  updateTargetingCursor();
});
function hasQuestInteraction(snap: EntitySnapshot): boolean {
  if (snap.type !== 'mob') return false;
  return isQuestgiver(snap) || isRepeatableQuestgiver(snap) || isTalkTarget(snap);
}

// ─── Click-to-walk ────────────────────────────────────────────────────────

interface PathStep { x: number; y: number }
let autopathDest: PathStep | null = null;

function cancelAutopath(): void { autopathDest = null; autopathIsChase = false; }
// Whether the active autopath is the auto-attack chase closing on a target, or a
// move the player ordered themselves. The chase must not re-issue itself over a
// player's own move order — that is what would drag a repositioning caster back
// into melee — so it yields while a self-issued path is running.
let autopathIsChase = false;

function isWalkable(tx: number, ty: number): boolean {
  const z = state.zone;
  if (!z) return false;
  if (isWild()) return wildWalkable(tx, ty); // signed coords, infinite — no bounds
  if (tx < 0 || ty < 0 || tx >= z.width || ty >= z.height) return false;
  return !BLOCKING_TILES.has(z.grid[ty]![tx]!);
}

function nearestWalkable(tx: number, ty: number, opts: { excludeSelf?: boolean } = {}): PathStep | null {
  if (!opts.excludeSelf && isWalkable(tx, ty)) return { x: tx, y: ty };
  for (let r = 1; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = tx + dx, ny = ty + dy;
        if (isWalkable(nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}

const MOB_POKE_COOLDOWN_MS = 5000;
const mobPokeLastAt = new Map<string, number>();
// Approach-then-talk target (NPC clicked out of range) and explicit attack-arm
// state (set by the Attack hotbar button so the next click picks a combat target).
let pendingTalkId: string | null = null;
let attackArmed = false;
function pokeMob(entity: EntitySnapshot): void {
  const now = Date.now();
  const last = mobPokeLastAt.get(entity.id) ?? 0;
  if (now - last < MOB_POKE_COOLDOWN_MS) return;
  mobPokeLastAt.set(entity.id, now);
  state.sendPokeMob(entity.id);
}
function setAttackArmed(on: boolean): void {
  attackArmed = on;
  hbAttack.classList.toggle('armed', on);
  // Attack and a ground-target cast can't both be armed — one cursor mode.
  if (on && abilityArmed) {
    abilityArmed = null;
    for (const el of abilitySlotEls.values()) el.classList.remove('armed');
  }
  updateTargetingCursor();
}

// A ground-targeted ability is armed and waiting for a click to supply its tile.
let abilityArmed: string | null = null;
function setAbilityArmed(id: string | null): void {
  if (id) setAttackArmed(false); // mutually exclusive with attack-armed
  abilityArmed = id;
  for (const [aid, el] of abilitySlotEls) el.classList.toggle('armed', aid === id);
  updateTargetingCursor();
}

// While an ability or the Attack button is armed, the cursor doubles as a live
// range check against whatever's currently under it — 'not-allowed' the moment
// the hovered tile/mob is farther than the armed ability can reach, so a miss
// is obvious before you click instead of only after the server rejects it.
function updateTargetingCursor(): void {
  if (!abilityArmed && !attackArmed) { canvas.style.cursor = ''; return; }
  const self = state.self;
  if (abilityArmed) {
    const range = abilityRange(abilityArmed);
    const inRange = !!self && !!hoveredTile
      && chebyshev(self.position.x, self.position.y, hoveredTile.x, hoveredTile.y) <= range;
    canvas.style.cursor = inRange ? 'crosshair' : 'not-allowed';
    return;
  }
  // attackArmed (basic attack): only flag out-of-range once a valid mob is
  // actually under the cursor — empty ground stays neutral.
  const outOfRange = !!self && isSelectableMob(hoveredEntity)
    && chebyshev(self.position.x, self.position.y, hoveredEntity.position.x, hoveredEntity.position.y) > selfAttackRange();
  canvas.style.cursor = outOfRange ? 'not-allowed' : 'crosshair';
}

canvas.addEventListener('click', (e) => {
  const { tile, entity } = pickAt(e.clientX, e.clientY);
  if (!tile) return;
  const self = state.self;
  if (!self) return;
  // Ground-targeted cast armed (e.g. blink): the next click supplies the tile.
  if (abilityArmed) {
    if (performance.now() < gcdUntil) return; // still on GCD — stay armed, wait it out
    const id = abilityArmed;
    setAbilityArmed(null);
    commitCast(id, tile.x, tile.y);
    return;
  }
  if (entity && entity.id === state.entityId) return;
  // Explicit attack mode (armed by the Attack hotbar button): the next click
  // picks any non-fixture mob — including NPCs — and immediately engages it,
  // bypassing the talk/shop interactions below.
  if (attackArmed) {
    setAttackArmed(false);
    if (isSelectableMob(entity)) { selectTarget(entity.id); engageSelected(); }
    return;
  }
  // A plain click on any mob (friendly or hostile) selects it as the current
  // target — shown in the target frame. NPCs additionally interact below;
  // hostiles are select-only (engage via Attack / Space / an offensive ability).
  if (isSelectableMob(entity)) selectTarget(entity.id);
  if (entity && hasQuestInteraction(entity)
      && chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
    openQuestgiver(entity);
    return;
  }
  if (entity && entity.hasShop
      && chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
    void openTrade(entity);
    return;
  }
  if (entity && entity.trainerClass
      && chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
    void openTrainer(entity);
    return;
  }
  if (entity && entity.type === 'corpse') {
    if ((entity.loot?.length ?? 0) === 0) return;
    if (chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
      openLoot(entity);
      return;
    }
    // Autopath toward corpse, open loot when close enough
    const dest = nearestWalkable(tile.x, tile.y);
    if (dest && (dest.x !== self.position.x || dest.y !== self.position.y)) {
      autopathDest = dest;
      state.sendAutopath(dest.x, dest.y);
    }
    return;
  }
  if (entity && entity.signText?.length) {
    openSign(entity);
    return;
  }
  if (entity && entity.boardId) {
    void openBoard(entity);
    return;
  }
  // NPCs (and fixtures) default to dialogue, never combat on a plain click.
  // In range → talk; out of range → walk over and talk on arrival (NPCs only —
  // fixtures aren't chased). Combat on an NPC requires the Attack button/Space.
  if (entity && entity.type === 'mob' && (entity.npc || entity.fixture)) {
    pendingTalkId = null;
    if (chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
      pokeMob(entity);
    } else if (entity.npc) {
      pendingTalkId = entity.id;
      const dst = nearestWalkable(tile.x, tile.y, { excludeSelf: true });
      if (dst && (dst.x !== self.position.x || dst.y !== self.position.y)) { autopathDest = dst; state.sendAutopath(dst.x, dst.y); }
    }
    return;
  }
  // A hostile mob was just selected above — select-only, no auto-walk into melee.
  if (isSelectableMob(entity)) return;
  // Open ground: walk there, keeping the current target selected AND engaged
  // (WoW-style). Engagement used to drop here, because the chase loop below would
  // otherwise path us straight back into melee — but for a ranged attacker
  // repositioning while staying in range is the whole point, so instead the
  // chase yields to a self-issued path (autopathIsChase) and auto-attack simply
  // keeps firing whenever the target is in reach. Walk out of reach and it stops
  // without hauling you back; walk in again and it resumes.
  const dest = nearestWalkable(tile.x, tile.y);
  if (!dest) return;
  if (dest.x === self.position.x && dest.y === self.position.y) return;
  autopathDest = dest;
  autopathIsChase = false;
  state.sendAutopath(dest.x, dest.y);
});

// Double-click a mob to select and immediately engage it (walk into melee +
// auto-attack), the one-gesture equivalent of clicking it then pressing Attack.
canvas.addEventListener('dblclick', (e) => {
  if (state.died) return;
  const { entity } = pickAt(e.clientX, e.clientY);
  if (!entity || entity.id === state.entityId) return;
  if (isSelectableMob(entity)) { selectTarget(entity.id); engageSelected(); }
});

const TALK_RANGE = 2;
function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

ctx.imageSmoothingEnabled = false;

const KEY_TO_DIR: Record<string, 'north' | 'south' | 'east' | 'west'> = {
  ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east',
  w: 'north', s: 'south', a: 'west', d: 'east',
  W: 'north', S: 'south', A: 'west', D: 'east',
};

let lastSentDir: string | null = null;
let lastSentAt = 0;
const MOVE_COOLDOWN_MS = 100;
// The interval the server will actually enforce between basic attacks, mirrored
// through the shared cadence formula. This was a flat 1500ms, which stopped
// being true once a weapon's swing rate joined the formula: a 0.9-speed staff
// swings every 1.7s, so the client fired a request every 1.5s and the server
// dropped the ones that landed early — a wizard whose cooldown ring said ready
// but whose attacks silently went nowhere.
function attackCooldownMs(): number {
  return actTicks(PLAYER_BASE_ACT_TICKS, combatSpeed()) * TICK_MS;
}
let lastAttackAt = 0;
// Global cooldown: the server gates basic attack + every ability through one
// shared GCD (GCD_TICKS in loop.ts) that's shorter than the attack interval, so
// abilities weave between auto-attack swings. We mirror it here so casting one
// thing visibly locks the rest until the server would accept the next action —
// otherwise idle-looking slots silently drop casts.
const GCD_MS = 800; // mirrors server GCD_TICKS = 8 × 100ms
let gcdUntil = 0;
function triggerGcd(now: number): void { gcdUntil = now + GCD_MS; }
// WoW-vanilla selection: `selectedTargetId` is the unit you've clicked (any mob,
// friendly or hostile) — it drives the target frame, the on-canvas highlight and
// the default target for abilities. `engaged` is the separate auto-attack toggle:
// selecting a unit never swings at it; you engage explicitly via Attack / Space /
// an offensive ability, and switching target turns engagement back off.
let selectedTargetId: string | null = null;
let engaged = false;
let lastChaseAt = 0;
// The ability we attack with: whatever the mainhand names, else unarmed. Mirrors
// the server's attackAbilityFor by resolving the same id against the ability
// defs the client already fetches (/api/abilities), so the two never disagree
// about reach — which would show up as walking into melee for no reason, or
// standing still firing attacks the server rejects.
function selfAttackAbility(): AbilityDef | null {
  const defs = state.abilityDefs;
  const mainhand = state.self?.components?.equipment?.mainhand;
  if (!mainhand) return defs?.[UNARMED_ATTACK_ID] ?? null;
  // Stamped onto the stack from its base by makeStack — the client has no item
  // defs of its own, and the server resolves the base directly regardless.
  const named = mainhand.attack_ability;
  return (named ? defs?.[named] : undefined)
    ?? defs?.[WEAPON_ATTACK_ID]
    ?? defs?.[UNARMED_ATTACK_ID]
    ?? null;
}
// Melee until the defs load — the safe default, since guessing long would send
// the player standing still out of range of a swing that can't land.
function selfAttackRange(): number {
  return selfAttackAbility()?.targeting.range ?? 1;
}
function isSelectableMob(e: EntitySnapshot | null | undefined): e is EntitySnapshot {
  return !!e && e.type === 'mob' && !e.fixture;
}
function selectTarget(id: string | null): void {
  if (selectedTargetId === id) return;
  selectedTargetId = id;
  engaged = false; // a fresh selection starts un-engaged — press Attack to fight
}
function engageSelected(): void {
  const t = selectedTargetId ? state.zone?.entities.find(e => e.id === selectedTargetId) : null;
  if (!isSelectableMob(t)) return;
  engaged = true;
  const self = state.self;
  if (self && chebyshev(self.position.x, self.position.y, t.position.x, t.position.y) > selfAttackRange()) {
    const dst = nearestWalkable(t.position.x, t.position.y, { excludeSelf: true });
    if (dst && (dst.x !== self.position.x || dst.y !== self.position.y)) {
      autopathDest = dst; autopathIsChase = true; state.sendAutopath(dst.x, dst.y, t.id);
    }
  }
}
let lastCombatAt = 0;
const IN_COMBAT_TTL_MS = 8000;
const POTION_COOLDOWN_MS = 3000;
let potionCooldownUntil = 0;
const FLOAT_TTL_MS = 900;
// Deliberately far shorter than FLOAT_TTL_MS: the dart should read as fast and
// be gone before the damage number it delivers has finished rising.
const TRACER_TTL_MS = 180;
const RESPAWN_DELAY_MS = 10_000;
const XP_FLOAT_TTL_MS = 1400;
const LEVEL_UP_TTL_MS = 1800;
const SPEECH_TTL_MS = 4500;
const CHAT_LOG_TTL_MS = 12000;
const ZONE_BANNER_TTL_MS = 2500;


function chatFocused(): boolean { return document.activeElement === chatInput; }
function anyInputFocused(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
function sheetOpen(): boolean { return sheetBackdrop.classList.contains('open'); }

function effectiveDamageRange(self: PlayerEntity): Range {
  const stats = self.components?.stats || {};
  const mainhand = self.components?.equipment?.mainhand;
  const rolled = mainhand?.item?.components?.equipment?.rolled as RolledStats | undefined;
  // Roll first, then the base's own profile, then bare hands — mirroring the
  // server's baseDamageRange/damageBonus, which fall back to the ItemBase for a
  // weapon that carries no roll (a shop staple, a /give). The base's fields ride
  // along on the stack because the client has no item defs of its own.
  const base: Range = Array.isArray(rolled?.damage)
    ? rolled.damage
    : (mainhand?.base_damage ?? (Array.isArray(stats.damage) ? stats.damage : [0, 0]));
  const scaling = rolled?.scaling ?? mainhand?.base_scaling;
  let bonus = 0;
  if (scaling) {
    for (const [stat, letter] of Object.entries(scaling)) {
      const c = SCALING_COEFFS[letter as string];
      if (c) bonus += ((stats as Record<string, unknown>)[stat] as number || 0) * c;
    }
  } else {
    // Unarmed: strength × C-grade, mirroring the server's damageBonus.
    bonus = (stats.strength || 0) * (SCALING_COEFFS['C'] ?? 0.4);
  }
  const b = Math.round(bonus);
  return [base[0] + b, base[1] + b];
}

/** Movement speed, as a multiplier on the base walk rate — the server's
 *  effectiveStat(self, 'speed'). Mainhand `speed` is deliberately absent: a
 *  weapon's speed is its swing rate, not a movement bonus (see sumEquipRolled),
 *  so the number here changes only for a speed affix on another slot or a haste
 *  potion. Kept separate from combatSpeed because the two genuinely differ. */
function movementSpeed(self: PlayerEntity): number {
  let sp = (self.components?.stats?.speed as number | undefined) ?? 1.0;
  const eq = self.components?.equipment;
  for (const slot of EQUIPMENT_SLOTS) {
    if (slot === 'mainhand') continue;
    const rolled = eq?.[slot]?.item?.components?.equipment?.rolled?.speed;
    if (typeof rolled === 'number') sp += rolled;
  }
  for (const m of self.components?.modifiers || []) {
    const d = m.stats?.speed;
    if (typeof d === 'number') sp += d;
  }
  return sp;
}

/** The equipped weapon's swing-rate multiplier — the client's mirror of the
 *  server's weaponSpeed. The roll wins when there is one (it has a Swift affix
 *  folded into it already); otherwise the base value stamped onto the stack,
 *  since a shop staple carries no rolled item at all. */
function weaponSpeed(self: PlayerEntity): number {
  const stack = self.components?.equipment?.mainhand;
  if (!stack) return 1;
  const rolled = stack.item?.components?.equipment?.rolled?.speed;
  const sp = typeof rolled === 'number' ? rolled : stack.base_speed;
  return typeof sp === 'number' && sp > 0 ? sp : 1;
}

/** How fast basic attacks come out: the movement/stat speed scaled by the
 *  weapon's own swing rate. */
function combatSpeed(self: PlayerEntity | null = state.self): number {
  if (!self) return 1;
  return (movementSpeed(self) || 1) * weaponSpeed(self);
}

function totalDefense(self: PlayerEntity): number {
  const eq = self.components?.equipment;
  if (!eq) return 0;
  let total = 0;
  for (const slot of ARMOR_SLOTS) {
    const def = eq[slot]?.item?.components?.equipment?.rolled?.defense;
    if (Array.isArray(def)) total += Math.round((def[0] + def[1]) / 2);
    else if (typeof def === 'number') total += def;
  }
  return total;
}

function classDisplay(klass: ClassId | undefined): string {
  if (!klass) return '—';
  return ({ fighter: 'Fighter', rogue: 'Rogue', wizard: 'Wizard' } as const)[klass] || '—';
}

function renderCharSheet(): void {
  const s = state.self;
  if (!s) return;
  const prog = s.components?.progress || { level: 1, xp: 0, unspent_points: 0 };
  const stats = s.components?.stats || {};
  const hp = s.components?.health || { current: 0, max: 0 };
  const dmg = effectiveDamageRange(s);
  const dex = stats.dexterity || 0;
  const dodgePct = Math.min(30, dex);
  // The same composite the world draws, at 2x — what you're wearing, not a
  // stock portrait, so equipping something is visible here immediately.
  const doll = getPlayerSprite(s.klass, s.color, s.components?.equipment);
  const dollEl = document.createElement('canvas');
  dollEl.width = doll.width * 2;
  dollEl.height = doll.height * 2;
  const dollCtx = dollEl.getContext('2d')!;
  dollCtx.imageSmoothingEnabled = false;
  dollCtx.drawImage(doll, 0, 0, dollEl.width, dollEl.height);
  csPortrait.replaceChildren(dollEl);

  csName.textContent = s.name || 'Player';
  csClass.textContent = classDisplay(s.klass);
  csLevel.textContent = String(prog.level);
  csXp.textContent = `${prog.xp} / ${xpForNext(prog.level)}`;
  csHp.textContent = `${hp.current} / ${hp.max}`;
  csStr.textContent = String(stats.strength ?? 0);
  csDex.textContent = String(stats.dexterity ?? 0);
  csInt.textContent = String(stats.intelligence ?? 0);
  csCon.textContent = String(stats.constitution ?? 0);
  csDmg.textContent = `${dmg[0]}–${dmg[1]}`;
  csDef.textContent = String(totalDefense(s));
  csDodge.textContent = `${dodgePct}%`;
  // Movement and attack speed are separate numbers because they are separately
  // sourced: a weapon only ever moves the second one. The attack row carries the
  // resulting interval too, since a bare multiplier doesn't say whether 0.90×
  // means a slow weapon or a slow character.
  csMoveSpeed.textContent = `${movementSpeed(s).toFixed(2)}×`;
  csAtkSpeed.textContent = `${combatSpeed(s).toFixed(2)}× (${(attackCooldownMs() / 1000).toFixed(1)}s)`;
  csPoints.textContent = String(prog.unspent_points || 0);
  csAlloc.classList.toggle('hidden', (prog.unspent_points || 0) <= 0);
}

function openSheet(): void { sheetBackdrop.classList.add('open'); renderCharSheet(); }
function closeSheet(): void { sheetBackdrop.classList.remove('open'); }

const gameMenuBackdrop2 = document.getElementById('gamemenu-backdrop')!;
function menuOpen(): boolean { return gameMenuBackdrop2.classList.contains('open'); }
function openMenu(): void { gameMenuBackdrop2.classList.add('open'); }
function closeMenu(): void { gameMenuBackdrop2.classList.remove('open'); }

// Top menu bar: clickable shortcuts mirroring the panel keybinds. Each entry
// toggles its panel on click; updateMenubar() reflects which panel is open.
const menubar = document.getElementById('menubar')!;
interface MenuEntry { el: HTMLElement; isOpen: () => boolean; toggle: () => void }
const menuEntries: MenuEntry[] = [
  { el: document.getElementById('mb-char')!,   isOpen: sheetOpen,  toggle: () => (sheetOpen()  ? closeSheet()     : openSheet()) },
  { el: document.getElementById('mb-inv')!,    isOpen: invOpen,    toggle: () => (invOpen()    ? closeInventory() : openInventory()) },
  { el: document.getElementById('mb-skills')!, isOpen: skillsOpen, toggle: () => (skillsOpen() ? closeSkills()    : openSkills()) },
  { el: document.getElementById('mb-quests')!, isOpen: qlOpen,     toggle: () => (qlOpen()     ? closeQuestlog()  : openQuestlog()) },
  { el: document.getElementById('mb-map')!,    isOpen: mapOpen,    toggle: () => { if (mapOpen()) closeMap(); else void openMap(); } },
  { el: document.getElementById('mb-menu')!,   isOpen: menuOpen,   toggle: () => (menuOpen()   ? closeMenu()      : openMenu()) },
];
for (const m of menuEntries) m.el.addEventListener('click', () => m.toggle());

function updateMenubar(): void {
  if (!state.self) { menubar.classList.remove('visible'); return; }
  menubar.classList.add('visible');
  for (const m of menuEntries) m.el.classList.toggle('active', m.isOpen());
}

window.addEventListener('mmo:self', renderCharSheet);
window.addEventListener('mmo:zone', () => { if (sheetOpen()) renderCharSheet(); });

// Dismiss any modal by clicking the backdrop outside the modal box.
(function wireBackdropDismiss() {
  function onOutside(backdrop: HTMLElement, close: () => void) {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  }
  onOutside(sheetBackdrop,                                     closeSheet);
  onOutside(invBackdrop,                                       closeInventory);
  onOutside(lootBackdrop,                                      closeLoot);
  onOutside(signBackdrop,                                      closeSign);
  onOutside(boardBackdrop,                                     closeBoard);
  onOutside(tradeBackdrop,                                     closeTrade);
  onOutside(trainerBackdrop,                                   closeTrainer);
  onOutside(document.getElementById('questgiver-backdrop')!,  closeQuestgiver);
  onOutside(document.getElementById('questlog-backdrop')!,    closeQuestlog);
  onOutside(gameMenuBackdrop2,                                 closeMenu);
  // map backdrop close is handled directly in the map section above
  // Login modal — just hide, no extra state to clear.
  const loginBd = document.getElementById('login-backdrop')!;
  loginBd.addEventListener('click', (e) => { if (e.target === loginBd) loginBd.classList.remove('open'); });
})();

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (chatFocused()) {
      const text = chatInput.value;
      if (text.trim()) state.sendChat?.(text);
      chatInput.value = '';
      chatInput.blur();
    } else {
      chatInput.focus();
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (chatFocused()) { chatInput.value = ''; chatInput.blur(); e.preventDefault(); return; }
    if (mapOpen()) { closeMap(); e.preventDefault(); return; }
    if (qgOpen()) { closeQuestgiver(); e.preventDefault(); return; }
    if (qlOpen()) { closeQuestlog(); e.preventDefault(); return; }
    if (sheetOpen()) { closeSheet(); e.preventDefault(); return; }
    if (invOpen()) { closeInventory(); e.preventDefault(); return; }
    if (tradeOpen()) { closeTrade(); e.preventDefault(); return; }
    if (trainerOpen()) { closeTrainer(); e.preventDefault(); return; }
    if (skillsOpen()) { closeSkills(); e.preventDefault(); return; }
    if (lootOpen()) { closeLoot(); e.preventDefault(); return; }
    if (signOpen()) { closeSign(); e.preventDefault(); return; }
    if (boardOpen()) { closeBoard(); e.preventDefault(); return; }
    if (menuOpen()) { closeMenu(); e.preventDefault(); return; }
    // An armed ground-target cast is cancelled first.
    if (abilityArmed) { setAbilityArmed(null); e.preventDefault(); return; }
    // With a unit selected, Escape clears the target (and drops engagement)
    // before it falls through to opening the menu.
    if (selectedTargetId) { selectTarget(null); setAttackArmed(false); e.preventDefault(); return; }
    openMenu(); e.preventDefault(); return;
  }
  if (chatFocused()) return;
  if (anyInputFocused()) return;
  if (state.died) return;

  // Cast a learned ability with number keys (1..9), aimed at the current target.
  if (e.key >= '1' && e.key <= '9' && state.self) {
    const abilityId = currentHotbarLayout()[parseInt(e.key, 10) - 1];
    if (abilityId) {
      castAbility(abilityId);
      e.preventDefault();
      return;
    }
  }

  if (e.key === 'm' || e.key === 'M') {
    if (mapOpen()) closeMap(); else void openMap();
    e.preventDefault();
    return;
  }
  if (e.key === 'c' || e.key === 'C') {
    if (sheetOpen()) closeSheet(); else openSheet();
    e.preventDefault();
    return;
  }
  if (e.key === 'i' || e.key === 'I') {
    if (invOpen()) closeInventory(); else openInventory();
    e.preventDefault();
    return;
  }
  if (e.key === 'q' || e.key === 'Q') {
    if (qlOpen()) closeQuestlog(); else openQuestlog();
    e.preventDefault();
    return;
  }
  if (e.key === 'k' || e.key === 'K') {
    if (skillsOpen()) closeSkills(); else openSkills();
    e.preventDefault();
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    if (anyInputFocused()) return;
    const consumable = findFirstConsumable();
    if (!consumable) { e.preventDefault(); return; }
    const now = performance.now();
    if (now < potionCooldownUntil) { e.preventDefault(); return; }
    potionCooldownUntil = now + POTION_COOLDOWN_MS;
    void state.sendUseItem?.(consumable.slot);
    e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    // Space engages the current target (so auto-attack continues) and throws an
    // immediate swing at it.
    const t = selectedTargetId ? state.zone?.entities.find(en => en.id === selectedTargetId) : null;
    if (isSelectableMob(t)) engaged = true;
    const now = performance.now();
    if (now < gcdUntil || now - lastAttackAt < attackCooldownMs()) { e.preventDefault(); return; }
    lastAttackAt = now;
    triggerGcd(now);
    cancelAutopath();
    state.sendAttack?.(selectedTargetId ?? undefined);
    e.preventDefault();
    return;
  }
  const dir = KEY_TO_DIR[e.key];
  if (!dir) return;
  cancelAutopath();
  const now = performance.now();
  if (dir === lastSentDir && now - lastSentAt < MOVE_COOLDOWN_MS) return;
  lastSentDir = dir;
  lastSentAt = now;
  state.sendMove?.(dir);
  e.preventDefault();
});
window.addEventListener('keyup', () => { lastSentDir = null; });

chatInput.addEventListener('focus', () => chatInput.classList.remove('dim'));
chatInput.addEventListener('blur',  () => chatInput.classList.add('dim'));

const CHAT_CHANNEL_PREFIX: Record<string, { label: string; color: string }> = {
  global:  { label: '[G] ', color: '#ffd84a' },
  whisper: { label: '[PM] ', color: '#cc88ff' },
  system:  { label: '[!] ', color: '#ff4444' },
};

function renderChatLog(): void {
  const now = performance.now();
  const visible = state.chatLog.filter(c => now - c.recvAt < CHAT_LOG_TTL_MS);
  chatLog.innerHTML = '';
  for (const c of visible.slice(-8)) {
    const line = document.createElement('div');
    line.className = 'chat-line';

    const isSystem = c.channel === 'system';
    const channel = c.channel && CHAT_CHANNEL_PREFIX[c.channel];
    if (channel) {
      const prefix = document.createElement('span');
      prefix.style.color = channel.color;
      prefix.textContent = channel.label;
      line.appendChild(prefix);
    }

    if (!isSystem) {
      const name = document.createElement('span');
      name.className = 'chat-name' + (c.from.id === state.entityId ? ' self' : '');
      if (channel) name.style.color = channel.color;
      name.textContent = c.from.name + ': ';
      line.appendChild(name);
    }

    const txt = document.createElement('span');
    if (channel) txt.style.color = channel.color;
    txt.textContent = c.text;
    line.appendChild(txt);
    chatLog.appendChild(line);
  }
}
setInterval(renderChatLog, 250);
window.addEventListener('mmo:chat', renderChatLog);

interface FloatArgs {
  text: string; x: number; y: number; t: number; ttl: number; rise: number;
  color: string; font: string;
}
// Teleport smoke. Both ends of every teleport draw the same puff, played in
// opposite directions: a departure billows outward as the traveller vanishes,
// an arrival collapses inward as they resolve out of it. Purely procedural —
// no sprite to bake, and it reads at any tile size.
//
// Arcane purple rather than grey smoke, matching the ability-cast callout
// (#c58cff) so magical displacement reads as one visual family.
const PUFF_TTL_MS = 900;
// The billow is deliberately faster than the fade: the cloud bursts open (or
// collapses) in this long, then hangs and thins for the rest of PUFF_TTL_MS.
// Tying both to one clock made a slow fade also mean a sluggish burst.
const PUFF_SPREAD_MS = 420;
const PUFF_BLOBS = 7;

function drawTeleportPuff(cx: number, cy: number, t: number, phase: 'depart' | 'arrive'): void {
  const age = performance.now() - t;
  if (age >= PUFF_TTL_MS) return;
  const motion = Math.min(1, age / PUFF_SPREAD_MS);
  // Ease-out on the way out, ease-in on the way back, so the departure snaps
  // open and the arrival settles rather than both reading as the same pop.
  const spread = phase === 'depart' ? 1 - (1 - motion) * (1 - motion) : (1 - motion) * (1 - motion);
  const alpha = 1 - age / PUFF_TTL_MS;

  ctx.save();
  // Blob angles are fixed per index rather than random per frame — a puff that
  // reshuffles its lobes every frame reads as static, not smoke.
  for (let i = 0; i < PUFF_BLOBS; i++) {
    const angle = (i / PUFF_BLOBS) * Math.PI * 2 + (i % 2 ? 0.4 : 0);
    const dist = spread * TILE * (0.55 + (i % 3) * 0.16);
    const r = TILE * (0.34 - spread * 0.1) * (1 + (i % 2) * 0.25);
    ctx.fillStyle = `rgba(139, 84, 201, ${alpha * 0.42})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, Math.max(1, r), 0, Math.PI * 2);
    ctx.fill();
  }
  // A brief pale core so the tile itself reads as the source of the smoke.
  ctx.fillStyle = `rgba(216, 178, 255, ${alpha * 0.6})`;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, TILE * 0.28 * (1 - spread * 0.7)), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Blood where the player fell. Drawn under the entities so it reads as being
// on the ground rather than another thing standing on it, and it outlives the
// respawn timer by a few seconds so you can see where you died once you're back
// on your feet — if you make it back.
const SPLAT_TTL_MS = RESPAWN_DELAY_MS + 3000;
const SPLAT_FADE_MS = 2200;
// The spray lands far faster than it dries: blotches blossom out from the death
// tile in this long, then just sit there.
const SPLAT_SPREAD_MS = 260;

function drawDeathSplat(px: number, py: number, sx: number, sy: number, t: number): void {
  const age = performance.now() - t;
  if (age >= SPLAT_TTL_MS) return;
  const fade = age < SPLAT_TTL_MS - SPLAT_FADE_MS ? 1 : (SPLAT_TTL_MS - age) / SPLAT_FADE_MS;
  const motion = Math.min(1, age / SPLAT_SPREAD_MS);
  const spread = 1 - (1 - motion) * (1 - motion);
  // Seeded off the tile that was died on, so two deaths in the same zone don't
  // stamp the identical shape, and so a given splatter is fixed for its whole
  // life — a blotch that re-rolls every frame reads as static, not as blood.
  const seed = Math.floor(hash2d(sx, sy, 8421) * 4294967296);
  const ccx = px + TILE / 2;
  const ccy = py + TILE / 2;

  ctx.save();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const center = dx === 0 && dy === 0;
      // A ring tile is sometimes left clean — an even nine-tile square of blood
      // reads as a stamped decal, a ragged one as spatter.
      if (!center && hash2d(dx, dy, seed) < 0.28) continue;
      const blobs = center ? 6 : 3;
      for (let i = 0; i < blobs; i++) {
        const h1 = hash2d(dx * 31 + i, dy * 17 - i, seed);
        const h2 = hash2d(dx * 13 - i, dy * 41 + i, seed + 1);
        const h3 = hash2d(dx * 7 + i, dy * 23 + i, seed + 2);
        const bx = (dx + h1 - 0.5) * TILE;
        const by = (dy + h2 - 0.5) * TILE;
        const r = TILE * (center ? 0.14 + h3 * 0.16 : 0.05 + h3 * 0.11);
        ctx.fillStyle = h3 > 0.7
          ? `rgba(168, 32, 26, ${fade * 0.55})`
          : `rgba(112, 14, 14, ${fade * 0.72})`;
        ctx.beginPath();
        ctx.arc(ccx + bx * spread, ccy + by * spread, Math.max(0.6, r * spread), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // A pool on the death tile itself, so the spatter has an obvious origin.
  ctx.fillStyle = `rgba(88, 8, 8, ${fade * 0.6})`;
  ctx.beginPath();
  ctx.arc(ccx, ccy, TILE * 0.3 * spread, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFloatText({ text, x, y, t, ttl, rise, color, font }: FloatArgs): void {
  const age = performance.now() - t;
  if (age >= ttl) return;
  const dy = (age / ttl) * rise;
  const alpha = 1 - age / ttl;
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.strokeText(text, x, y - dy);
  ctx.fillText(text, x, y - dy);
  ctx.globalAlpha = 1;
}

function drawTile(px: number, py: number, color: string, spriteId?: string | null): void {
  if (color === 'transparent' || color === 'none') return;
  const img = spriteId ? getTileImage(spriteId) : null;
  if (img) {
    ctx.drawImage(img, px, py, TILE, TILE);
    return;
  }
  // No baked variant yet (or still loading) — flat color keeps the tile visible.
  ctx.fillStyle = color;
  ctx.fillRect(px, py, TILE, TILE);
}

function drawEntity(px: number, py: number, color: string, scale?: number, spriteId?: string | null): void {
  const img = spriteId ? getSpriteImage(spriteId) : null;
  // A manual draw_scale always wins. Otherwise default to 1.2 with an image,
  // or 1 for the placeholder box (no image).
  const size = Math.round(TILE * (scale ?? (img ? 1.2 : 1)));
  const margin = Math.floor((TILE - size) / 2);
  if (img) {
    ctx.imageSmoothingEnabled = false;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.drawImage(img, px + margin, py + margin, size, size);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(px + margin, py + margin, size, size);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + margin + 0.5, py + margin + 0.5, size - 1, size - 1);
  }
}

function drawPlayerSprite(px: number, py: number, e: EntitySnapshot): void {
  // Snapshots ship the player's whole components object (world.ts
  // entityToSnapshot), so the equipped gear the paper-doll needs is already
  // here — no extra wire field. EntitySnapshot types it `unknown`.
  const equipment = (e.components as PlayerEntity['components'] | undefined)?.equipment;
  const img = getPlayerSprite(e.klass, e.color, equipment);
  const size = Math.round(TILE * 1.2);
  const margin = Math.floor((TILE - size) / 2);
  ctx.imageSmoothingEnabled = false;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  if (e.facing === 'west') {
    // Templates face the viewer with a subtle east lean; mirror for westward movement.
    ctx.save();
    ctx.translate(px + margin + size, py + margin);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, size, size);
    ctx.restore();
  } else {
    ctx.drawImage(img, px + margin, py + margin, size, size);
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

function drawGroundItem(px: number, py: number, color: string): void {
  const cx = px + TILE / 2;
  const cy = py + TILE / 2 + 4;
  const r = 7;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawCorpse(px: number, py: number, alpha: number): void {
  const cx = px + TILE / 2;
  const cy = py + TILE / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#8a7a6a';
  ctx.fillRect(cx - 7, cy - 2, 14, 4);
  ctx.fillRect(cx - 2, cy - 7, 4, 14);
  ctx.strokeStyle = '#2a1a0a';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(cx - 7, cy - 2, 14, 4);
  ctx.strokeRect(cx - 2, cy - 7, 4, 14);
  ctx.restore();
}

// Floating "!" above quest-giver heads. Pulses very gently so it reads as
// interactive without being a distraction.
function drawQuestMarker(cx: number, cy: number, color = '#ffd84a'): void {
  const pulse = 0.85 + 0.15 * Math.sin(performance.now() / 220);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = color;
  ctx.strokeText('!', 0, 0);
  ctx.fillText('!', 0, 0);
  ctx.restore();
}

// Floating "?" above mobs that have an active talk-return objective.
function drawTalkMarker(cx: number, cy: number): void {
  const pulse = 0.88 + 0.12 * Math.sin(performance.now() / 280);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#7acdf5';
  ctx.strokeText('?', 0, 0);
  ctx.fillText('?', 0, 0);
  ctx.restore();
}


function drawHpBar(px: number, py: number, current: number, max: number): void {
  if (current >= max) return;
  const w = TILE - 8;
  const pct = Math.max(0, current / max);
  ctx.fillStyle = '#000';
  ctx.fillRect(px + 4, py + 1, w, 3);
  ctx.fillStyle = pct > 0.5 ? '#5acc5a' : pct > 0.25 ? '#cc8a3a' : '#cc3a3a';
  ctx.fillRect(px + 4, py + 1, Math.round(w * pct), 3);
}

// Same CC vocabulary as server/game/systems/stats.ts's ccFlags (can't import
// server code client-side, so this mirrors that ~5-line union directly).
// 'slow' isn't a real CcKind — it's a modifier.stats.speed delta — but the
// player needs to see it just as much, so it's synthesized as a badge here.
// `label` is the short in-world badge; `name` is the full word used in the
// player/target HUD frames.
const CC_BADGES: Record<CcKind, { label: string; name: string; color: string }> = {
  stun: { label: 'STUN', name: 'Stunned', color: '#ffcc4a' },
  root: { label: 'ROOT', name: 'Rooted', color: '#8a6a4a' },
  silence: { label: 'SIL', name: 'Silenced', color: '#aaaaaa' },
  confuse: { label: 'CNF', name: 'Confused', color: '#c58cff' },
  fear: { label: 'FEAR', name: 'Feared', color: '#5adfff' },
  antagonize: { label: 'ANTG', name: 'Provoked', color: '#ff6a6a' },
};
const SLOW_BADGE = { label: 'SLOW', name: 'Slowed', color: '#6a9fff' };
const HASTE_BADGE = { label: 'HASTE', name: 'Hastened', color: '#ffd84a' };

// Mirrors server/game/loop.ts's TICK_MS — needed to convert a modifier's
// `expiresAt` (an absolute server tick) into a remaining-seconds countdown.
const SERVER_TICK_MS = 100;

// The current server tick, extrapolated between snapshots from the last
// state.zone.tick + wall-clock time elapsed since it arrived (see
// state._zoneSnapshotAtMs, set in socket.ts's applyZoneSnap). Snapshots only
// arrive on dirty ticks, so without this the countdown would visibly stall
// between them instead of ticking down smoothly every frame.
function currentServerTick(): number {
  const tick = state.zone?.tick;
  if (tick == null || state._zoneSnapshotAtMs == null) return tick ?? 0;
  return tick + (performance.now() - state._zoneSnapshotAtMs) / SERVER_TICK_MS;
}

// Ground-effect zones (see World.activeZones / ZoneEffect, server-side) are a
// Chebyshev square, not a circle — resolveTargets/tickZones hit-test with
// Math.max(|dx|,|dy|) <= radius, so drawing a circle here would visually lie
// about the actual hit area. Drawn once per zone as a tinted, pulsing square;
// fades out as it nears expiry using the same tick-extrapolation the status
// pill countdowns use (currentServerTick).
function drawActiveZones(zones: ActiveZoneSnapshot[] | undefined, offsetX: number, offsetY: number): void {
  if (!zones || zones.length === 0) return;
  const nowTick = currentServerTick();
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
  for (const z of zones) {
    const remaining = z.expiresAt - nowTick;
    if (remaining <= 0) continue;
    // Fade over the last ~2s so a zone's disappearance doesn't feel abrupt.
    const fade = Math.min(1, remaining / (2000 / SERVER_TICK_MS));
    const rgb = z.kind === 'heal' ? '74, 222, 128' : '255, 106, 106';
    const size = (z.radius * 2 + 1) * TILE;
    const left = (z.x - z.radius) * TILE + offsetX;
    const top = (z.y - z.radius) * TILE + offsetY;
    ctx.save();
    ctx.fillStyle = `rgba(${rgb}, ${(0.10 + 0.08 * pulse) * fade})`;
    ctx.fillRect(left, top, size, size);
    ctx.strokeStyle = `rgba(${rgb}, ${(0.55 + 0.3 * pulse) * fade})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(left + 1, top + 1, size - 2, size - 2);
    ctx.restore();
  }
}

interface StatusBadge { label: string; name: string; color: string; expiresAt: number }

function activeStatusBadges(modifiers: TimedModifier[] | undefined): StatusBadge[] {
  if (!modifiers || modifiers.length === 0) return [];
  const expiresAtByFlag = new Map<CcKind, number>();
  let slowExpiresAt = -Infinity;
  let hasteExpiresAt = -Infinity;
  for (const m of modifiers) {
    for (const c of m.cc ?? []) {
      expiresAtByFlag.set(c, Math.max(expiresAtByFlag.get(c) ?? -Infinity, m.expiresAt));
    }
    const speedDelta = m.stats?.speed ?? 0;
    if (speedDelta < 0) slowExpiresAt = Math.max(slowExpiresAt, m.expiresAt);
    if (speedDelta > 0) hasteExpiresAt = Math.max(hasteExpiresAt, m.expiresAt);
  }
  const badges = [...expiresAtByFlag.entries()].map(([c, expiresAt]) => ({ ...CC_BADGES[c], expiresAt }));
  if (slowExpiresAt > -Infinity) badges.push({ ...SLOW_BADGE, expiresAt: slowExpiresAt });
  if (hasteExpiresAt > -Infinity) badges.push({ ...HASTE_BADGE, expiresAt: hasteExpiresAt });
  return badges;
}

// Renders the same active-status set as drawStatusBadges, but as full-word
// pills (with a live remaining-time countdown) in a HUD frame (player/target)
// instead of short in-world labels.
function renderStatusRow(el: HTMLElement, modifiers: TimedModifier[] | undefined): void {
  const badges = activeStatusBadges(modifiers);
  // The common case is "no statuses" — bail before touching the DOM rather than
  // clearing an already-empty row on every frame.
  if (badges.length === 0 && el.childElementCount === 0) return;
  const nowTick = currentServerTick();
  el.innerHTML = '';
  for (const b of badges) {
    const remainingSec = Math.max(0, (b.expiresAt - nowTick) * SERVER_TICK_MS / 1000);
    const span = document.createElement('span');
    span.className = 'status-badge';
    span.textContent = `${b.name} (${remainingSec.toFixed(1)}s)`;
    span.style.background = b.color;
    el.appendChild(span);
  }
}

function drawStatusBadges(px: number, py: number, modifiers: TimedModifier[] | undefined): void {
  const badges = activeStatusBadges(modifiers);
  if (!badges.length) return;
  ctx.save();
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center';
  let x = px + TILE / 2 - ((badges.length - 1) * 16) / 2;
  const y = py - 10;
  for (const b of badges) {
    ctx.fillStyle = b.color;
    ctx.fillText(b.label, x, y);
    x += 16;
  }
  ctx.restore();
}

function drawTargetHighlight(px: number, py: number, friendly = false): void {
  ctx.save();
  ctx.strokeStyle = friendly ? '#44dd66' : '#ff4444';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.lineDashOffset = -(performance.now() / 80) % 7;
  ctx.strokeRect(px + 2, py + 2, TILE - 4, TILE - 4);
  ctx.restore();
}

const DAY_KEYFRAMES: [number, number, number, number, number][] = [
  // [timeOfDay, r, g, b, alpha]
  [0.00,  5, 15, 55, 0.40],  // midnight
  [0.20,  5, 15, 55, 0.30],  // pre-dawn
  [0.25, 80, 38, 10, 0.10],  // dawn
  [0.38, 80, 38, 10, 0.00],  // morning
  [0.62, 80, 38, 10, 0.00],  // afternoon
  [0.75, 80, 38, 10, 0.10],  // dusk
  [0.80,  5, 15, 55, 0.30],  // post-dusk
  [1.00,  5, 15, 55, 0.40],  // midnight again
];

function nightOverlayStyle(t: number): string | null {
  for (let i = 0; i < DAY_KEYFRAMES.length - 1; i++) {
    const [t0, r0, g0, b0, a0] = DAY_KEYFRAMES[i]!;
    const [t1, r1, g1, b1, a1] = DAY_KEYFRAMES[i + 1]!;
    if (t >= t0 && t <= t1) {
      const p = (t - t0) / (t1 - t0);
      const lerp = (a: number, b: number) => a + (b - a) * p;
      const a = lerp(a0, a1);
      if (a < 0.005) return null;
      return `rgba(${Math.round(lerp(r0, r1))},${Math.round(lerp(g0, g1))},${Math.round(lerp(b0, b1))},${a.toFixed(3)})`;
    }
  }
  return null;
}

// Erases a radial area from the darkness canvas so underlying tiles show through.
// Soft falloff starts at 50% of radius.
function punchLight(dCtx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  const grad = dCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0,   'rgba(0,0,0,1)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.9)');
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  dCtx.fillStyle = grad;
  dCtx.beginPath();
  dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  dCtx.fill();
}

// Atmospheric haze the world fades toward at its outer edges. Border tiles bleed
// their own color out to this, so water reads as an ocean horizon, forest as a
// distant treeline, etc. — instead of a hard black wall.
const EDGE_HAZE: [number, number, number] = [184, 205, 221];

// Fills off-grid screen areas with flat haze, then overlays a smooth gradient
// vignette inward over the border tiles. Called after tiles are drawn so the
// gradient composites on top of real terrain instead of being painted under it.
function drawWorldEdgeVignette(
  gridW: number, gridH: number,
  offsetX: number, offsetY: number,
): void {
  const cw = canvas.width, ch = canvas.height;
  const right  = gridW * TILE + offsetX;
  const bottom = gridH * TILE + offsetY;
  const hz  = `rgb(${EDGE_HAZE[0]},${EDGE_HAZE[1]},${EDGE_HAZE[2]})`;
  const hz0 = `rgba(${EDGE_HAZE[0]},${EDGE_HAZE[1]},${EDGE_HAZE[2]},0)`;
  const REACH = TILE * 2;

  ctx.fillStyle = hz;
  if (offsetX > 0)  ctx.fillRect(0, 0, offsetX, ch);
  if (right  < cw)  ctx.fillRect(right, 0, cw - right, ch);
  if (offsetY > 0)  ctx.fillRect(0, 0, cw, offsetY);
  if (bottom < ch)  ctx.fillRect(0, bottom, cw, ch - bottom);

  const fade = (x1: number, y1: number, x2: number, y2: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, hz); g.addColorStop(1, hz0);
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  };

  if (offsetX > -REACH) {
    const x = Math.max(0, offsetX);
    fade(x, 0, x + REACH, 0,  x, 0, REACH, ch);
  }
  if (right < cw + REACH) {
    const x = Math.min(cw, right);
    fade(x, 0, x - REACH, 0,  x - REACH, 0, REACH, ch);
  }
  if (offsetY > -REACH) {
    const y = Math.max(0, offsetY);
    fade(0, y, 0, y + REACH,  0, y, cw, REACH);
  }
  if (bottom < ch + REACH) {
    const y = Math.min(ch, bottom);
    fade(0, y, 0, y - REACH,  0, y - REACH, cw, REACH);
  }
}

// ---- Minimap (zone radar) ----
const minimapWrap = document.getElementById('minimap-wrap')!;
const minimap = document.getElementById('minimap') as HTMLCanvasElement;
const minimapCtx = minimap.getContext('2d')!;
const mmN = document.getElementById('mm-n')!;
const mmE = document.getElementById('mm-e')!;
const mmS = document.getElementById('mm-s')!;
const mmW = document.getElementById('mm-w')!;
const miniTile = document.createElement('canvas');   // offscreen tile layer, rebuilt per zone
const miniTileCtx = miniTile.getContext('2d')!;
let miniZoneRef = '';
let miniScale = 1;
const MINIMAP_MAX = 220;

const MINI_DOT: Record<string, string> = {
  player: '#7acdf5',
  ground_item: '#ffd84a',
};

// Minimap dot color for an entity: mobs by disposition (hostile red, passive
// grey, friendly green), everything else by type.
function miniDotColor(e: EntitySnapshot): string | undefined {
  if (e.type === 'mob') {
    return e.disposition === 'friendly' ? '#5acc7a'
      : e.disposition === 'passive' ? '#9a9a9a'
      : '#e05a5a';
  }
  return MINI_DOT[e.type];
}

// Names the zone in an adjacent world-map cell (col, row), for a compass hint.
function neighborLabel(col: number, row: number): string {
  if (!mapData) return '…';
  if (row < 0 || row >= mapData.rows || col < 0 || col >= mapData.cols) return '—';
  const cell = mapData.cells[row]?.[col];
  return cell ? (cell.zoneName || cell.worldBiome) : 'open sea';
}

// Updates the N/E/S/W labels to describe what lies in each direction. World
// map cells are indexed [gridY][gridX]; the zone id encodes (gridX, gridY).
function updateMinimapCompass(): void {
  const m = /^(?:zone|city|village)_(-?\d+)_(-?\d+)$/.exec(state.zone?.id ?? '');
  if (!m || !mapData) {
    mmN.textContent = 'N'; mmE.textContent = 'E'; mmS.textContent = 'S'; mmW.textContent = 'W';
    return;
  }
  // Translate the player's raw zone coords into 0-based cell indices.
  const gx = parseInt(m[1]!, 10) - mapData.originX;
  const gy = parseInt(m[2]!, 10) - mapData.originY;
  mmN.textContent = `N · ${neighborLabel(gx, gy - 1)}`;
  mmE.textContent = `E · ${neighborLabel(gx + 1, gy)}`;
  mmS.textContent = `S · ${neighborLabel(gx, gy + 1)}`;
  mmW.textContent = `W · ${neighborLabel(gx - 1, gy)}`;
}

// Repaints the cached tile layer; called only when the zone changes.
function rebuildMinimapTiles(): void {
  const z = state.zone;
  if (!z) return;
  miniScale = Math.max(1, Math.floor(Math.min(MINIMAP_MAX / z.width, MINIMAP_MAX / z.height)));
  const w = z.width * miniScale;
  const h = z.height * miniScale;
  miniTile.width = w; miniTile.height = h;
  minimap.width = w; minimap.height = h;
  const colors = state._tileColors ?? {};
  for (let y = 0; y < z.height; y++) {
    const row = z.grid[y];
    if (!row) continue;
    for (let x = 0; x < z.width; x++) {
      miniTileCtx.fillStyle = colors[row[x] ?? ''] ?? '#222';
      miniTileCtx.fillRect(x * miniScale, y * miniScale, miniScale, miniScale);
    }
  }
  miniZoneRef = z.id;
}

// Draws cached tiles + live entity dots + player marker + viewport box.
function renderMinimap(): void {
  const z = state.zone, me = state.self;
  if (!z || !me || !state._tileColors) { minimapWrap.classList.remove('visible'); return; }
  // The wilderness has no bounded grid, so render a live window around the
  // player from the shared terrain function instead of a baked zone bitmap.
  if (isWild()) { renderWildernessMinimap(me); return; }
  if (miniZoneRef !== z.id) { rebuildMinimapTiles(); updateMinimapCompass(); }
  minimapWrap.classList.add('visible');

  const s = miniScale;
  minimapCtx.clearRect(0, 0, minimap.width, minimap.height);
  minimapCtx.drawImage(miniTile, 0, 0);

  // Entity dots — skip self, corpses, and static fixtures to keep it tactical.
  const d = Math.max(2, s);
  for (const e of z.entities) {
    if (e.id === me.id || e.type === 'corpse') continue;
    if (e.type === 'mob' && e.fixture) continue;
    const color = miniDotColor(e);
    if (!color) continue;
    minimapCtx.fillStyle = color;
    minimapCtx.fillRect(e.position.x * s + s / 2 - d / 2, e.position.y * s + s / 2 - d / 2, d, d);
  }

  const px = me.position.x * s + s / 2;
  const py = me.position.y * s + s / 2;

  // Viewport box — the slice of the zone currently on screen.
  const vw = (canvas.width / TILE) * s;
  const vh = (canvas.height / TILE) * s;
  minimapCtx.strokeStyle = 'rgba(255,255,255,0.45)';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(px - vw / 2, py - vh / 2, vw, vh);

  // Player marker.
  minimapCtx.fillStyle = '#fff';
  minimapCtx.beginPath();
  minimapCtx.arc(px, py, Math.max(2.5, s * 0.8), 0, Math.PI * 2);
  minimapCtx.fill();
}

// Number of wilderness tiles shown across the minimap window (centered on the
// player). The field is infinite, so we render a moving local slice, not a
// baked bitmap.
const WILD_MINIMAP_TILES = 48;
const wildMiniTile = document.createElement('canvas');   // baked terrain window
const wildMiniTileCtx = wildMiniTile.getContext('2d')!;
let wildMiniRef = '';

// Live wilderness minimap: sample the shared terrain for a window around the
// player, overlay entity dots + a viewport box + the player marker.
function renderWildernessMinimap(me: NonNullable<typeof state.self>): void {
  const colors = state._tileColors!;
  const half = Math.floor(WILD_MINIMAP_TILES / 2);
  const s = Math.max(1, Math.floor(MINIMAP_MAX / WILD_MINIMAP_TILES));
  const dim = WILD_MINIMAP_TILES * s;
  if (minimap.width !== dim || minimap.height !== dim) { minimap.width = dim; minimap.height = dim; }
  // Force the bounded minimap to re-bake (and resize) when we return to a zone.
  miniZoneRef = '';
  minimapWrap.classList.add('visible');
  // Cardinal-only compass out here — no discrete neighbor zones to name.
  mmN.textContent = 'N'; mmE.textContent = 'E'; mmS.textContent = 'S'; mmW.textContent = 'W';

  const originX = me.position.x - half;
  const originY = me.position.y - half;
  // The window only changes when the player crosses a tile, but renderMinimap
  // runs every frame — so bake the ~2300 terrain cells once per step and blit.
  const bakeRef = `${originX},${originY},${s}`;
  if (bakeRef !== wildMiniRef) {
    wildMiniRef = bakeRef;
    if (wildMiniTile.width !== dim || wildMiniTile.height !== dim) {
      wildMiniTile.width = dim; wildMiniTile.height = dim;
    }
    for (let ly = 0; ly < WILD_MINIMAP_TILES; ly++) {
      for (let lx = 0; lx < WILD_MINIMAP_TILES; lx++) {
        wildMiniTileCtx.fillStyle = colors[wildTile(originX + lx, originY + ly)] ?? '#222';
        wildMiniTileCtx.fillRect(lx * s, ly * s, s, s);
      }
    }
  }
  minimapCtx.drawImage(wildMiniTile, 0, 0);

  // Entity dots (skip self, corpses, fixtures) positioned relative to the window.
  const d = Math.max(2, s);
  for (const e of wildEntities()) {
    if (e.id === me.id || e.type === 'corpse') continue;
    if (e.type === 'mob' && e.fixture) continue;
    const color = miniDotColor(e);
    if (!color) continue;
    const ex = (e.position.x - originX) * s, ey = (e.position.y - originY) * s;
    if (ex < 0 || ey < 0 || ex >= dim || ey >= dim) continue;
    minimapCtx.fillStyle = color;
    minimapCtx.fillRect(ex + s / 2 - d / 2, ey + s / 2 - d / 2, d, d);
  }

  // Player marker (player is at window center).
  const px = half * s + s / 2, py = half * s + s / 2;
  minimapCtx.fillStyle = '#fff';
  minimapCtx.beginPath();
  minimapCtx.arc(px, py, Math.max(2.5, s * 0.8), 0, Math.PI * 2);
  minimapCtx.fill();
}

function render(): void {
  if (!state.zone || !state.tileset) {
    requestAnimationFrame(render);
    return;
  }

  const wild = isWild();
  const { grid, width, height } = state.zone;
  // In the wilderness, entities arrive per-chunk; flatten them in place of the
  // (empty) zone snapshot's entity list.
  const entities = wild ? wildEntities() : state.zone.entities;
  // Keep the zone stub's entity list current in the wilderness so every consumer
  // that reads state.zone.entities (target frame, Space-engage, auto-attack,
  // loot, click) sees the streamed mobs, not the empty stub.
  if (wild) state.zone.entities = entities;
  const ts = state.tileset;
  if (state._tsRef !== ts) {
    state._tsRef = ts;
    state._tileColors = buildTileColorMap(ts);
    state._spriteColors = buildSpriteColorMap(ts);
  }
  const tileColors = state._tileColors!;
  const spriteColors = state._spriteColors!;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const self = state.self;
  const camTx = self ? self.position.x : Math.floor(width / 2);
  const camTy = self ? self.position.y : Math.floor(height / 2);

  // A new zone is a hard cut even when the coordinates happen to be adjacent.
  if (camZoneRef !== state.zone.id) { camZoneRef = state.zone.id; camReady = false; }
  const camNow = performance.now();
  stepZoom(Math.min(100, camZoomLastMs ? camNow - camZoomLastMs : 16) / 1000);
  camZoomLastMs = camNow;
  if (!camReady
      || Math.abs(camTx - camX) > CAM_SNAP_TILES
      || Math.abs(camTy - camY) > CAM_SNAP_TILES) {
    camX = camTx; camY = camTy; camVx = 0; camVy = 0; camReady = true;
  } else {
    // Critically damped spring (the standard SmoothDamp formulation — the cubic
    // is a stable rational approximation of e^-x, so it can't overshoot or ring
    // however large dt gets). Coefficients depend only on dt, so both axes share
    // one computation. dt is clamped so a backgrounded tab or a long GC pause
    // resumes smoothly instead of lurching.
    const dt = Math.min(100, camNow - camLastMs) / 1000;
    const omega = 2 / CAM_SMOOTH_TIME;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const chX = camX - camTx;
    const tmpX = (camVx + omega * chX) * dt;
    camVx = (camVx - omega * tmpX) * decay;
    camX = camTx + (chX + tmpX) * decay;
    const chY = camY - camTy;
    const tmpY = (camVy + omega * chY) * dt;
    camVy = (camVy - omega * tmpY) * decay;
    camY = camTy + (chY + tmpY) * decay;
    // Settle exactly. Asymptotic approach never quite arrives, which leaves the
    // camera nudging by sub-pixel amounts forever while standing still.
    if (Math.abs(camTx - camX) < 0.002 && Math.abs(camVx) < 0.01) { camX = camTx; camVx = 0; }
    if (Math.abs(camTy - camY) < 0.002 && Math.abs(camVy) < 0.01) { camY = camTy; camVy = 0; }
  }
  camLastMs = camNow;

  const camCx = Math.round(camX);
  const camCy = Math.round(camY);
  const viewCols = Math.ceil(canvas.width / TILE);
  const viewRows = Math.ceil(canvas.height / TILE);
  const offsetX = Math.round(Math.floor(canvas.width / 2) - camX * TILE - TILE / 2);
  const offsetY = Math.round(Math.floor(canvas.height / 2) - camY * TILE - TILE / 2);
  lastCamera = { offsetX, offsetY };

  // Recompute hovered tile/entity every frame so the highlight stays under the
  // cursor as the camera scrolls (player movement) and across zone transitions.
  {
    const p = pickAt(mousePx.x, mousePx.y);
    hoveredTile = p.tile;
    if (p.entity?.id !== hoveredEntity?.id) {
      hoveredEntity = p.entity;
      updateTooltip();
    } else {
      hoveredEntity = p.entity;
    }
    updateTargetingCursor();
  }

  // Approach-and-talk: poke an NPC once we've walked into talk range.
  if (pendingTalkId && self) {
    const t = entities.find(e => e.id === pendingTalkId);
    if (!t || t.type !== 'mob') pendingTalkId = null;
    else if (chebyshev(self.position.x, self.position.y, t.position.x, t.position.y) <= TALK_RANGE) {
      pokeMob(t); pendingTalkId = null;
    }
  }

  // Queued ability fires the instant the global cooldown clears — ahead of the
  // auto-attack below, so a press during the GCD always lands.
  if (queuedAbilityId && self && !state.died && performance.now() >= gcdUntil) {
    const id = queuedAbilityId;
    setQueuedAbility(null);
    castAbility(id);
  }

  // Auto-attack: fire when target is adjacent and cooldown elapsed. Yields to a
  // queued ability so it never steals the GCD out from under a pending cast.
  if (engaged && selectedTargetId && self && !state.died && !queuedAbilityId) {
    const atTarget = entities.find(e => e.id === selectedTargetId);
    if (!atTarget || atTarget.type !== 'mob') {
      engaged = false;
    } else if (chebyshev(self.position.x, self.position.y, atTarget.position.x, atTarget.position.y) <= selfAttackRange()) {
      const now = performance.now();
      if (now >= gcdUntil && now - lastAttackAt >= attackCooldownMs()) {
        lastAttackAt = now;
        triggerGcd(now);
        state.sendAttack?.(selectedTargetId);
      }
    } else if (!autopathDest || autopathIsChase) {
      // Target slipped out of range — chase it (throttled so we don't spam paths).
      // A ranged attacker still closes when the target is beyond its reach; the
      // server-side chase (loop.ts) halts the approach at that reach, not at melee.
      // Skipped while the player is walking somewhere of their own accord, so a
      // move order is never fought by the chase that would undo it.
      const now = performance.now();
      if (now - lastChaseAt > 350) {
        lastChaseAt = now;
        const dst = nearestWalkable(atTarget.position.x, atTarget.position.y, { excludeSelf: true });
        if (dst && (dst.x !== self.position.x || dst.y !== self.position.y)) {
          autopathDest = dst; autopathIsChase = true; state.sendAutopath(dst.x, dst.y, atTarget.id);
        }
      }
    }
  }

  // Track most recent combat event involving this player.
  for (const ev of state.combatEvents) {
    if ((ev.attackerId === state.entityId || ev.targetId === state.entityId) && ev.t > lastCombatAt) {
      lastCombatAt = ev.t;
    }
  }

  // Wilderness: the field is unbounded, so sample every visible signed-coord
  // tile from the shared field module. Enclosed zones index the bounded grid.
  const x0 = wild ? camCx - Math.ceil(viewCols / 2) - 1 : Math.max(0, camCx - Math.ceil(viewCols / 2) - 1);
  const x1 = wild ? camCx + Math.ceil(viewCols / 2) + 1 : Math.min(width, camCx + Math.ceil(viewCols / 2) + 1);
  const y0 = wild ? camCy - Math.ceil(viewRows / 2) - 1 : Math.max(0, camCy - Math.ceil(viewRows / 2) - 1);
  const y1 = wild ? camCy + Math.ceil(viewRows / 2) + 1 : Math.min(height, camCy + Math.ceil(viewRows / 2) + 1);

  // Sample the visible tile ids once, with a one-tile apron, into a reusable
  // buffer. The seam dither needs all 8 neighbours of every drawn tile, and
  // hitting wildTile()/grid nine times per tile per frame is nine times the
  // per-frame sampling cost for the same answers.
  const bw = (x1 - x0) + 2, bh = (y1 - y0) + 2;
  if (tileBuf.length < bw * bh) tileBuf = new Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const wx = x0 - 1 + x, wy = y0 - 1 + y;
      tileBuf[y * bw + x] = wild ? wildTile(wx, wy) : (grid[wy]?.[wx] ?? 'void');
    }
  }
  // Hoisted out of the loop so the closure is allocated once per frame, not
  // once per tile. `bx`/`by` are the buffer coords of the tile being drawn.
  let bx = 0, by = 0;
  const neighborAt = (dx: number, dy: number) => tileBuf[(by + dy) * bw + (bx + dx)]!;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      bx = x - x0 + 1; by = y - y0 + 1;
      const tile = pickSeamTile(tileBuf[by * bw + bx]!, x, y, ts, neighborAt);
      const color = tileColors[tile] || '#ff00ff';
      const tileEntry = ts.tiles[tile];
      const variants = tileEntry?.variants ?? 0;
      const spriteId = variants > 0
        ? variantSpriteId(tile, pickTileVariant(tile, x, y, variants, tileEntry?.variantWeights))
        : null;
      drawTile(x * TILE + offsetX, y * TILE + offsetY, color, spriteId);
    }
  }

  drawActiveZones(wild ? wildActiveZones() : state.zone?.activeZones, offsetX, offsetY);

  if (!wild && !state.zone?.no_edge_haze) drawWorldEdgeVignette(width, height, offsetX, offsetY);

  // Prune expired splatters here rather than on a timer — this is the only
  // place they are read, and a death in a zone nobody is looking at should not
  // keep a stale entry alive.
  const nowSplat = performance.now();
  if (state.deathSplats.length > 0) {
    state.deathSplats = state.deathSplats.filter((s) => nowSplat - s.t < SPLAT_TTL_MS);
    for (const s of state.deathSplats) {
      if (s.zoneId !== state.zone.id) continue;
      drawDeathSplat(s.x * TILE + offsetX, s.y * TILE + offsetY, s.x, s.y, s.t);
    }
  }

  const rankOf = (e: typeof entities[number]) =>
    (e.type === 'ground_item' || e.type === 'corpse') ? 0 : e.type === 'player' ? 2 : 1;
  const ordered = [...entities].sort((a, b) => rankOf(a) - rankOf(b));
  for (const e of ordered) {
    // While dead the player is a corpse-shaped hole in the world, not a body
    // standing in it. The entity list still has them in two cases: dying in the
    // zone you respawn in (the server teleports them there at once, so they show
    // up alive at the spawn point), and dying in the wilds (their sockets leave
    // the chunk rooms, so the update that would drop them never arrives).
    if (state.died && e.id === state.entityId) continue;
    const sprite = e.sprite || (e.type === 'player' ? 'player' : null);
    const color = e.color || (sprite && spriteColors[sprite]) || '#ffffff';
    const px = e.position.x * TILE + offsetX;
    const py = e.position.y * TILE + offsetY;
    if (e.type === 'ground_item') {
      drawGroundItem(px, py, color);
    } else if (e.type === 'corpse') {
      const hasLoot = (e.loot?.length ?? 0) > 0;
      if (!hasLoot) {
        if (!corpseEmptiedAt.has(e.id)) corpseEmptiedAt.set(e.id, Date.now());
        const elapsed = Date.now() - corpseEmptiedAt.get(e.id)!;
        drawCorpse(px, py, Math.max(0.15, 1 - elapsed / 10_000));
      } else {
        corpseEmptiedAt.delete(e.id);
        drawCorpse(px, py, 1.0);
      }
    } else {
      if (e.id === selectedTargetId) drawTargetHighlight(px, py, !!e.npc);
      if (e.type === 'player') drawPlayerSprite(px, py, e);
      else drawEntity(px, py, color, (e as { drawScale?: number }).drawScale, sprite);
      const hp = (e.components as { health?: { current: number; max: number } })?.health;
      if (hp && !e.fixture) drawHpBar(px, py, hp.current, hp.max);
      const modifiers = (e.components as { modifiers?: TimedModifier[] })?.modifiers;
      if (!e.fixture) drawStatusBadges(px, py, modifiers);
    }
    if (e.type === 'mob') {
      if (isTalkTarget(e)) drawTalkMarker(px + TILE / 2, py - 10);
      else if (isQuestgiver(e)) drawQuestMarker(px + TILE / 2, py - 10);
      else if (isRepeatableQuestgiver(e)) drawQuestMarker(px + TILE / 2, py - 10, '#7acdf5');
    }
  }

  // Day / night overlay with radial light cutouts.
  const nightStyle = nightOverlayStyle(state.zone.timeOfDay ?? 0.5);
  if (nightStyle) {
    // Half-resolution: this layer is nothing but soft radial gradients, so the
    // upscale is invisible, and it's the most expensive full-screen fill in the
    // frame (clear + fill + composite over every pixel).
    const dw = Math.ceil(canvas.width / DARKNESS_SCALE);
    const dh = Math.ceil(canvas.height / DARKNESS_SCALE);
    if (darknessCanvas.width !== dw || darknessCanvas.height !== dh) {
      darknessCanvas.width = dw;
      darknessCanvas.height = dh;
    }
    darknessCtx.clearRect(0, 0, dw, dh);
    darknessCtx.fillStyle = nightStyle;
    darknessCtx.fillRect(0, 0, dw, dh);

    darknessCtx.globalCompositeOperation = 'destination-out';
    const k = 1 / DARKNESS_SCALE;
    // Player always carries a small personal light so they stay visible.
    if (self) {
      punchLight(
        darknessCtx,
        (self.position.x * TILE + offsetX + TILE / 2) * k,
        (self.position.y * TILE + offsetY + TILE / 2) * k,
        3 * TILE * k,
      );
    }
    // World light sources (torches, bonfires, etc. with lightRadius set).
    for (const e of entities) {
      const lr = (e as { lightRadius?: number }).lightRadius;
      if (!lr) continue;
      punchLight(
        darknessCtx,
        (e.position.x * TILE + offsetX + TILE / 2) * k,
        (e.position.y * TILE + offsetY + TILE / 2) * k,
        lr * TILE * k,
      );
    }
    darknessCtx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(darknessCanvas, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Warm glow halos on top of the darkness — visible even at the edge of light pools.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of entities) {
      const lr = (e as { lightRadius?: number }).lightRadius;
      if (!lr) continue;
      const gcx = e.position.x * TILE + offsetX + TILE / 2;
      const gcy = e.position.y * TILE + offsetY + TILE / 2;
      const gr = lr * TILE * 1.4;
      const gg = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, gr);
      gg.addColorStop(0,    'rgba(255, 150, 30, 0.14)');
      gg.addColorStop(0.35, 'rgba(255, 120, 10, 0.07)');
      gg.addColorStop(1,    'rgba(255,  80,  0, 0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(gcx, gcy, gr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (hoveredTile) {
    const px = hoveredTile.x * TILE + offsetX;
    const py = hoveredTile.y * TILE + offsetY;
    let color = '#7acdf5';
    if (abilityArmed) {
      const range = abilityRange(abilityArmed);
      const inRange = !!self && chebyshev(self.position.x, self.position.y, hoveredTile.x, hoveredTile.y) <= range;
      color = inRange ? '#5ad46a' : '#e05a5a';
    } else if (hoveredEntity && hasQuestInteraction(hoveredEntity)) {
      const self = state.self;
      const inRange = self
        ? Math.max(
            Math.abs(self.position.x - hoveredEntity.position.x),
            Math.abs(self.position.y - hoveredEntity.position.y),
          ) <= TALK_RANGE
        : false;
      color = inRange ? '#ffd84a' : '#888';
    } else if (!isWalkable(hoveredTile.x, hoveredTile.y)) {
      color = '#cc5a5a';
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);
    ctx.restore();
  }

  if (autopathDest) {
    const self = state.self;
    if (self && self.position.x === autopathDest.x && self.position.y === autopathDest.y) {
      autopathDest = null;
    } else if (!engaged) {
      const cx = autopathDest.x * TILE + offsetX + TILE / 2;
      const cy = autopathDest.y * TILE + offsetY + TILE / 2;
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 180);
      ctx.save();
      ctx.strokeStyle = `rgba(255, 216, 74, ${pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  const now = performance.now();

  // Teleport puffs draw beneath the text floats so a damage number is never
  // lost in smoke. Filtered by zone because both ends of a cross-zone teleport
  // reach whichever client is in either — that is the point of the pair.
  state.teleportPuffs = state.teleportPuffs.filter(ev => now - ev.t < PUFF_TTL_MS);
  for (const ev of state.teleportPuffs) {
    if (ev.zoneId !== state.zone?.id) continue;
    drawTeleportPuff(
      ev.x * TILE + offsetX + TILE / 2,
      ev.y * TILE + offsetY + TILE / 2,
      ev.t,
      ev.phase,
    );
  }

  state.combatEvents = state.combatEvents.filter(ev => now - ev.t < FLOAT_TTL_MS);

  // Ranged shots: a dart travelling attacker → target. Without this a hit from
  // across the room is just a number appearing on the mob, with nothing to say
  // where it came from. Drawn under the damage floats, and derived entirely from
  // the combat event we already receive — `at` is the target tile and the
  // attacker's position comes from the entity list, so no extra payload. Ability
  // damage produces AttackEvents too, so ranged spells get this for free.
  for (const ev of state.combatEvents) {
    const age = now - ev.t;
    if (!ev.at || age > TRACER_TTL_MS) continue;
    const from = entities.find(e => e.id === ev.attackerId);
    if (!from) continue; // attacker left the zone / died — nothing to draw from
    const dist = chebyshev(from.position.x, from.position.y, ev.at.x, ev.at.y);
    if (dist <= 1) continue; // a melee swing needs no travel
    const x0 = from.position.x * TILE + offsetX + TILE / 2;
    const y0 = from.position.y * TILE + offsetY + TILE / 2;
    const x1 = ev.at.x * TILE + offsetX + TILE / 2;
    const y1 = ev.at.y * TILE + offsetY + TILE / 2;
    const p = Math.min(1, age / TRACER_TTL_MS);
    const fade = 1 - p;
    const outgoing = ev.attackerId === state.entityId;
    const rgb = outgoing ? '255, 224, 138' : '255, 122, 122';
    ctx.save();
    // The trail fades behind the dart rather than the whole line blinking, so
    // the eye follows the direction of travel.
    ctx.strokeStyle = `rgba(${rgb}, ${0.38 * fade})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p);
    ctx.stroke();
    ctx.fillStyle = `rgba(${rgb}, ${fade})`;
    ctx.beginPath();
    ctx.arc(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const ev of state.combatEvents) {
    if (!ev.at) continue;
    let text: string, color: string;
    if (ev.dodged) {
      text = 'dodge';
      color = '#9adfff';
    } else {
      text = ev.fatal ? `${ev.damage}!` : `${ev.damage}`;
      color = ev.fatal ? '#ffcc4a' : (ev.targetId === state.entityId ? '#ff6a6a' : '#ffffff');
    }
    drawFloatText({
      text,
      x: ev.at.x * TILE + offsetX + TILE / 2,
      y: ev.at.y * TILE + offsetY,
      t: ev.t, ttl: FLOAT_TTL_MS, rise: 18,
      color,
      font: 'bold 14px monospace',
    });
  }

  state.healFloats = state.healFloats.filter(ev => now - ev.t < FLOAT_TTL_MS);
  for (const ev of state.healFloats) {
    if (!ev.at || ev.amount <= 0) continue;
    drawFloatText({
      text: `+${ev.amount}`,
      x: ev.at.x * TILE + offsetX + TILE / 2,
      y: ev.at.y * TILE + offsetY,
      t: ev.t, ttl: FLOAT_TTL_MS, rise: 18,
      color: '#4ade80',
      font: 'bold 14px monospace',
    });
  }

  // Ability-cast callouts hover over the caster, naming what they just cast —
  // covers pure-CC/utility abilities (modifier/move/zone effects) that
  // otherwise produce no damage/heal float of their own.
  state.abilityCastFloats = state.abilityCastFloats.filter(ev => now - ev.t < FLOAT_TTL_MS);
  for (const ev of state.abilityCastFloats) {
    if (!ev.at) continue;
    const name = state.abilityDefs?.[ev.abilityId]?.name ?? ev.abilityId;
    drawFloatText({
      text: name,
      x: ev.at.x * TILE + offsetX + TILE / 2,
      y: ev.at.y * TILE + offsetY - 14,
      t: ev.t, ttl: FLOAT_TTL_MS, rise: 20,
      color: '#c58cff',
      font: 'bold 12px monospace',
    });
  }

  // Cast-failure floats hover above the player (the caster always sees their own).
  while (castFailFloats.length && now - castFailFloats[0]!.t >= FLOAT_TTL_MS) castFailFloats.shift();
  const selfForCastFloat = state.self;
  if (selfForCastFloat) {
    for (const f of castFailFloats) {
      drawFloatText({
        text: f.text,
        x: selfForCastFloat.position.x * TILE + offsetX + TILE / 2,
        y: selfForCastFloat.position.y * TILE + offsetY - 6,
        t: f.t, ttl: FLOAT_TTL_MS, rise: 14,
        color: '#ff8a4a',
        font: 'bold 13px monospace',
      });
    }
  }

  for (const [eid, sp] of state.speech) {
    if (now - sp.t > SPEECH_TTL_MS) { state.speech.delete(eid); continue; }
    const ent = entities.find(e => e.id === eid);
    if (!ent) continue;
    const age = now - sp.t;
    const alpha = age < SPEECH_TTL_MS - 500 ? 1 : 1 - (age - (SPEECH_TTL_MS - 500)) / 500;
    const text = sp.text;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    const padX = 6, padY = 4, lineH = 14, maxTextW = 130;
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxTextW && cur) { lines.push(cur); cur = word; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + padX * 2;
    const h = lines.length * lineH + padY * 2;
    const cx = ent.position.x * TILE + offsetX + TILE / 2;
    const cy = ent.position.y * TILE + offsetY - 14;
    ctx.globalAlpha = 0.85 * alpha;
    ctx.fillStyle = '#1a1a1a';
    ctx.strokeStyle = '#7acdf5';
    ctx.lineWidth = 1;
    const bx = Math.round(cx - w / 2);
    const by = Math.round(cy - h);
    ctx.fillRect(bx, by, w, h);
    ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(cx - 4, by + h);
    ctx.lineTo(cx, by + h + 4);
    ctx.lineTo(cx + 4, by + h);
    ctx.closePath();
    ctx.fillStyle = '#1a1a1a';
    ctx.fill();
    ctx.strokeStyle = '#7acdf5';
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#eee';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, cx, by + padY + (i + 1) * lineH - 2);
    }
    ctx.globalAlpha = 1;
  }

  const PICKUP_FLOAT_TTL_MS = 1400;
  state.pickupFloats = state.pickupFloats.filter(f => now - f.t < PICKUP_FLOAT_TTL_MS);
  if (self) {
    for (const f of state.pickupFloats) {
      drawFloatText({
        text: f.kind === 'gold' ? `+${f.amount} gold` : `+ ${f.name}`,
        x: self.position.x * TILE + offsetX + TILE / 2,
        y: self.position.y * TILE + offsetY - 26,
        t: f.t, ttl: PICKUP_FLOAT_TTL_MS, rise: 28,
        color: f.kind === 'gold' ? '#ffd84a' : '#bcd0e0',
        font: 'bold 12px monospace',
      });
    }
  }

  state.xpFloats = state.xpFloats.filter(f => now - f.t < XP_FLOAT_TTL_MS);
  if (self) {
    for (const f of state.xpFloats) {
      drawFloatText({
        text: `+${f.amount} XP`,
        x: self.position.x * TILE + offsetX + TILE / 2,
        y: self.position.y * TILE + offsetY - 12,
        t: f.t, ttl: XP_FLOAT_TTL_MS, rise: 36,
        color: '#7acdf5',
        font: 'bold 13px monospace',
      });
    }
  }

  if (state.zoneBanner && now - state.zoneBanner.t < ZONE_BANNER_TTL_MS) {
    const age = now - state.zoneBanner.t;
    const t = age / ZONE_BANNER_TTL_MS;
    const alpha = t < 0.15 ? t / 0.15 : t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    const y = canvas.height * 0.18;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = 'bold 42px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.strokeText(state.zoneBanner.name, canvas.width / 2, y);
    ctx.fillText(state.zoneBanner.name, canvas.width / 2, y);
    ctx.globalAlpha = 1;
  }

  const QUEST_COMPLETE_TTL_MS = 3200;
  state.questCompletions = state.questCompletions.filter((q) => now - q.t < QUEST_COMPLETE_TTL_MS);
  if (state.questCompletions.length > 0) {
    const q = state.questCompletions[0]!;
    const age = now - q.t;
    const t = age / QUEST_COMPLETE_TTL_MS;
    const alpha = t < 0.1 ? t / 0.1 : t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
    const y = canvas.height * 0.26;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.font = 'bold 22px monospace';
    ctx.fillStyle = '#ffd84a';
    ctx.strokeText('Quest Complete!', canvas.width / 2, y);
    ctx.fillText('Quest Complete!', canvas.width / 2, y);
    ctx.font = '14px monospace';
    ctx.fillStyle = '#ddd';
    ctx.strokeText(q.name, canvas.width / 2, y + 26);
    ctx.fillText(q.name, canvas.width / 2, y + 26);
    ctx.globalAlpha = 1;
  }

  const QUEST_STAGE_TTL_MS = 6000;
  state.questStageAdvances = state.questStageAdvances.filter((s) => now - s.t < QUEST_STAGE_TTL_MS);
  if (state.questStageAdvances.length > 0 && state.questCompletions.length === 0) {
    const s = state.questStageAdvances[0]!;
    const age = now - s.t;
    const t = age / QUEST_STAGE_TTL_MS;
    const alpha = t < 0.1 ? t / 0.1 : t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    const def = state.questDefs[s.questId];
    const stageDef = def?.stages?.find((st) => st.id === s.stage);
    const y = canvas.height * 0.26;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.font = 'bold 18px monospace';
    ctx.fillStyle = '#7acdf5';
    ctx.strokeText('Objective complete!', canvas.width / 2, y);
    ctx.fillText('Objective complete!', canvas.width / 2, y);
    if (stageDef?.text) {
      ctx.font = '13px monospace';
      ctx.fillStyle = '#bbb';
      const txt = stageDef.text.trim().replace(/\s+/g, ' ');
      const line = txt.length > 60 ? txt.slice(0, 57) + '…' : txt;
      ctx.strokeText(line, canvas.width / 2, y + 24);
      ctx.fillText(line, canvas.width / 2, y + 24);
    }
    ctx.globalAlpha = 1;
  }

  if (state.levelUp && now - state.levelUp.t < LEVEL_UP_TTL_MS) {
    const age = now - state.levelUp.t;
    const t = age / LEVEL_UP_TTL_MS;
    const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 56px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd84a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    const text = `LEVEL ${state.levelUp.level}!`;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 3);
    ctx.fillText(text, canvas.width / 2, canvas.height / 3);
    ctx.globalAlpha = 1;
  }

  if (state.died && state.diedAt) {
    const elapsed = now - state.diedAt;
    if (elapsed > RESPAWN_DELAY_MS + 5000) {
      state.died = false;
    } else {
      const remaining = Math.max(0, RESPAWN_DELAY_MS - elapsed);
      const secs = Math.ceil(remaining / 1000);
      ctx.fillStyle = 'rgba(80, 0, 0, 0.7)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 48px monospace';
      ctx.fillStyle = '#ffdddd';
      ctx.textAlign = 'center';
      ctx.fillText('You died', canvas.width / 2, canvas.height / 2 - 30);
      ctx.font = 'bold 24px monospace';
      ctx.fillText(`Respawning in ${secs}...`, canvas.width / 2, canvas.height / 2 + 20);
    }
  }

  const ptsText = (self?.components?.progress?.unspent_points || 0) > 0
    ? `  [${self!.components.progress.unspent_points} unspent — press C]` : '';
  const gold = self?.components?.wallet?.gold || 0;
  const goldText = `  ⛁ ${gold}`;
  const timeText = `  ${formatWorldTime(state.zone!.timeOfDay)}`;

  let hoverText = '';
  if (hoveredEntity) {
    const e = hoveredEntity;
    const lvl = e.level != null ? ` lv ${e.level}` : '';
    hoverText = `  ·  ${e.name || e.type}${lvl}`;
  } else if (hoveredTile && state.zone) {
    const tileType = isWild()
      ? wildTile(hoveredTile.x, hoveredTile.y)
      : (state.zone.grid[hoveredTile.y]?.[hoveredTile.x] ?? '');
    const tileLabel = tileType.replace(/_/g, ' ');
    hoverText = `  ·  (${hoveredTile.x},${hoveredTile.y}) ${tileLabel}`;
  }

  const inCombat = performance.now() - lastCombatAt < IN_COMBAT_TTL_MS && lastCombatAt > 0;
  const combatText = inCombat ? '  ⚔' : '';
  const hudText = self
    ? `zone: ${state.zone!.id}  pos: (${self.position.x},${self.position.y})${goldText}${timeText}${combatText}${ptsText}${hoverText}  [WASD · Space·F · C · I · Q · Enter chat  /g global  /w name pm]`
    : 'connected, waiting for state…';
  // Assigning textContent invalidates layout even when the string is identical,
  // and this line changes only when the player actually moves.
  if (hudText !== lastHudText) { hud.textContent = hudText; lastHudText = hudText; }

  updateHotbar();
  updateMenubar();
  updatePlayerFrame();
  updateTargetFrame();
  renderMinimap();
  requestAnimationFrame(render);
}

render();
