// 离线同步引擎：按记录/字段留痕，到达顺序重放，字段级三路合并。
// 纯 TypeScript，不依赖 Vue/Pinia，可在设备端与（将来的）服务端复用同一套规则。

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export type OpEntity = "household" | "task";
export type OpAction = "create-household" | "update-field" | "merge-household" | "create-task" | "advance-task";

/** 操作的处理结果（effect 是否真正执行） */
export type ApplyStatus = "已应用" | "自动合并" | "冲突" | "幂等忽略" | "转单应用" | "拒绝";

/** 操作的投递状态（网络层面，用于失败重试） */
export type DeliveryStatus = "待发送" | "投递失败" | "已确认" | "待核对";

/**
 * 一条修改记录 = 一条不可变操作日志（ChangeOp）。
 * 每个字段单独成条，携带来源设备、设备内序号、到达序号与处理结果。
 */
export interface ChangeOp {
  id: string;                 // 幂等键：同一操作重试时 id 不变，绝不执行两次
  entity: OpEntity;
  action: OpAction;
  recordId: string;           // householdId / taskId
  deviceId: string;           // 来源设备
  deviceSeq: number;          // 来源设备内的严格递增顺序
  opTime: string;             // 操作发生时间（设备时钟）
  arrivalSeq: number;         // 全局到达顺序，重放按此排序
  field?: string;             // 字段级修改：字段名
  value?: unknown;            // 字段新值 / 任务推进目标状态
  /** merge-household：被合并（删除）的记录 */
  mergedFromId?: string;
  effect: ApplyStatus;
  resultNote?: string;        // 处理结果说明（拒绝原因、幂等命中等）
  delivery: DeliveryStatus;   // 仅对本机待同步操作有意义
  appliedCount: number;       // effect 实际执行次数，正常恒为 1
}

/** 字段基线：当前值由哪台设备、哪个到达序号的操作写入 */
export interface FieldBasis {
  deviceId: string;
  arrivalSeq: number;
}

export interface ConflictOption {
  deviceId: string;
  arrivalSeq: number;
  value: unknown;
  chosen: boolean;
}

/** 同一字段冲突：展示基值（旧值）与各设备的新值，由用户选择 */
export interface FieldConflict {
  id: string;
  householdId: string;
  field: string;
  base: unknown;
  options: ConflictOption[]; // 至少两条，来自不同设备
  status: "待选择" | "已解决";
  resolvedBy?: string;
  resolvedAt?: string;
  // 解决时基于哪个到达序号落值（解决动作也留痕）
  resolvedArrivalSeq?: number;
}

export interface SyncState {
  schemaVersion: number;
  deviceId: string;
  deviceSeq: number;
  nextArrivalSeq: number;
  households: Household[];
  tasks: FieldTask[];
  /** 已见过的全部操作（含本机与对端），按 arrivalSeq 即审计顺序 */
  ops: ChangeOp[];
  /** recordId -> field -> 基线 */
  fieldBasis: Record<string, Record<string, FieldBasis>>;
  /** 合并产生的别名：已删除记录 id -> 保留记录 id，后续操作/任务自动转单 */
  aliases: Record<string, string>;
  conflicts: FieldConflict[];
}

const SCHEMA_VERSION = 2;

