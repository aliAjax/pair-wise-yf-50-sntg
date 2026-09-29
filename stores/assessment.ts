import { computed, reactive, ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  migrateLegacy, isLegacyDump, isSyncState, commitLocal, replayIncoming, flushOutbox,
  resolveConflict, closeHousehold as engineClose, buildPeerBundle, buildStressBundle,
  localCreateHousehold, localCreateTask,
  type SyncState, type ChangeOp, type Household, type FieldTask, type TaskStatus
} from "~/utils/sync";

const KEY = "pair-wise-yf-50/assessment";
const DEVICE_KEY = "pair-wise-yf-50/deviceId";

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["孕妇"], needLevel: "紧急", needs: ["照明"], status: "待评估", note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

/** 旧版本地数据（v1，整条覆盖式队列）直接交给迁移器接续 */
function loadState(deviceId: string): SyncState {
  if (typeof window === "undefined") {
    return migrateLegacy({ households: seedHouseholds, tasks: seedTasks, queue: [], conflicts: [] }, deviceId);
  }
  const raw = localStorage.getItem(KEY);
  if (raw) {
    try {
      const dump = JSON.parse(raw);
      if (isSyncState(dump)) return dump;
      if (isLegacyDump(dump)) return migrateLegacy(dump, deviceId);
    } catch {
      // 损坏缓存：落回种子，避免白屏
    }
  }
  return migrateLegacy({ households: seedHouseholds, tasks: seedTasks, queue: [], conflicts: [] }, deviceId);
}

export interface MergeReport {
  total: number;
  accepted: number;
  duplicate: number;
  conflicts: number;
  rejected: number;
  durationMs: number;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const deviceId = ref(typeof window !== "undefined"
    ? (localStorage.getItem(DEVICE_KEY) || "平板-A")
    : "平板-A");
  const state = reactive<SyncState>(loadState(deviceId.value));
  state.deviceId = deviceId.value;

  const online = ref(true);
  const syncing = ref(false);
  const lastSyncedAt = ref<string | null>(null);
  const lastReport = ref<MergeReport | null>(null);
  const lastMessage = ref("");
  const simulateFailure = ref(false);
  /** 已由“其他平板”产生、等待联网后到达本机的操作包 */
  const incomingBin = ref<ChangeOp[]>([]);

  // ---------- 派生数据 ----------
  const households = computed(() => state.households);
  const tasks = computed(() => state.tasks);
  const conflicts = computed(() => state.conflicts);
  const ops = computed(() => [...state.ops].sort((a, b) => b.arrivalSeq - a.arrivalSeq));

  const pendingOps = computed(() => state.ops.filter((o) => o.delivery === "待发送"));
  const failedOps = computed(() => state.ops.filter((o) => o.delivery === "投递失败"));
  const reviewOps = computed(() => state.ops.filter((o) => o.delivery === "待核对"));

  const stats = computed(() => {
    const m = {
      households: state.households.length,
      urgent: state.households.filter((h) => h.needLevel === "紧急").length,
      queued: pendingOps.value.length + reviewOps.value.length,
      failed: failedOps.value.length,
      openConflicts: state.conflicts.filter((c) => c.status === "待选择").length
    };
    return m;
  });

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    state.households.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function openTaskCount(householdId: string): number {
    return state.tasks.filter((t) => resolveTaskHousehold(t.householdId) === householdId && t.status !== "已完成").length;
  }
  function resolveTaskHousehold(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    while (state.aliases[cur] && !seen.has(cur)) { seen.add(cur); cur = state.aliases[cur]; }
    return cur;
  }
  function householdById(id: string) {
    return state.households.find((h) => h.id === resolveTaskHousehold(id));
  }
  function opsOfRecord(recordId: string) {
    return ops.value.filter((o) => resolveTaskHousehold(o.recordId) === resolveTaskHousehold(recordId) || o.mergedFromId === recordId);
  }

  // ---------- 写操作：每个字段一条留痕 ----------
  function addHousehold(input: Omit<Household, "id" | "status">): { ok: boolean; reason?: string } {
    const r = localCreateHousehold(state, { ...input, status: "待评估" });
    return r.rejected ? { ok: false, reason: r.rejected } : { ok: true };
  }

  /** 字段级修改：一次调用 = 一条记录，绝不整条覆盖对端字段 */
  function updateField(householdId: string, field: string, value: unknown): { ok: boolean; reason?: string; effect?: string } {
    const r = commitLocal(state, { entity: "household", action: "update-field", recordId: householdId, field, value });
    if (r.rejected) return { ok: false, reason: r.rejected };
    return { ok: true, effect: r.op?.effect };
  }

  function mergeDuplicate(sourceId: string, targetId: string): { ok: boolean; reason?: string } {
    const r = commitLocal(state, { entity: "household", action: "merge-household", recordId: targetId, mergedFromId: sourceId });
    return r.rejected ? { ok: false, reason: r.rejected } : { ok: true };
  }

