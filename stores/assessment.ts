import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  emptyState,
  initEngineState,
  mergeBatches,
  replay,
  resolveConflict
} from "~/utils/sync";
import type {
  EngineState,
  FieldTask,
  Household,
  MergedField,
  Op,
  OpResult,
  TaskField
} from "~/utils/sync";

const KEY = "pair-wise-yf-50/assessment";
const DEVICE_KEY = "pair-wise-yf-50/device";

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 70 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

/** 模拟「服务端」上另一台平板已到达、但本机尚未拉取的操作（用于离线冲突演示）。 */
function seedInbox(): Op[] {
  const now = Date.now();
  return [
    {
      id: "remote-h1-address",
      deviceId: "dev-A",
      deviceLabel: "平板-评估员甲",
      type: "household.field",
      recordId: "h1",
      field: "address",
      value: "河湾路18号2栋2单元",
      clientTime: new Date(now - 20 * 60000).toISOString()
    },
    {
      id: "remote-h1-note",
      deviceId: "dev-A",
      deviceLabel: "平板-评估员甲",
      type: "household.field",
      recordId: "h1",
      field: "note",
      value: "一层受淹，老人行动不便；甲补充：急需折叠担架",
      clientTime: new Date(now - 19 * 60000).toISOString()
    }
  ];
}

function getDevice(): { id: string; label: string } {
  if (typeof window === "undefined") return { id: "dev-ssr", label: "本机" };
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev-B-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return { id, label: "本机平板-评估员乙" };
}

/** 深拷贝纯数据（state 全部可 JSON 序列化）；避免 structuredClone 无法克隆 Vue 响应式 Proxy。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 跨端 UUID（浏览器用原生 randomUUID，SSR/旧环境用时间戳+随机数兜底）。 */
function uuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 旧版本地缓存（整条覆盖时代的 queue）迁移：实体保留，旧改动转为可接续的 legacy.carried 操作。 */
function migrateLegacy(): { legacyOps: Op[]; raw: Record<string, unknown> | null } {
  if (typeof window === "undefined") return { legacyOps: [], raw: null };
  const cached = localStorage.getItem(KEY);
  if (!cached) return { legacyOps: [], raw: null };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(cached);
  } catch {
    return { legacyOps: [], raw: null };
  }
  if (!raw.queue || !Array.isArray(raw.queue) || raw.outbox) return { legacyOps: [], raw };
  const device = getDevice();
  const legacyOps: Op[] = (raw.queue as Array<{ id: string; time: string }>).map((item) => ({
    id: `legacy-${item.id}`,
    deviceId: device.id,
    deviceLabel: `${device.label}（旧版数据）`,
    type: "legacy.carried",
    clientTime: item.time ?? new Date().toISOString()
  }));
  return { legacyOps, raw };
}

export interface SyncReport {
  merged: number;
  conflicts: number;
  duplicates: number;
  failed: number;
  elapsedMs: number;
  partial: boolean;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const device = getDevice();
  const { legacyOps, raw } = migrateLegacy();

  /** serverState：已确认到达服务端的权威基线（首次启动即种子数据；旧版缓存则沿用旧实体）。 */
  const initialBaseline =
    raw?.serverState
      ? initEngineState(raw.serverState as EngineState)
      : raw && (raw.households || raw.tasks)
        ? initEngineState({ households: (raw.households as Household[]) ?? [], tasks: (raw.tasks as FieldTask[]) ?? [] })
        : initEngineState({ households: seedHouseholds, tasks: seedTasks });
  const serverState = ref<EngineState>(initialBaseline);
  /** outbox：本机离线产生、待发的字段级操作。 */
  const outbox = ref<Op[]>(raw?.outbox ? (raw.outbox as Op[]) : legacyOps);
  /**
   * pendingAck：已送达服务端并并入基线、但本次响应中断而未获确认的操作。
   * 下一轮重试会原样重发 —— 引擎凭幂等集合判为 duplicate，绝不执行第二次；
   * 它们已在 serverState 中，故不再参与 live 重放。
   */
  const pendingAck = ref<Op[]>(raw?.pendingAck ? (raw.pendingAck as Op[]) : []);
  /** audit：操作记录（来源设备、到达顺序、处理结果）。 */
  const audit = ref<OpResult[]>(raw?.audit ? (raw.audit as OpResult[]) : []);
  /** inbox：模拟服务端已收、待本机拉取的异地操作。 */
  const inbox = ref<Op[]>(raw?.inbox ? (raw.inbox as Op[]) : seedInbox());