export function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a === "object" && a && typeof b === "object" && b) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function resolveId(state: SyncState, id: string): string {
  let cur = id;
  const seen = new Set<string>();
  while (state.aliases[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = state.aliases[cur];
  }
  return cur;
}

function householdById(state: SyncState, id: string): Household | undefined {
  return state.households.find((h) => h.id === resolveId(state, id));
}

function openTaskCount(state: SyncState, householdId: string): number {
  const canonical = resolveId(state, householdId);
  return state.tasks.filter((t) => resolveId(state, t.householdId) === canonical && t.status !== "已完成").length;
}

function getField(record: object, field: string): unknown {
  return (record as Record<string, unknown>)[field];
}

function setField(record: object, field: string, value: unknown) {
  (record as Record<string, unknown>)[field] = value;
}

/** 任务未全部完成时，不允许把家庭结为“已完成” */
function closeHouseholdBlocked(state: SyncState, householdId: string): boolean {
  return openTaskCount(state, householdId) > 0;
}

function setBasis(state: SyncState, recordId: string, field: string, deviceId: string, arrivalSeq: number) {
  const canonical = resolveId(state, recordId);
  state.fieldBasis[canonical] ??= {};
  state.fieldBasis[canonical][field] = { deviceId, arrivalSeq };
}

function getBasis(state: SyncState, recordId: string, field: string): FieldBasis | undefined {
  const canonical = resolveId(state, recordId);
  return state.fieldBasis[canonical]?.[field];
}

function findOpenConflict(state: SyncState, householdId: string, field: string): FieldConflict | undefined {
  const canonical = resolveId(state, householdId);
  return state.conflicts.find((c) => c.status === "待选择" && resolveId(state, c.householdId) === canonical && c.field === field);
}

interface ApplyResult {
  effect: ApplyStatus;
  note?: string;
}

/**
 * 字段修改重放规则（按到达顺序逐条执行）：
 * - 改的字段与基线不同设备 → 不同字段自动合并（互不影响）；
 *   同字段值相同 → 自动合并；同字段值不同 → 生成冲突，展示新旧值供选择。
 * - 同设备同字段按设备序号快速前进（后写覆盖先写，天然不冲突）。
 * - effect 已执行过的同 id 操作 → 幂等忽略，重试绝不执行第二次。
 */
function applyFieldEdit(state: SyncState, op: ChangeOp): ApplyResult {
  const household = householdById(state, op.recordId);
  if (!household) return { effect: "拒绝", note: "家庭记录不存在（可能已被合并且无别名）" };

  if (op.field === "status" && op.value === "已完成" && closeHouseholdBlocked(state, household.id)) {
    return { effect: "拒绝", note: `仍有 ${openTaskCount(state, household.id)} 个未完成任务，不能结掉家庭状态` };
  }

  const field = op.field!;
  const current = getField(household, field);
  const basis = getBasis(state, household.id, field);

  // 中立基线（初始快照/旧版迁移）：第一台设备的修改直接接管，不算冲突
  if (!basis || basis.deviceId === "初始快照") {
    if (jsonEqual(current, op.value)) {
      setBasis(state, household.id, field, op.deviceId, op.arrivalSeq);
      return { effect: "自动合并", note: "与初始值一致" };
    }
    setField(household, field, op.value);
    setBasis(state, household.id, field, op.deviceId, op.arrivalSeq);
    return { effect: "已应用" };
  }

  // 同设备后写：快速前进
  if (basis.deviceId === op.deviceId) {
    if (jsonEqual(current, op.value)) return { effect: "幂等忽略", note: "同设备重复值" };
    setField(household, field, op.value);
    setBasis(state, household.id, field, op.deviceId, op.arrivalSeq);
    return { effect: "已应用" };
  }

  // 不同设备改同字段
  if (jsonEqual(current, op.value)) {
    setBasis(state, household.id, field, op.deviceId, op.arrivalSeq);
    return { effect: "自动合并", note: "各设备取值一致" };
  }

  // 值不同 → 收集为冲突选项（不静默覆盖）
  const existing = findOpenConflict(state, household.id, field);
  if (existing) {
    const sameDeviceOption = existing.options.find((o) => o.deviceId === op.deviceId);
    if (sameDeviceOption) {
      // 同设备在冲突未决期间又改：以更大到达序号的值替换其选项
      if (op.arrivalSeq > sameDeviceOption.arrivalSeq) {
        sameDeviceOption.value = op.value;
        sameDeviceOption.arrivalSeq = op.arrivalSeq;
      }
      return { effect: "冲突", note: "加入待处理冲突（同设备更新候选值）" };
    }
    existing.options.push({ deviceId: op.deviceId, arrivalSeq: op.arrivalSeq, value: op.value, chosen: false });
    return { effect: "冲突", note: "加入待处理冲突" };
  }

  state.conflicts.push({
    id: createId(),
    householdId: resolveId(state, household.id),
    field,
    base: current,
    options: [
      { deviceId: basis.deviceId, arrivalSeq: basis.arrivalSeq, value: current, chosen: false },
      { deviceId: op.deviceId, arrivalSeq: op.arrivalSeq, value: op.value, chosen: false }
    ],
    status: "待选择"
  });
  return { effect: "冲突", note: "与现有值不同，等待人工选择" };
}

function applyCreateHousehold(state: SyncState, op: ChangeOp): ApplyResult {
  if (state.households.some((h) => h.id === op.recordId)) {
    return { effect: "幂等忽略", note: "记录已存在" };
  }
  const seed = op as unknown as { snapshot?: Household };
  if (!seed.snapshot) return { effect: "拒绝", note: "缺少记录快照" };
  const record: Household = JSON.parse(JSON.stringify(seed.snapshot));
  record.id = op.recordId;
  state.households.unshift(record);
  // 所有字段基线都归属创建操作
  Object.keys(record).forEach((field) => setBasis(state, record.id, field, op.deviceId, op.arrivalSeq));
  return { effect: "已应用" };
}

/**
 * 重复登记合并：任务全部转到保留记录（别名 + householdId 重写双保险），
 * 需求/特殊照护取并集；被合并记录后续到达的修改自动落到保留记录。
 */
function applyMerge(state: SyncState, op: ChangeOp): ApplyResult {
  const sourceId = op.mergedFromId;
  if (!sourceId) return { effect: "拒绝", note: "缺少被合并记录" };

  // 幂等：源记录已并入同一目标
  if (resolveId(state, sourceId) === resolveId(state, op.recordId) && !state.households.some((h) => h.id === sourceId)) {
    return { effect: "幂等忽略", note: "重复合并操作" };
  }

  const source = state.households.find((h) => h.id === sourceId);
  const target = householdById(state, op.recordId);
  if (!source || !target) return { effect: "拒绝", note: "合并记录不存在" };

  const transferred: string[] = [];
  state.tasks.forEach((task) => {
    if (task.householdId === source.id) {
      task.householdId = target.id;
      transferred.push(task.id);
    }
  });

  target.needs = Array.from(new Set([...target.needs, ...source.needs]));
  target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
  if (source.note && !target.note.includes(source.note)) {
    target.note = target.note ? `${target.note}；${source.note}` : source.note;
  }

  // 源记录字段基线并入目标
  const sourceBasis = state.fieldBasis[source.id];
  if (sourceBasis) {
    state.fieldBasis[target.id] ??= {};
    Object.entries(sourceBasis).forEach(([field, basis]) => {
      const cur = state.fieldBasis[target.id][field];
      if (!cur || basis.arrivalSeq > cur.arrivalSeq) state.fieldBasis[target.id][field] = basis;
    });
    delete state.fieldBasis[source.id];
  }

  state.aliases[source.id] = target.id;
  state.households = state.households.filter((h) => h.id !== source.id);

  // 合并后任务可能仍挂在该家庭，结户校验由后续 update-field 统一拦截
  const open = openTaskCount(state, target.id);
  if (open === 0 && target.status === "已完成") {
    setBasis(state, target.id, "status", op.deviceId, op.arrivalSeq);
  }
  return {
    effect: "转单应用",
    note: `${source.head}(${source.address}) 已并入保留记录` + (transferred.length ? `；转入 ${transferred.length} 个任务` : "")
  };
}

function applyCreateTask(state: SyncState, op: ChangeOp): ApplyResult {
  if (state.tasks.some((t) => t.id === op.recordId)) return { effect: "幂等忽略", note: "任务已存在" };
  const seed = op as unknown as { snapshot?: FieldTask };
  if (!seed.snapshot) return { effect: "拒绝", note: "缺少任务快照" };
  const household = householdById(state, op.recordId);
  if (!household) return { effect: "拒绝", note: "任务对应的家庭记录不存在" };
  const task: FieldTask = JSON.parse(JSON.stringify(seed.snapshot));
  task.id = op.recordId;
  task.householdId = household.id; // 合并后到达的建任务操作，自动挂到保留记录
  state.tasks.unshift(task);
  return { effect: "已应用" };
}

function applyAdvanceTask(state: SyncState, op: ChangeOp): ApplyResult {
  const task = state.tasks.find((t) => t.id === op.recordId);
  if (!task) return { effect: "拒绝", note: "任务不存在" };
  const target = op.value as TaskStatus;
  if (task.status === target) return { effect: "幂等忽略", note: "任务已处于该状态" };
  task.status = target;

  // 最后一个任务完成不自动结户：结户必须显式操作且通过“任务清零”校验
  return { effect: "已应用", note: target === "已完成" ? "任务完成；家庭状态仍需显式结案" : undefined };
}

function applyOne(state: SyncState, op: ChangeOp): ApplyResult {
  // 同一操作（id）effect 已执行过 → 重试时绝不执行第二次
  const seen = state.ops.find((o) => o.id === op.id);
  if (seen && seen.appliedCount > 0) {
    return { effect: "幂等忽略", note: `重试命中：effect 已于到达序号 ${seen.arrivalSeq} 执行` };
  }
  if (seen && seen.effect === "冲突") {
    return { effect: "幂等忽略", note: "重试命中：冲突已在候选列表中" };
  }

  switch (op.action) {
    case "create-household": return applyCreateHousehold(state, op);
    case "update-field": return applyFieldEdit(state, op);
    case "merge-household": return applyMerge(state, op);
    case "create-task": return applyCreateTask(state, op);
    case "advance-task": return applyAdvanceTask(state, op);
    default: return { effect: "拒绝", note: "未知操作类型" };
  }
}

function commitOp(state: SyncState, op: ChangeOp): ChangeOp {
  const existing = state.ops.find((o) => o.id === op.id);
  if (existing) return existing; // 同 id 只处理一次
  const result = applyOne(state, op);
  const stored: ChangeOp = {
    ...op,
    effect: result.effect,
    resultNote: result.note,
    appliedCount: ["幂等忽略", "拒绝", "冲突"].includes(result.effect) ? 0 : 1
  };
  state.ops.push(stored);
  return stored;
}

/** 造一条本机操作（字段级留痕） */
type OpDraft = Omit<ChangeOp, "id" | "deviceId" | "deviceSeq" | "opTime" | "arrivalSeq" | "effect" | "delivery" | "appliedCount">;

export function craftOp(state: SyncState, input: OpDraft): ChangeOp {
  return {
    ...input,
    id: createId(),
    deviceId: state.deviceId,
    deviceSeq: state.deviceSeq + 1,
    opTime: new Date().toISOString(),
    arrivalSeq: state.nextArrivalSeq + 1,
    effect: "待发送" as unknown as ApplyStatus,
    delivery: "待发送",
    appliedCount: 0
  };
}

/** 本机提交：先占序号/时钟，立即本地生效（离线可用），进入待同步队列 */
export function commitLocal(state: SyncState, draft: OpDraft): { op?: ChangeOp; rejected?: string } {
  const op = craftOp(state, draft);
  state.deviceSeq += 1;
  state.nextArrivalSeq += 1;
  const stored = commitOp(state, op);
  if (stored.effect === "拒绝") {
    return { rejected: stored.resultNote ?? "操作被拒绝" };
  }
  // 冲突/已应用都留在待同步队列，等待对端确认；旧版“待核对”条目不参与重放
  stored.delivery = "待发送";
  return { op: stored };
}

/** 本机新增家庭（带快照，创建后每个字段基线归本机） */
export function localCreateHousehold(state: SyncState, record: Omit<Household, "id"> & { id?: string }): { id?: string; rejected?: string } {
  const id = record.id ?? createId();
  const snapshot: Household = { ...record, id };
  const r = commitLocal(state, { entity: "household", action: "create-household", recordId: id, snapshot } as OpDraft);
  return r.rejected ? { rejected: r.rejected } : { id };
}

/** 本机分派任务（带快照；若家庭已被合并，自动挂到保留记录） */
export function localCreateTask(state: SyncState, task: Omit<FieldTask, "id" | "status"> & { id?: string }): { id?: string; rejected?: string } {
  const id = task.id ?? createId();
  const snapshot: FieldTask = { ...task, id, status: "待接收" };
  const r = commitLocal(state, { entity: "task", action: "create-task", recordId: id, snapshot } as OpDraft);
  return r.rejected ? { rejected: r.rejected } : { id };
}

export interface IncomingResult {
  accepted: number;
  duplicate: number;
  conflicts: number;
  rejected: number;
  durationMs: number;
}

/**
 * 联网后重放：对端操作按到达顺序（arrivalSeq）归并。
 * 已见过的 id 直接幂等忽略；200 条的性能目标在同一次遍历内完成（见 replayIncoming）。
 */
export function replayIncoming(state: SyncState, bundle: ChangeOp[], failEvery = 0): IncomingResult {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const result: IncomingResult = { accepted: 0, duplicate: 0, conflicts: 0, rejected: 0, durationMs: 0 };

  // 模拟网络失败：第 failEvery 个“新”操作 ACK 失败（effect 只执行一次，重试靠幂等）
  let freshIndex = 0;

  bundle
    .map((op) => ({ ...op }))
    .sort((a, b) => a.arrivalSeq - b.arrivalSeq || a.deviceSeq - b.deviceSeq)
    .forEach((op) => {
      const existing = state.ops.find((o) => o.id === op.id);
      if (existing) {
        result.duplicate += 1;
        // 重试场景：之前投递失败的对端操作，这次确认；effect 不会再执行
        if (existing.delivery === "投递失败") existing.delivery = "已确认";
        return;
      }
      if (op.arrivalSeq > state.nextArrivalSeq) state.nextArrivalSeq = op.arrivalSeq;

      freshIndex += 1;
      const ackFailed = failEvery > 0 && freshIndex % failEvery === 0;
      const stored = commitOp(state, op);
      stored.delivery = ackFailed ? "投递失败" : "已确认";
      if (ackFailed) stored.resultNote = `${stored.resultNote ?? ""}（ACK 丢失，等待重试，effect 不重复执行）`.trim();

      if (stored.appliedCount > 0) result.accepted += 1;
      if (stored.effect === "冲突") result.conflicts += 1;
      if (stored.effect === "拒绝") result.rejected += 1;
    });

  result.durationMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
  return result;
}

/**
 * 待同步队列重试推送：按到达顺序提交，失败的操作保持“投递失败”，
 * 下次重试时因 id 已存在而幂等忽略，绝不执行两次。
 */
export function flushOutbox(state: SyncState, failEvery = 0): { confirmed: number; failed: number; durationMs: number } {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  let confirmed = 0;
  let failed = 0;
  let attempt = 0;
  state.ops
    .filter((op) => op.deviceId === state.deviceId && (op.delivery === "待发送" || op.delivery === "投递失败"))
    .sort((a, b) => a.arrivalSeq - b.arrivalSeq)
    .forEach((op) => {
      attempt += 1;
      const ackFailed = failEvery > 0 && attempt % failEvery === 0;
      if (ackFailed) {
        op.delivery = "投递失败";
        op.resultNote = `${op.resultNote ?? ""}（ACK 丢失，重试不会重复执行）`.replace(/^（/, "（");
        failed += 1;
      } else {
        op.delivery = "已确认";
        confirmed += 1;
      }
    });
  return { confirmed, failed, durationMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - start };
}

/** 冲突解决：在候选值中选择一个落值，解决动作本身按到达顺序留痕 */
export function resolveConflict(state: SyncState, conflictId: string, optionIndex: number): boolean {
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict || conflict.status !== "待选择") return false;
  const option = conflict.options[optionIndex];
  if (!option) return false;
  const household = householdById(state, conflict.householdId);
  if (!household) return false;

  if (conflict.field === "status" && option.value === "已完成" && closeHouseholdBlocked(state, household.id)) {
    return false;
  }

  state.nextArrivalSeq += 1;
  setField(household, conflict.field, option.value);
  setBasis(state, household.id, conflict.field, option.deviceId, option.arrivalSeq);
  conflict.options.forEach((o, i) => { o.chosen = i === optionIndex; });
  conflict.status = "已解决";
  conflict.resolvedBy = state.deviceId;
  conflict.resolvedAt = new Date().toISOString();
  conflict.resolvedArrivalSeq = state.nextArrivalSeq;

  state.ops.push({
    id: createId(),
    entity: "household",
    action: "update-field",
    recordId: household.id,
    deviceId: state.deviceId,
    deviceSeq: (state.deviceSeq += 1),
    opTime: conflict.resolvedAt,
    arrivalSeq: state.nextArrivalSeq,
    field: conflict.field,
    value: option.value,
    effect: "已应用",
    resultNote: `冲突解决：采用设备 ${option.deviceId} 的值（候选 ${conflict.options.length} 选 1）`,
    delivery: "已确认",
    appliedCount: 1
  });
  return true;
}