  function addTask(input: Omit<FieldTask, "id" | "status">): { ok: boolean; reason?: string } {
    const r = localCreateTask(state, input);
    if (r.rejected) return { ok: false, reason: r.rejected };
    // 有了在办任务，家庭进入已分派（同样是字段级一条留痕）
    const household = householdById(input.householdId);
    if (household && (household.status === "待评估" || household.status === "待复核")) {
      commitLocal(state, { entity: "household", action: "update-field", recordId: household.id, field: "status", value: "已分派" });
    }
    return { ok: true };
  }

  function advanceTask(id: string): { ok: boolean; reason?: string } {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return { ok: false, reason: "任务不存在" };
    if (task.status === "已完成") return { ok: false, reason: "任务已完成" };
    const next: TaskStatus = task.status === "待接收" ? "进行中" : "已完成";
    const r = commitLocal(state, { entity: "task", action: "advance-task", recordId: id, value: next });
    return r.rejected ? { ok: false, reason: r.rejected } : { ok: true };
  }

  /** 显式结案：任务未全部完成前不允许结掉家庭状态 */
  function closeHouseholdById(id: string): { ok: boolean; reason?: string } {
    return engineClose(state, id);
  }

  function resolveOne(conflictId: string, optionIndex: number) {
    return resolveConflict(state, conflictId, optionIndex);
  }

  /** 旧版待核对条目：人工核对后从待处理清单销项（审计日志保留） */
  function markReviewed(opId: string) {
    const op = state.ops.find((o) => o.id === opId);
    if (!op || op.delivery !== "待核对") return;
    op.delivery = "已确认";
    op.resultNote = `${op.resultNote ?? ""}；已人工核对销项`;
  }

  // ---------- 模拟“另一台平板” ----------
  function stagePeerEdits(householdId: string): number {
    const bundle = buildPeerBundle(state, householdId);
    state.nextArrivalSeq = Math.max(state.nextArrivalSeq, ...bundle.map((b) => b.arrivalSeq));
    incomingBin.value.push(...bundle);
    return bundle.length;
  }

  // ---------- 联网归并 ----------
  function syncNow(): MergeReport | null {
    if (!online.value) {
      lastMessage.value = "仍在离线/弱网，操作保留在本机待同步队列，恢复连接后按到达顺序重放。";
      return null;
    }
    syncing.value = true;
    const failEvery = simulateFailure.value ? 2 : 0;

    // 1) 本机待同步操作按到达顺序推送（失败只标记，重试幂等）
    const out = flushOutbox(state, failEvery);
    // 2) 对端到达的操作包按到达顺序重放，字段级三路合并
    const bundle = incomingBin.value;
    const inResult = bundle.length
      ? replayIncoming(state, bundle, failEvery)
      : { accepted: 0, duplicate: 0, conflicts: 0, rejected: 0, durationMs: 0 };
    incomingBin.value = [];

    const report: MergeReport = {
      total: out.confirmed + out.failed + bundle.length,
      accepted: inResult.accepted + out.confirmed,
      duplicate: inResult.duplicate,
      conflicts: inResult.conflicts,
      rejected: inResult.rejected,
      durationMs: inResult.durationMs
    };
    lastReport.value = report;
    lastSyncedAt.value = new Date().toISOString();
    lastMessage.value =
      `上送确认 ${out.confirmed} 条、失败 ${out.failed} 条；对端到达 ${bundle.length} 条` +
      (bundle.length ? `（归并 ${inResult.durationMs.toFixed(1)}ms）` : "") +
      (inResult.conflicts ? `；${inResult.conflicts} 个同字段冲突待人工选择，未静默覆盖` : "") +
      (inResult.rejected ? `；${inResult.rejected} 条被规则拒绝` : "");
    syncing.value = false;
    return report;
  }

  /** 恢复网络后 200 条修改 2 秒内归并的现场压测入口 */
  function stressMerge(householdId: string): MergeReport {
    const bundle = buildStressBundle(state, householdId);
    const r = replayIncoming(state, bundle);
    const report: MergeReport = { total: bundle.length, accepted: r.accepted, duplicate: r.duplicate, conflicts: r.conflicts, rejected: r.rejected, durationMs: r.durationMs };
    lastReport.value = report;
    lastSyncedAt.value = new Date().toISOString();
    lastMessage.value = `200 条修改归并完成，耗时 ${r.durationMs.toFixed(1)}ms（目标 < 2000ms）：生效 ${r.accepted}、幂等重复 ${r.duplicate}、冲突 ${r.conflicts}、拒绝 ${r.rejected}`;
    return report;
  }

  function setDevice(id: string) {
    deviceId.value = id;
    state.deviceId = id;
    if (typeof window !== "undefined") localStorage.setItem(DEVICE_KEY, id);
  }

  if (typeof window !== "undefined") {
    watch(state, () => {
      localStorage.setItem(KEY, JSON.stringify(state));
    }, { deep: true });
  }

  return {
    state, deviceId, online, syncing, lastSyncedAt, lastReport, lastMessage, simulateFailure,
    households, tasks, conflicts, ops, pendingOps, failedOps, reviewOps, incomingBin,
    stats, duplicates, openTaskCount, householdById, opsOfRecord,
    addHousehold, updateField, mergeDuplicate, addTask, advanceTask,
    closeHouseholdById, resolveOne, markReviewed, stagePeerEdits, syncNow, stressMerge, setDevice
  };
});