  const online = ref(true);
  const lastSyncedAt = ref<string>(raw?.lastSyncedAt ? String(raw.lastSyncedAt) : new Date().toISOString());
  const syncing = ref(false);
  const lastReport = ref<SyncReport | null>(null);
  /** 演示开关：下一次同步中途失败（部分操作未送达），用于验证失败重试不执行两次。 */
  const failNextSync = ref(false);

  /**
   * live：当前界面看到的状态 = 服务端基线 + 本机 outbox 按序重放。
   * 本机操作在自己设备上不可能与自己冲突，重放结果仅用于驱动界面。
   */
  const live = ref<EngineState>(rebuildLive());

  function rebuildLive(): EngineState {
    const state = emptyState(clone(serverState.value.households), clone(serverState.value.tasks));
    replay(state, outbox.value.map((o) => ({ ...o })));
    // 冲突归服务端权威（本机未发操作不会与自己冲突），直接沿用已裁决/待处理状态
    state.conflicts = clone(serverState.value.conflicts);
    return state;
  }

  const households = computed(() => live.value.households);
  const tasks = computed(() => live.value.tasks);
  const conflicts = computed(() => live.value.conflicts);
  const queue = computed(() => [...pendingAck.value, ...outbox.value]);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: outbox.value.length + pendingAck.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const norm = (s: string) => s.replace(/[栋幢]/g, "栋").replace(/\s/g, "");
      const key = `${household.head}-${household.community}-${norm(household.address).slice(0, 8)}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function makeOp(partial: Omit<Op, "id" | "deviceId" | "deviceLabel" | "clientTime">): Op {
    return {
      id: uuid(),
      deviceId: device.id,
      deviceLabel: device.label,
      clientTime: new Date().toISOString(),
      ...partial
    };
  }

  /** 离线优先：先写 outbox 并立即在本机重放生效，联网后再与异地操作归并。 */
  function commit(...ops: Op[]) {
    outbox.value.push(...ops);
    live.value = rebuildLive();
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    const id = uuid();
    const ops: Op[] = [makeOp({ type: "household.create", recordId: id, value: input.head })];
    const fields: Array<[MergedField, unknown]> = [
      ["community", input.community],
      ["address", input.address],
      ["members", input.members],
      ["vulnerable", input.vulnerable],
      ["needLevel", input.needLevel],
      ["needs", input.needs],
      ["note", input.note]
    ];
    fields.forEach(([field, value], i) => {
      ops.push({ ...makeOp({ type: "household.field", recordId: id, field, value }), clientTime: new Date(Date.now() + i + 1).toISOString() });
    });
    commit(...ops);
  }

  /** 字段级修改：每个字段一条 oplog，不再整条覆盖。 */
  function updateHouseholdFields(id: string, patch: Partial<Pick<Household, MergedField>>) {
    const ops = Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([field, value], i) => ({
        ...makeOp({ type: "household.field" as const, recordId: id, field: field as MergedField, value }),
        clientTime: new Date(Date.now() + i + 1).toISOString()
      }));
    if (ops.length) commit(...ops);
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    commit(makeOp({ type: "household.merge", sourceId, targetId }));
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    const taskId = uuid();
    commit(
      makeOp({ type: "task.create", recordId: input.householdId, taskId, value: input.title }),
      makeOp({ type: "task.field", taskId, field: "assignee", value: input.assignee }),
      makeOp({ type: "task.field", taskId, field: "priority", value: input.priority }),
      makeOp({ type: "task.field", taskId, field: "due", value: input.due })
    );
  }

  function setTaskField(id: string, field: TaskField, value: unknown) {
    commit(makeOp({ type: "task.field", taskId: id, field, value }));
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task || task.status === "已完成") return;
    setTaskField(id, "status", task.status === "待接收" ? "进行中" : "已完成");
  }

  /**
   * 恢复网络后的归并：
   * - 异地（先到达服务端）+ 本机（后同步）操作按到达顺序统一编号重放；
   * - 不同字段自动合并，同一字段后到方挂起为冲突；
   * - 幂等键保证重试不执行两次；
   * - failNextSync 时只送达前半批，模拟中途失败。
   */
  async function synchronize(): Promise<SyncReport> {
    if (syncing.value) return lastReport.value!;
    syncing.value = true;
    await new Promise((resolve) => setTimeout(resolve, 400));

    const willFail = failNextSync.value;
    failNextSync.value = false;
    // 本轮尝试发送 = 未发 + 上轮已送达未确认（重发以触发幂等去重）
    const localOps = [...pendingAck.value, ...outbox.value].map((o) => ({ ...o }));
    const remoteOps = inbox.value.map((o) => ({ ...o }));
    const cutoff = willFail ? Math.ceil((localOps.length + remoteOps.length) / 2) : Number.POSITIVE_INFINITY;

    // 到达即编号；中途失败时，编号靠后的操作未送达，保持未处理。
    const delivered = new Set<string>();
    [...remoteOps, ...localOps].forEach((op, i) => {
      if (i < cutoff) delivered.add(op.id);
    });
    const deliveredRemote = remoteOps.filter((o) => delivered.has(o.id));
    const deliveredLocal = localOps.filter((o) => delivered.has(o.id));
    const undeliveredLocal = localOps.filter((o) => !delivered.has(o.id));

    const t0 = performance.now();
    const { state, results } = mergeBatches(serverState.value, deliveredLocal, deliveredRemote);
    const elapsedMs = performance.now() - t0;

    serverState.value = state;
    if (willFail) {
      // 已送达但未确认 → 留待下轮重发去重；未送达的继续待发
      pendingAck.value = deliveredLocal;
      outbox.value = undeliveredLocal;
    } else {
      pendingAck.value = [];
      outbox.value = undeliveredLocal;
    }
    inbox.value = remoteOps.filter((o) => !delivered.has(o.id));
    audit.value = [...audit.value, ...results].slice(-2000);
    lastSyncedAt.value = new Date().toISOString();
    live.value = rebuildLive();
    syncing.value = false;

    const report: SyncReport = {
      merged: results.filter((r) => r.type === "applied").length,
      conflicts: results.filter((r) => r.type === "conflict").length,
      duplicates: results.filter((r) => r.type === "duplicate").length,
      failed: undeliveredLocal.length,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      partial: willFail
    };
    lastReport.value = report;
    return report;
  }

  function resolveFieldConflict(id: string, choice: "采用旧值" | "采用新值") {
    // 冲突针对权威基线裁决；若挂起操作还在 outbox，裁决后直接移除（已被选择取代）
    const result = resolveConflict(serverState.value, id, choice, new Date().toISOString());
    if (result) audit.value = [...audit.value, result].slice(-2000);
    const conflict = serverState.value.conflicts.find((c) => c.id === id);
    if (conflict) outbox.value = outbox.value.filter((o) => o.id !== conflict.loserOpId);
    live.value = rebuildLive();
  }

  /** 压力演示：离线灌入 200 条字段修改并立即归并，核对 2 秒预算。 */
  async function benchmark(): Promise<SyncReport> {
    const fields: MergedField[] = ["address", "note", "needLevel", "members", "head", "community"];
    const batch: Op[] = Array.from({ length: 200 }, (_, i) =>
      makeOp({
        type: "household.field",
        recordId: seedHouseholds[i % 3].id,
        field: fields[i % fields.length],
        value: `压测-${fields[i % fields.length]}-${i}`
      })
    );
    outbox.value.push(...batch);
    const report = await synchronize();
    return report;
  }

  if (typeof window !== "undefined") {
    watch(
      [serverState, outbox, pendingAck, audit, inbox, lastSyncedAt],
      () => {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            serverState: serverState.value,
            outbox: outbox.value,
            pendingAck: pendingAck.value,
            audit: audit.value,
            inbox: inbox.value,
            lastSyncedAt: lastSyncedAt.value
          })
        );
      },
      { deep: true }
    );
  }

  return {
    device,
    households,
    tasks,
    conflicts,
    queue,
    outbox,
    pendingAck,
    audit,
    online,
    lastSyncedAt,
    syncing,
    lastReport,
    failNextSync,
    metrics,
    duplicates,
    addHousehold,
    updateHouseholdFields,
    mergeDuplicate,
    addTask,
    setTaskField,
    advanceTask,
    synchronize,
    resolveFieldConflict,
    benchmark
  };
});