/** 显式结案：任务未清零时拒绝 */
export function closeHousehold(state: SyncState, householdId: string): { ok: boolean; reason?: string } {
  const household = householdById(state, householdId);
  if (!household) return { ok: false, reason: "家庭记录不存在" };
  if (closeHouseholdBlocked(state, household.id)) {
    return { ok: false, reason: `仍有 ${openTaskCount(state, household.id)} 个未完成任务，任务全部完成前不能结案` };
  }
  commitLocal(state, { entity: "household", action: "update-field", recordId: household.id, field: "status", value: "已完成" });
  return { ok: true };
}

export interface SyncMetrics {
  pending: number;
  needsReview: number;
  failed: number;
  openConflicts: number;
  applied: number;
  merged: number;
  rejected: number;
}

export function metrics(state: SyncState): SyncMetrics {
  return {
    pending: state.ops.filter((o) => o.delivery === "待发送" || o.delivery === "待核对").length,
    needsReview: state.ops.filter((o) => o.delivery === "待核对").length,
    failed: state.ops.filter((o) => o.delivery === "投递失败").length,
    openConflicts: state.conflicts.filter((c) => c.status === "待选择").length,
    applied: state.ops.filter((o) => o.appliedCount > 0).length,
    merged: state.ops.filter((o) => o.action === "merge-household" && o.appliedCount > 0).length,
    rejected: state.ops.filter((o) => o.effect === "拒绝").length
  };
}

