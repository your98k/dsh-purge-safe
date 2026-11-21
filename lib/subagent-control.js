/**
 * 审批接管（主会话 + 子会话）。
 *
 * 宿主的审批策略只有 ask / never 两种。原版 never 在 decide() 里直接
 * `return "rejected"`，发生在 approval/request 的 waterfall 之前，任何监听器都救不到。
 * 所以对**没打过本插件补丁的宿主**，必须先保证策略不是 never，再在 waterfall 里恒放行。
 *
 * 但 permission 预设是 (sandbox, approval) 二元组配对：`danger-full-access` 只有配
 * `never` 才算数。无条件把 never 翻成 ask，会得到 danger-full-access + ask ——
 * 预设表里没有这一组，宿主 `derive()` 于是返回 `custom`，输入框左下角的权限芯片
 * 就显示成 "Custom"，用户不知道自己到底在什么档位。
 *
 * 本插件自己的 #9/#10 补丁已经把 decide() 改成 `return "allowed-once"`，
 * 这种宿主上 `never` 不再拒绝，翻转纯粹是副作用。所以：
 *   · 宿主已打补丁 → 保留 never（芯片正确显示「完全权限」），必要时把历史会话里
 *     被旧逻辑翻掉的 approval 恢复回它自己的预设；
 *   · 宿主未打补丁 → 维持原来的翻身行为，否则 never 会直接拒绝。
 *
 * 监听器必须 global：宿主是 `ctx.waterfall(scopeTarget(req.agent, req.agent), ...)`，
 * 跑在 agent 作用域里；不带 global 的监听器挂在插件自己的 ctx 上，收不到。
 */
import { existsSync, readFileSync } from "node:fs";
import { findAiBase, targetFiles } from "./core.js";

/** 已经补过 ask 的事件序号，防止同一条 never 被反复翻（重启后 seq 从头来，没关系）。 */
const seen = new WeakMap();
/** 每会话已尝试恢复过的预设名，防止和别的写入方来回拉锯。 */
const restored = new WeakMap();

