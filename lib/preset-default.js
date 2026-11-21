/**
 * 停用/卸载时清掉指向本插件预设的 selectedDefault。
 * 宿主 resolve() 对未知预设是硬抛，不回退 config.default（#108）。
 */
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";

const OWNED_PRESET_IDS = ["redteam"];
const FALLBACK_PRESET = "standard";

function isOwnedPresetId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return false;
  return OWNED_PRESET_IDS.some((own) => id === own || id.endsWith(`/${own}`));
}

function readText(fp) {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

function writeText(fp, text) {
  fs.writeFileSync(fp, text, "utf8");
}

function listProfilePatchFiles(dshHome) {
  const root = path.join(dshHome, "profiles");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    const fp = path.join(root, name, "cordis.patch.yml");
    if (fs.existsSync(fp)) out.push(fp);
  }
  return out;
}

/** 只改 selectedDefault 指向本插件预设的值，不重排整份 YAML。 */
function repairSelectedDefaultInYaml(text, fallback = FALLBACK_PRESET) {
  const src = String(text || "");
  if (!/selectedDefault/.test(src)) return { text: src, changed: false };
  const next = src.replace(
    /(selectedDefault\s*:\s*)(["']?)(?:[\w.-]+\/)?redteam\2/gi,
    `$1$2${fallback}$2`,
  );
  return { text: next, changed: next !== src };
}

function repairProfilePatchFile(fp, fallback = FALLBACK_PRESET) {
  const raw = readText(fp);
  if (!raw) return { path: fp, changed: false };
  const { text, changed } = repairSelectedDefaultInYaml(raw, fallback);
  if (!changed) return { path: fp, changed: false };
  writeText(fp, text);
  return { path: fp, changed: true };
}

function configValue(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  try {
    if (typeof node.get === "function") return String(node.get() ?? "");
  } catch {
    /* ignore */
  }
  try {
    if (typeof node.value !== "undefined") return String(node.value ?? "");
  } catch {
    /* ignore */
  }
  return "";
}

function configSet(node, value) {
  if (!node) return false;
  try {
    if (typeof node.set === "function") {
      node.set(value);
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    node.value = value;
    return true;
  } catch {
    /* ignore */
  }
  return false;
}

function clearLiveSelectedDefault(ctx) {
  if (!ctx) return false;
  let persisted = false;
  try {
    const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
    const row = settings?.get?.("agent-preset-registry")
      || settings?.get?.("@deepseek-ai/dsh-agent-preset-registry");
    const selected = configValue(row?.config?.selectedDefault || row?.selectedDefault);
    if (isOwnedPresetId(selected) && typeof settings?.update === "function") {
      const fallback = configValue(row?.config?.default || row?.default) || FALLBACK_PRESET;
      if (fallback && !isOwnedPresetId(fallback)) {
        const ret = settings.update("agent-preset-registry", { selectedDefault: fallback });
        if (ret && typeof ret.then === "function") ret.catch(() => {});
        persisted = true;
      }
    }
  } catch {
    /* ignore */
  }
  const bags = [];
  try {
    const reg = (typeof ctx.get === "function" ? ctx.get("agentPresets") : null) || ctx.agentPresets;
    if (reg) bags.push(reg.config || reg);
  } catch {
    /* ignore */
  }
  try {
    const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
    const row = settings?.get?.("agent-preset-registry") || settings?.get?.("@deepseek-ai/dsh-agent-preset-registry");
    if (row) bags.push(row.config || row);
  } catch {
    /* ignore */
  }
  for (const bag of bags) {
    if (!bag) continue;
    const selected = bag.selectedDefault;
    const current = configValue(selected);
    if (!isOwnedPresetId(current)) continue;
    const fallback = configValue(bag.default) || FALLBACK_PRESET;
    if (configSet(selected, fallback)) return true;
  }
  return persisted;
}

/**
 * 停用/卸载时调用。失败只记结果，不抛。
 * @returns {{ live: boolean, files: string[] }}
 */
export function clearOwnedSelectedDefault({ ctx = null, dshHome = "" } = {}) {
  const home = dshHome || findDshHome();
  const report = { live: false, files: [] };
  try {
    report.live = clearLiveSelectedDefault(ctx);
  } catch {
    report.live = false;
  }
  if (!home) return report;
  for (const fp of listProfilePatchFiles(home)) {
    try {
      const row = repairProfilePatchFile(fp);
      if (row.changed) report.files.push(fp);
    } catch {
      /* 单个 profile 写失败不挡停用 */
    }
  }
  return report;
}

export function removeStaleAgentPresetDir(dshHome, id = "redteam") {
  const home = dshHome || findDshHome();
  if (!home || !id) return false;
  const dir = path.join(home, ".agent-presets", id);
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 名册里还认这个预设吗。读不到名册时返回 null（无法判断）。 */
async function registryStillDeclares(ctx, id) {
  try {
    const reg = typeof ctx?.get === "function" ? ctx.get("agentPresets") : ctx?.agentPresets;
    if (reg == null || typeof reg.list !== "function") return null;
    const rows = await reg.list();
    if (!Array.isArray(rows)) return null;
    return rows.some((row) => String(row?.id || "").trim().toLowerCase() === String(id).toLowerCase());
  } catch {
    return null;
  }
}

/**
 * 停用/卸载时清默认的那一套，**不能挂在普通 effect 回收上**。
 *
 * `patchReload: "live"` 的 profile 每次热重载都是「先 dispose 再 apply」：
 * 回收期当场清 `selectedDefault`，等于把用户在下拉里选的「红队模式」默认值
 * 每次热重载都改回 standard（还会顺手改写 profile 的 cordis.patch.yml 落盘）。
 * 用户看到的就是「选了红队，下一次发消息又变回标准」。
 *
 * 所以回收只做两件事：登记「本进程里还有没有插件实例活着」，然后排一次延迟复查。
 * 复查时实例数 > 0 就是热重载，什么都不做；确实一个都不剩（真停用/卸载）才清。
 */
const liveOwners = new Map(); // id -> 活着的 apply 次数

/** 每次 apply 时登记一次；返回释放函数，放进同一个 effect 的回收里。 */
export function holdOwnedPresetAlive(id = "redteam") {
  liveOwners.set(id, (liveOwners.get(id) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveOwners.set(id, Math.max(0, (liveOwners.get(id) || 0) - 1));
  };
}

export function scheduleOwnedSelectedDefaultSweep({ ctx = null, dshHome = "", delayMs = 4000, id = "redteam" } = {}) {
  const timer = setTimeout(() => {
    void (async () => {
      // 还有实例活着 → 这是热重载，用户选的默认值不能动。
      if ((liveOwners.get(id) || 0) > 0) return;
      // 名册里还认这个预设（别的途径重新声明了）→ 同理不动。
      if (await registryStillDeclares(ctx, id)) return;
      // registry.list() 可能跨一个 await；期间热重载若重新 apply，必须再次保留。
      if ((liveOwners.get(id) || 0) > 0) return;
      const home = dshHome || findDshHome();
      try { clearOwnedSelectedDefault({ ctx, dshHome: home }); } catch { /* 清理失败不挡停用 */ }
    })();
  }, delayMs);
  try { timer.unref?.(); } catch { /* ignore */ }
  return timer;
}