// ---------- 旧版本地数据接续（schema v1 -> v2） ----------

interface LegacyPendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
}
interface LegacyConflict {
  id: string;
  householdId: string;
  field: string;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
}
interface LegacyDump {
  households?: Household[];
  tasks?: FieldTask[];
  queue?: LegacyPendingChange[];
  conflicts?: LegacyConflict[];
  lastSyncedAt?: string;
}

/**
 * 旧版“整条覆盖”的待同步队列没有字段级信息，无法安全重放：
 * 标记为“待核对”原样接续进审计日志，不参与自动重放、不覆盖数据，由人工补录。
 */
export function migrateLegacy(dump: LegacyDump, deviceId: string): SyncState {
  const households: Household[] = (dump.households ?? []).map((h) => {
    const { version: _version, deviceUpdatedAt: _time, ...rest } = h as Household & { version?: number; deviceUpdatedAt?: string };
    return rest;
  });
  const state: SyncState = {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    deviceSeq: 0,
    nextArrivalSeq: 0,
    households,
    tasks: dump.tasks ?? [],
    ops: [],
    fieldBasis: {},
    aliases: {},
    conflicts: []
  };

  // 存量记录的字段基线归属初始快照，使对端第一条修改能正确触发合并/冲突
  households.forEach((h) => {
    Object.keys(h).forEach((field) => setBasis(state, h.id, field, "初始快照", 0));
  });

  (dump.queue ?? []).forEach((item) => {
    state.nextArrivalSeq += 1;
    state.ops.push({
      id: `legacy-${item.id}`,
      entity: item.entity.includes("任务") ? "task" : "household",
      action: "update-field",
      recordId: "legacy",
      deviceId: "旧版设备",
      deviceSeq: 0,
      opTime: item.time,
      arrivalSeq: state.nextArrivalSeq,
      field: "(旧版整条记录)",
      value: item.detail,
      effect: "自动合并",
      resultNote: `旧版待同步数据已接续：${item.entity}/${item.action}，缺少字段级信息，需人工核对补录`,
      delivery: "待核对",
      appliedCount: 0
    });
  });

  // 旧版冲突转成新的字段冲突候选（旧值/远端值）
  (dump.conflicts ?? []).forEach((c) => {
    const household = households.find((h) => h.id === c.householdId);
    if (!household) return;
    state.nextArrivalSeq += 1;
    const resolved = c.status !== "待处理";
    state.conflicts.push({
      id: `legacy-conflict-${c.id}`,
      householdId: c.householdId,
      field: c.field,
      base: c.remoteValue,
      options: [
        { deviceId: "本机(旧)", arrivalSeq: 0, value: c.localValue, chosen: c.status === "采用本地" },
        { deviceId: "远端(旧)", arrivalSeq: state.nextArrivalSeq, value: c.remoteValue, chosen: c.status === "采用远端" }
      ],
      status: resolved ? "已解决" : "待选择",
      resolvedBy: resolved ? "旧版迁移" : undefined
    });
  });

  return state;
}

