/**
 * 离线操作日志（oplog）与字段级归并重放引擎（纯函数，框架无关）。
 *
 * 设计目标对应需求：
 * - 平板离线修改同一户：每次修改按「记录 + 字段」生成操作日志（oplog），
 *   不再整条记录覆盖，任务字段不会因为后同步方整对象覆盖而丢失。
 * - 联网后按到达顺序（arrivalSeq）重放：不同字段自动合并；同一字段
 *   先到先得，后到方登记为字段冲突，保留新旧值供人工选择。
 * - 重复登记合并：任务先转移到保留记录，源记录再删除；任务全部完成前
 *   家庭状态不得结为「已完成」（deriveHouseholdStatus + 业务规则拦截）。
 * - 幂等：同 id 的操作只生效一次，同步失败重试不会执行两次。
 *
 * 引擎不依赖 Vue / Pinia / localStorage，输入纯数据、输出纯数据，便于单测。
 */

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

/** 参与字段级合并的家庭字段（其余字段由专用操作处理）。 */
export const MERGED_FIELDS = [
  "head",
  "community",
  "address",
  "members",
  "vulnerable",
  "needLevel",
  "needs",
  "note"
] as const;
export type MergedField = (typeof MERGED_FIELDS)[number];

/** 任务字段同样按字段合并，避免任务被整条覆盖。 */
export const TASK_FIELDS = ["title", "assignee", "priority", "due", "status"] as const;
export type TaskField = (typeof TASK_FIELDS)[number];

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
  version: number;
  deviceUpdatedAt: string;
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

export type OpType =
  | "household.create"
  | "household.field"
  | "household.merge"
  | "task.create"
  | "task.field"
  | "legacy.carried";

/** 操作处理结果（留痕：处理结果）。 */
export type OpResultType =
  | "applied" // 已生效
  | "conflict" // 同字段后到，已登记冲突，挂起待人工选择
  | "duplicate" // 幂等命中：该操作此前已处理，本次不重复执行
  | "rule-blocked" // 命中业务规则（如任务未完成试图结单）
  | "ignored"; // 目标缺失/已合并等，无法执行（仍留痕）

export type PendingState = "queued" | "applied" | "conflict" | "blocked" | "ignored";

/** 一条不可变的操作日志：每次修改按记录与字段留痕。 */
export interface Op {
  /** 操作全局唯一 id（设备生成），同步幂等键。 */
  id: string;
  /** 来源设备 id，留痕用。 */
  deviceId: string;
  /** 来源设备展示名（如「平板-评估员甲」）。 */
  deviceLabel: string;
  type: OpType;
  /** 目标记录 id（家庭 id；任务字段操作时可省略，用 taskId）。 */
  recordId?: string;
  taskId?: string;
  field?: MergedField | TaskField;
  value?: unknown;
  /** 合并操作：被合并（删除/转移）的源家庭 id。 */
  sourceId?: string;
  /** 合并操作：保留的目标家庭 id。 */
  targetId?: string;
  /** 设备端操作发生时间（ISO）。 */
  clientTime: string;
  /** 服务端到达序号：联网归并时统一编号，重放顺序以此为准。 */
  arrivalSeq?: number;
  /** 模拟该条投递失败（同步中断演示用）；true 时引擎不消费该操作。 */
  simulateUndelivered?: boolean;
}

export interface FieldConflict {
  id: string;
  kind: "household" | "task";
  recordId: string;
  taskId?: string;
  field: string;
  /** 先到方操作（当前已生效）。 */
  winnerOpId: string;
  /** 后到方操作（挂起，等待选择新旧值）。 */
  loserOpId: string;
  winnerDevice: string;
  loserDevice: string;
  winnerDeviceId: string;
  loserDeviceId: string;
  /** 旧值（先到、当前生效）。 */
  currentValue: unknown;
  /** 新值（后到、待选）。 */
  incomingValue: unknown;
  status: "待处理" | "采用旧值" | "采用新值";
  resolvedAt?: string;
  arrivalSeq: number;
}

export interface OpResult {
  opId: string;
  arrivalSeq: number;
  type: OpResultType;
  detail: string;
  deviceId: string;
  deviceLabel: string;
}

export interface EngineState {
  households: Household[];
  tasks: FieldTask[];
  /** 字段租约：recordId|taskId + 字段 -> 首个写入该字段的操作与设备。 */
  owners: Record<string, { op: string; device: string }>;
  /** 源家庭 -> 保留家庭 的合并重定向。 */
  redirects: Record<string, string>;
  conflicts: FieldConflict[];
  /** 已经被引擎处理过（生效/冲突/拦截/忽略）的操作 id —— 幂等集合。 */
  processed: string[];
  results: OpResult[];
  /** 已生效操作计数（不含 duplicate）。 */
  appliedCount: number;
}