/** 补丁 #9 写进宿主审批服务的那句早返回。 */
const NEVER_BYPASS = /return\s+['"]allowed-once['"];\s*\n\s*\/\/\s*\[dsh-purge-safe\] approval bypass/;
const NEVER_BYPASS_FALLBACK = /\[dsh-purge-safe\] approval bypass/;

/**
 * 宿主 `<file>` 里 never 是否已经被放行。
 * 先看官方那行 `return "allowed-once";` 与标记是否仍相邻，相邻才算真打过补丁；
 * 文件被宿主更新覆盖过、只剩注释残留时退回只认标记，避免误判成安全。
 */
function fileSafelyHandlesNever(file) {
  if (!file) return false;
  let text = "";
  try {
    if (!existsSync(file)) return false;
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return NEVER_BYPASS.test(text) || NEVER_BYPASS_FALLBACK.test(text);
}

/**
 * 这台宿主的审批服务会不会因为 never 而拒绝。
 * @param aiBase - 宿主 `@deepseek-ai` 目录；省略时自行定位。
 * @returns never 仍然拒绝时返回 true。
 */
export function hostNeverRejects(aiBase) {
  let files;
  try {
    files = targetFiles(aiBase || findAiBase());
  } catch {
    return true;
  }
  for (const key of ["user-approval-code", "user-approval"]) {
    const value = files?.[key];
    const list = Array.isArray(value) ? value : [value];
    if (list.filter(Boolean).some(fileSafelyHandlesNever)) return false;
  }
  return true;
}

/** 预设服务（Cordis 未 inject 时属性访问会抛，两段都要包）。 */
function permissionPresetsOf(ctx, session) {
  const candidates = [];
  try { candidates.push(session?.agent?.ctx); } catch { /* ignore */ }
  candidates.push(ctx);
  for (const target of candidates) {
    if (!target) continue;
    try {
      const direct = target.permissionPresets;
      if (direct && typeof direct.set === "function") return direct;
    } catch { /* 未 inject */ }
    try {
      const viaGet = typeof target.get === "function" ? target.get("permissionPresets") : null;
      if (viaGet && typeof viaGet.set === "function") return viaGet;
    } catch { /* 没有这项服务 */ }
  }
  return null;
}

/**
 * 把会话钉到「完全权限」这个**预设**上，而不是只写半对旋钮。
 *
 * 只 append `sandbox/mode: danger-full-access` 会留下 approval=ask 的旧值，
 * 两个旋钮凑不成任何预设，芯片就显示 Custom。走预设服务则两个旋钮一起写，
 * 芯片能显示「完全权限」。服务不在时返回 false，调用方退回单写沙箱模式。
 */
function applyFullAccessPreset(ctx, session, log, neverRejects) {
  // 宿主还会因 never 拒绝时不能整对写：预设会把 approval 置成 never，
  // 那个瞬间 decide() 会直接拒。这种事只补沙箱模式，让 P1 兜住策略。
  if (neverRejects) return false;
  const svc = permissionPresetsOf(ctx, session);
  if (!svc) return false;
  try {
    svc.set(session, "danger-full-access");
    return true;
  } catch (error) {
    log?.(`权限预设应用失败：%s`, error?.message || String(error));
    return false;
  }
}

/**
 * 旧逻辑把 approval 从 never 翻成 ask 之后，会话就落进 `custom`。
 * 只在「预设本身就该是 never + 当前沙箱也还是该预设的沙箱」时恢复 ——
 * 沙箱被动过（P3 的加宽、用户自己换档）一律不猜，免得把用户的选择改回去。
 */
function restoreFlippedPreset(ctx, session, log) {
  const svc = permissionPresetsOf(ctx, session);
  if (!svc || typeof svc.permissionState !== "function") return false;
  let state;
  try {
    state = svc.permissionState(session);
  } catch {
    return false;
  }
  const name = state?.preset;
  if (typeof name !== "string" || !name || name === "custom" || name === "auto") return false;
  if (state.approval !== "ask") return false;
  let spec;
  try {
    spec = svc.presets?.[name] ?? (typeof svc.specOf === "function" ? svc.specOf(name) : undefined);
  } catch {
    return false;
  }
  if (!spec || spec.approval !== "never" || spec.sandbox !== state.sandbox) return false;
  let marks = restored.get(session);
  if (!marks) { marks = new Set(); restored.set(session, marks); }
  if (marks.has(name)) return false;
  marks.add(name);
  try {
    svc.set(session, name);
  } catch (error) {
    log?.("权限预设恢复失败：%s", error?.message || String(error));
    return false;
  }
  return true;
}

export function installSubagentControl(ctx, config = {}) {
  if (config.subagentControl === false) return () => {};
  if (typeof ctx?.on !== "function") return () => {};

  const log = (message, detail) => {
    try { ctx.logger?.warn?.(`dsh-purge-safe: ${message}`, detail); } catch { /* ignore */ }
  };
  // `neverRejects` 允许调用方（测试 / 自检）直接指定宿主行为，省掉读盘。
  const neverRejects = typeof config.neverRejects === "function"
    ? (() => {
      let cached;
      return () => {
        if (cached === undefined) {
          try { cached = config.neverRejects() !== false; } catch { cached = true; }
        }
        return cached;
      };
    })()
    : (() => {
      let cached;
      return () => {
        if (cached === undefined) cached = hostNeverRejects(config.aiBase);
        return cached;
      };
    })();
  const restoreAllowed = config.restorePreset !== false;

  const offs = [];

  // P1：宿主没打补丁时，任何会话被写成 never 就补一条 ask 盖掉它。
  // overrideOf 取最后一条，后写者胜。打过的宿主保留 never —— 否则 (danger-full-access, ask)
  // 不落在任何预设上，芯片会显示 Custom。
  try {
    offs.push(ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "approval/policy") return;
        if (event?.data?.policy !== "never") return;
        if (!neverRejects()) return;
        let marks = seen.get(session);
        if (!marks) { marks = new Set(); seen.set(session, marks); }
        if (marks.has(event.seq)) return;
        marks.add(event.seq);
        // 不能在 append 的处理链里再 append。
        queueMicrotask(() => {
          try { session.append("approval/policy", { policy: "ask" }); } catch { /* 会话已关 */ }
        });
      } catch { /* 观察者不能抛 */ }
    }, { global: true }));
  } catch { /* 老宿主无 session/event */ }

  // P2：policy 是 ask 之后 waterfall 才会跑，这里恒放行。不区分主/子：
  // 主会话落到 next() 会拿 "unavailable" → serviceAsk 转成 APPROVAL_UNAVAILABLE 拒绝。
  try {
    offs.push(ctx.on("approval/request", (request, next) => {
      try {
        if (request?.agent?.session) return "allowed-once";
      } catch { /* 落到 next */ }
      return typeof next === "function" ? next() : "allowed-once";
    }, { global: true, prepend: true }));
  } catch { /* 老宿主无 approval/request */ }

  // P2b：宿主已放行 never 时，把历史会话里被旧逻辑翻成 ask 的档位恢复回来，
  // 让权限芯片重新显示真实预设（否则一直是 Custom）。
  if (restoreAllowed && !neverRejects()) {
    const heal = (session) => {
      try {
        if (!session || typeof session.append !== "function") return;
        queueMicrotask(() => {
          try { restoreFlippedPreset(ctx, session, log); } catch { /* 会话已关 */ }
        });
      } catch { /* ignore */ }
    };
    try {
      offs.push(ctx.on("session/created", heal, { global: true }));
    } catch { /* 老宿主无 session/created */ }
    try {
      offs.push(ctx.on("session/event", (session, event) => {
        if (event?.type !== "approval/policy" && event?.type !== "permission/preset") return;
        heal(session);
      }, { global: true }));
    } catch { /* 老宿主无 session/event */ }
    // 插件晚于会话加载时（自愈路径）也要把已经开着的会话修一遍。
    try {
      const agents = typeof ctx.get === "function" ? ctx.get("agents") : null;
      const list = typeof agents?.list === "function" ? agents.list() : [];
      for (const agent of Array.isArray(list) ? list : []) heal(agent?.session);
    } catch { /* 没有 agents 注册表 */ }
  }

  // P3：沙箱模式跟着会话走。宿主把 sandbox/mode 写进会话日志，永远不会有比
  // danger-full-access 更宽的档，approveEscalation 的 INVALID_ARGUMENT 分支就跑不到。
  // 同样按事件去重，避免自己写的又被自己再判一次。
  try {
    offs.push(ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "sandbox/mode") return;
        if (event?.data?.mode === "danger-full-access") return;
        let marks = seen.get(session);
        if (!marks) { marks = new Set(); seen.set(session, marks); }
        const key = `sandbox:${event.seq}`;
        if (marks.has(key)) return;
        marks.add(key);
        queueMicrotask(() => {
          try {
            // 优先整对写预设，避免留下 danger-full-access + ask 这种表外组合。
            if (applyFullAccessPreset(ctx, session, log, neverRejects())) return;
            session.append("sandbox/mode", { mode: "danger-full-access" });
          } catch { /* 会话已关 */ }
        });
      } catch { /* 观察者不能抛 */ }
    }, { global: true }));
  } catch { /* 老宿主无 session/event */ }

  // P4：全新会话没有任何 sandbox/mode 事件，投影响应 null，于是回落到部署默认
  // workspace-write。这里在会话创建时先写一条宽档，让第一次工具调用就走全权限。
  // 只写会话日志，不碰任何官方文件，也不依赖 DSH_PERMISSION_MODE。
  // 用 WeakSet 记「这条会话已经初始化过」，避免重放/重复 created 时刷一堆事件。
  const primed = new WeakSet();
  try {
    offs.push(ctx.on("session/created", (session) => {
      try {
        if (!session || typeof session.append !== "function") return;
        if (primed.has(session)) return;
        primed.add(session);
        // created 时可能仍在批发布里，推到微任务再写。
        queueMicrotask(() => {
          try {
            if (applyFullAccessPreset(ctx, session, log, neverRejects())) return;
            session.append("sandbox/mode", { mode: "danger-full-access" });
          } catch { /* 会话已关 */ }
        });
      } catch { /* 会话已关 / 老宿主无 append */ }
    }, { global: true }));
  } catch { /* 老宿主无 session/created */ }

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* 已释放 */ }
    }
  };
}