export function isLegacyDump(dump: unknown): boolean {
  if (!dump || typeof dump !== "object") return false;
  const d = dump as Record<string, unknown>;
  return Array.isArray(d.households) && !("schemaVersion" in d) && !("ops" in d);
}

export function isSyncState(dump: unknown): dump is SyncState {
  if (!dump || typeof dump !== "object") return false;
  return "schemaVersion" in (dump as Record<string, unknown>) && "ops" in (dump as Record<string, unknown>);
}

// ---------- 演示/性能用的对端操作包构造 ----------

function makeBundleOp(deviceId: string, deviceSeq: number, arrivalSeq: number, op: Omit<ChangeOp, "id" | "deviceId" | "deviceSeq" | "arrivalSeq" | "opTime" | "effect" | "delivery" | "appliedCount">): ChangeOp {
  return { ...op, id: createId(), deviceId, deviceSeq, arrivalSeq, opTime: new Date(Date.now() - (200 - arrivalSeq) * 1000).toISOString(), effect: "已确认" as ApplyStatus, delivery: "已确认", appliedCount: 1 };
}

/** 另一台平板（平板-B）离线后改了同一户：不同字段自动合并 + 同字段冲突各一条 */
export function buildPeerBundle(state: SyncState, householdId: string): ChangeOp[] {
  const base = state.nextArrivalSeq;
  const household = state.households.find((h) => h.id === householdId);
  if (!household) return [];
  return [
    makeBundleOp("平板-B", 1, base + 1, { entity: "household", action: "update-field", recordId: householdId, field: "note", value: `${household.note}；B机补充：门口积水约30cm` }),
    makeBundleOp("平板-B", 2, base + 2, { entity: "household", action: "update-field", recordId: householdId, field: "address", value: "河湾路18号2栋2单元" })
  ];
}