export function emptyState(households: Household[] = [], tasks: FieldTask[] = []): EngineState {
  return { households, tasks, owners: {}, redirects: {}, conflicts: [], processed: [], results: [], appliedCount: 0 };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [a];
    const bb = Array.isArray(b) ? b : [b];
    return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
  }
  return a === b;
}

/** 跟随合并重定向，返回记录最终归属家庭 id。 */
function resolveId(redirects: Record<string, string>, id: string): string {
  let cur = id;
  const seen = new Set<string>();
  while (redirects[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = redirects[cur];
  }
  return cur;
}

/**
 * 任务全部完成前，家庭状态不能结为「已完成」。
 * 无任务 → 待评估；尚有未完成任务 → 已分派；任务全部完成 → 已完成。
 */
export function deriveHouseholdStatus(tasks: FieldTask[], householdId: string): HouseholdStatus {
  const mine = tasks.filter((t) => t.householdId === householdId);
  if (mine.length === 0) return "待评估";
  return mine.every((t) => t.status === "已完成") ? "已完成" : "已分派";
}

function recomputeStatuses(state: EngineState) {
  state.households.forEach((h) => {
    h.status = deriveHouseholdStatus(state.tasks, h.id);
  });
}

function bumpVersion(h: Household, time: string) {
  h.version += 1;
  h.deviceUpdatedAt = time;
}

/**
 * 按到达顺序重放一批操作（原地更新 state，并返回逐条处理结果）。
 * ops 必须已由服务端按到达顺序排好并编好 arrivalSeq（见 assignArrivalOrder）。
 */
export function replay(state: EngineState, ops: Op[]): OpResult[] {
  const out: OpResult[] = [];

  for (const op of ops) {
    const seq = op.arrivalSeq ?? state.results.length + 1;
    const fail = (type: OpResultType, detail: string): OpResult => {
      state.processed.push(op.id);
      const r: OpResult = { opId: op.id, arrivalSeq: seq, type, detail, deviceId: op.deviceId, deviceLabel: op.deviceLabel };
      state.results.push(r);
      out.push(r);
      return r;
    };

    // 幂等：同步失败重试时，已处理的操作绝不执行第二次。
    if (state.processed.includes(op.id)) {
      fail("duplicate", "操作此前已处理，重试跳过，不重复执行");
      continue;
    }
    // 投递未达（模拟网络中断）：保持未处理，下一轮可重试。
    if (op.simulateUndelivered) {
      continue;
    }

    switch (op.type) {
      case "household.create": {
        const exists = state.households.some((h) => h.id === op.recordId);
        if (exists) {
          fail("ignored", `家庭 ${op.recordId} 已存在`);
          break;
        }
        state.households.unshift({
          id: op.recordId!,
          head: String(op.value ?? ""),
          community: "",
          address: "",
          members: 1,
          vulnerable: [],
          needLevel: "一般",
          needs: [],
          status: "待评估",
          version: 1,
          deviceUpdatedAt: op.clientTime,
          note: ""
        });
        state.appliedCount++;
        fail("applied", `新建家庭（来源 ${op.deviceLabel}）`);
        break;
      }

      case "legacy.carried": {
        // 旧版「整条覆盖」时代的待同步数据：本地实体已含其效果，
        // 重放为无操作，仅保留来源设备、顺序与处理结果的审计痕迹。
        fail("applied", `旧版待同步数据已接续（${op.deviceLabel}，不再整条覆盖）`);
        break;
      }

      case "household.field": {
        const field = op.field as MergedField;
        const targetId = resolveId(state.redirects, op.recordId!);
        const h = state.households.find((item) => item.id === targetId);
        if (!h) {
          fail("ignored", `家庭 ${op.recordId} 不存在（可能已删除）`);
          break;
        }
        const key = `h:${targetId}:${field}`;
        const owner = state.owners[key];
        // 同一字段冲突的判定：存在先到方、来自不同设备、且值不同。
        // 同一设备对同一字段的连续修改属于正常编辑（最后写入即最新），直接接管租约。
        if (owner && owner.device !== op.deviceId && !sameValue((h as unknown as Record<string, unknown>)[field], op.value)) {
          // 另一台设备先写、值不同 → 登记冲突，挂起后到操作。
          const winnerOp = findOpDevice(ops, owner.op);
          state.conflicts.push({
            id: `c-${op.id}`,
            kind: "household",
            recordId: targetId,
            field,
            winnerOpId: owner.op,
            loserOpId: op.id,
            winnerDevice: winnerOp?.deviceLabel ?? owner.device,
            loserDevice: op.deviceLabel,
            winnerDeviceId: winnerOp?.deviceId ?? owner.device,
            loserDeviceId: op.deviceId,
            currentValue: (h as unknown as Record<string, unknown>)[field],
            incomingValue: op.value,
            status: "待处理",
            arrivalSeq: seq
          });
          fail("conflict", `字段「${field}」与先到方 ${winnerOp?.deviceLabel ?? owner.device} 不同，挂起待人工选择`);
          break;
        }
        // 不同字段 / 同值 / 同设备连续编辑 / 首个写入 → 自动合并
        (h as unknown as Record<string, unknown>)[field] = op.value;
        state.owners[key] = { op: op.id, device: op.deviceId };
        bumpVersion(h, op.clientTime);
        state.appliedCount++;
        fail("applied", `字段「${field}」已合并（来源 ${op.deviceLabel}）`);
        break;
      }

      case "household.merge": {
        const source = state.households.find((item) => item.id === op.sourceId);
        const target = state.households.find((item) => item.id === op.targetId);
        if (!source || !target) {
          fail("ignored", "合并目标或源记录不存在");
          break;
        }
        // 先把任务转到保留记录，再删源记录 —— 任务不丢。
        state.tasks.forEach((t) => {
          if (t.householdId === source.id) t.householdId = target.id;
        });
        target.needs = Array.from(new Set([...target.needs, ...source.needs]));
        target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
        if (source.note && !target.note.includes(source.note)) {
          target.note = `${target.note}；已合并重复记录 ${source.address}`.replace(/^；/, "");
        }
        bumpVersion(target, op.clientTime);
        state.households = state.households.filter((item) => item.id !== source.id);
        state.redirects[source.id] = target.id;
        recomputeStatuses(state);
        state.appliedCount++;
        fail("applied", `重复登记合并：${source.id} 的任务已转至保留记录 ${target.id}`);
        break;
      }

      case "task.create": {
        const exists = state.tasks.some((t) => t.id === op.taskId);
        if (exists) {
          fail("ignored", `任务 ${op.taskId} 已存在`);
          break;
        }
        const householdId = resolveId(state.redirects, op.recordId!);
        state.tasks.push({
          id: op.taskId!,
          householdId,
          title: String(op.value ?? ""),
          assignee: "",
          priority: "一般",
          status: "待接收",
          due: ""
        });
        recomputeStatuses(state);
        state.appliedCount++;
        fail("applied", `新建任务并转入家庭 ${householdId}`);
        break;
      }

      case "task.field": {
        const task = state.tasks.find((t) => t.id === op.taskId);
        if (!task) {
          fail("ignored", `任务 ${op.taskId} 不存在`);
          break;
        }
        const field = op.field as TaskField;
        const key = `t:${task.id}:${field}`;
        const owner = state.owners[key];
        if (owner && owner.device !== op.deviceId && !sameValue((task as unknown as Record<string, unknown>)[field], op.value)) {
          const winnerOp = findOpDevice(ops, owner.op);
          state.conflicts.push({
            id: `c-${op.id}`,
            kind: "task",
            recordId: task.householdId,
            taskId: task.id,
            field,
            winnerOpId: owner.op,
            loserOpId: op.id,
            winnerDevice: winnerOp?.deviceLabel ?? owner.device,
            loserDevice: op.deviceLabel,
            winnerDeviceId: winnerOp?.deviceId ?? owner.device,
            loserDeviceId: op.deviceId,
            currentValue: (task as unknown as Record<string, unknown>)[field],
            incomingValue: op.value,
            status: "待处理",
            arrivalSeq: seq
          });
          fail("conflict", `任务字段「${field}」与先到方不同，挂起待人工选择`);
          break;
        }
        (task as unknown as Record<string, unknown>)[field] = op.value;
        state.owners[key] = { op: op.id, device: op.deviceId };
        recomputeStatuses(state);
        state.appliedCount++;
        fail("applied", `任务「${task.title}」字段「${field}」已合并`);
        break;
      }
    }
  }

  return out;
}

function findOpDevice(ops: Op[], id: string): Op | undefined {
  return ops.find((o) => o.id === id);
}

/**
 * 服务端到达顺序：异地设备的操作先到达服务端（已按到达先后排列），
 * 本机恢复网络后才到达 —— 因此同字段冲突时，后同步的本机为「后到方」。
 * 每一流内部按设备端发生时间（clientTime）稳定排序，再统一编号。
 */
export function orderByArrival(localOps: Op[], remoteOps: Op[]): Op[] {
  const byClient = (a: Op, b: Op) => {
    const ta = Date.parse(a.clientTime);
    const tb = Date.parse(b.clientTime);
    if (ta !== tb) return ta - tb;
    return a.deviceId.localeCompare(b.deviceId);
  };
  return [...[...remoteOps].sort(byClient), ...[...localOps].sort(byClient)].map((op, i) => ({
    ...op,
    arrivalSeq: i + 1
  }));
}

/**
 * 解决字段冲突：
 * - 采用旧值：保留先到方当前值，丢弃挂起操作；
 * - 采用新值：把后到方的值写入并接管字段租约。
 */
export function resolveConflict(
  state: EngineState,
  conflictId: string,
  choice: "采用旧值" | "采用新值",
  at: string
): OpResult | null {
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict || conflict.status !== "待处理") return null;
  let result: OpResult;
  if (choice === "采用新值") {
    if (conflict.kind === "task") {
      const task = state.tasks.find((t) => t.id === conflict.taskId);
      if (task) {
        (task as unknown as Record<string, unknown>)[conflict.field] = conflict.incomingValue;
        state.owners[`t:${task.id}:${conflict.field}`] = { op: conflict.loserOpId, device: conflict.loserDeviceId };
      }
    } else {
      const h = state.households.find((item) => item.id === conflict.recordId);
      if (h) {
        (h as unknown as Record<string, unknown>)[conflict.field] = conflict.incomingValue;
        state.owners[`h:${h.id}:${conflict.field}`] = { op: conflict.loserOpId, device: conflict.loserDeviceId };
      }
    }
    result = {
      opId: conflict.loserOpId,
      arrivalSeq: conflict.arrivalSeq,
      type: "applied",
      detail: `冲突人工裁决：采用后到方（${conflict.loserDevice}）新值`,
      deviceId: "manual",
      deviceLabel: "人工裁决"
    };
  } else {
    result = {
      opId: conflict.loserOpId,
      arrivalSeq: conflict.arrivalSeq,
      type: "ignored",
      detail: `冲突人工裁决：保留先到方（${conflict.winnerDevice}）旧值`,
      deviceId: "manual",
      deviceLabel: "人工裁决"
    };
  }
  state.results.push(result);
  conflict.status = choice;
  conflict.resolvedAt = at;
  recomputeStatuses(state);
  return result;
}