/**
 * 性能包：200 条修改。190 条字段编辑按 (设备 × 字段) 分片互不冲突，
 * 10 条为重放包内已有 id 的重复投递（验证幂等路径）。
 * 目标：恢复网络后 200 条在 2 秒内归并。
 */
export function buildStressBundle(state: SyncState, householdId: string): ChangeOp[] {
  const devices = ["平板-B", "平板-C", "平板-D"];
  const fields = ["head", "community", "address", "members", "needLevel", "note", "status"];
  const fieldValues: Record<string, (i: number) => unknown> = {
    head: (i) => `户主${i}`,
    community: (i) => `社区${(i % 5) + 1}`,
    address: (i) => `性能路${i}号`,
    members: (i) => (i % 9) + 1,
    needLevel: (i) => (["紧急", "高", "一般"] as const)[i % 3],
    note: (i) => `压力测试备注 ${i}`,
    status: () => "待复核" as HouseholdStatus
  };
  const base = state.nextArrivalSeq;
  const ops: ChangeOp[] = [];
  for (let i = 0; i < 190; i++) {
    const field = fields[i % fields.length];
    // 每个字段在包内固定由一台设备修改：跨设备不碰同字段（不同字段自动合并），
    // 同设备同字段按序快进，整包不产生冲突。
    const device = devices[fields.indexOf(field) % devices.length];
    // 每个 (设备,字段) 组合独立：同设备同字段按序快进，跨设备不碰同字段
    ops.push(makeBundleOp(device, i + 1, base + 1 + i, {
      entity: "household", action: "update-field", recordId: householdId, field, value: fieldValues[field](i)
    }));
  }
  // 10 条重复投递（相同 id），走幂等忽略分支
  for (let i = 0; i < 10; i++) {
    ops.push({ ...ops[i * 17], delivery: "已确认" });
  }
  return ops;
}