/**
 * 恢复网络后的一次完整归并：把本地待发操作与服务端新到的异地操作
 * 汇集，按到达顺序统一编号，在基线上重放。返回最终状态与逐条结果。
 * 所有入参均为纯数据；调用方负责持久化。
 */
/**
 * 恢复网络后的一次完整归并：把本地待发操作与服务端新到的异地操作
 * 汇集，按到达顺序统一编号，在基线上重放。返回最终状态与逐条结果。
 * base 可为完整 EngineState（跨轮归并，保留幂等集合/字段租约/重定向/已登记冲突），
 * 也可为仅含实体的初始基线。所有入参均为纯数据。
 */
export function mergeBatches(
  base: Partial<EngineState> & { households: Household[]; tasks: FieldTask[] },
  localOps: Op[],
  remoteOps: Op[]
): { state: EngineState; ordered: Op[]; results: OpResult[] } {
  // JSON 深拷贝：引擎处理的全部是可序列化纯数据，且可兼容 Vue 响应式 Proxy。
  const state = emptyState(
    JSON.parse(JSON.stringify(base.households)) as Household[],
    JSON.parse(JSON.stringify(base.tasks)) as FieldTask[]
  );
  // 延续上一轮的引擎记忆：否则失败重试会丢失幂等集合导致重复执行、丢失字段租约与合并重定向。
  state.owners = base.owners ? JSON.parse(JSON.stringify(base.owners)) : {};
  state.redirects = base.redirects ? JSON.parse(JSON.stringify(base.redirects)) : {};
  state.conflicts = base.conflicts ? JSON.parse(JSON.stringify(base.conflicts)) : [];
  state.processed = base.processed ? [...base.processed] : [];
  state.results = base.results ? JSON.parse(JSON.stringify(base.results)) : [];
  state.appliedCount = base.appliedCount ?? 0;

  const ordered = orderByArrival(localOps, remoteOps);
  const results = replay(state, ordered);
  return { state, ordered, results };
}

/** 反序列化后的引擎状态补全字段（兼容旧版本地缓存）。 */
export function initEngineState(raw?: Partial<EngineState> | null): EngineState {
  return {
    households: raw?.households ?? [],
    tasks: raw?.tasks ?? [],
    owners: raw?.owners ?? {},
    redirects: raw?.redirects ?? {},
    conflicts: raw?.conflicts ?? [],
    processed: raw?.processed ?? [],
    results: raw?.results ?? [],
    appliedCount: raw?.appliedCount ?? 0
  };
}

