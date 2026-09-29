/**
 * 归并引擎验证（node 直跑编译产物）：
 *   npx tsc scripts/verify.ts --outDir /tmp/sync-verify --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck
 *   node /tmp/sync-verify/verify.js
 */
import {
  emptyState,
  mergeBatches,
  orderByArrival,
  replay,
  resolveConflict,
  type EngineState,
  type FieldTask,
  type Household,
  type Op
} from "../utils/sync";

declare const process: { exit(code?: number): void };

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

function h(id: string, patch: Partial<Household> = {}): Household {
  return {
    id,
    head: "王建国",
    community: "河湾社区",
    address: "河湾路18号2单元",
    members: 4,
    vulnerable: ["老人"],
    needLevel: "紧急",
    needs: ["临时安置"],
    status: "待复核",
    version: 1,
    deviceUpdatedAt: "2026-09-29T08:00:00.000Z",
    note: "一层受淹",
    ...patch
  };
}
function t(id: string, householdId: string, patch: Partial<FieldTask> = {}): FieldTask {
  return { id, householdId, title: "复核", assignee: "一组", priority: "一般", status: "进行中", due: "", ...patch };
}
let seq = 0;
function op(partial: Partial<Op> & Pick<Op, "type" | "deviceId" | "deviceLabel">): Op {
  return {
    id: `op-${++seq}`,
    clientTime: new Date(Date.now() + seq).toISOString(),
    ...partial
  };
}

console.log("\n[1] 回归：两台平板离线改同一户（不同字段），后同步不再整条覆盖、任务不丢");
{
  const base = { households: [h("h1", { status: "已分派" })], tasks: [t("k1", "h1", { status: "进行中" })] };
  const deviceA = { deviceId: "dev-A", deviceLabel: "平板-评估员甲" };
  const deviceB = { deviceId: "dev-B", deviceLabel: "平板-评估员乙" };
  // A 先同步（成为服务端已到操作），B 后同步（本地待发）
  const remote = [op({ ...deviceA, type: "household.field", recordId: "h1", field: "address", value: "河湾路18号2栋2单元" })];
  const local = [
    op({ ...deviceB, type: "household.field", recordId: "h1", field: "needLevel", value: "高" }),
    op({ ...deviceB, type: "task.field", taskId: "k1", field: "assignee", value: "后勤二组" })
  ];
  const { state, results } = mergeBatches(base, local, remote);
  const merged = state.households.find((x) => x.id === "h1")!;
  check("A 的地址保留", merged.address === "河湾路18号2栋2单元");
  check("B 的需求等级自动合并（不被覆盖）", merged.needLevel === "高");
  check("原字段 members 未被整条覆盖", merged.members === 4);
  check("任务仍然存在且未丢失", state.tasks.some((x) => x.id === "k1"));
  check("任务字段已合并为后勤二组", state.tasks.find((x) => x.id === "k1")!.assignee === "后勤二组");
  check("没有产生冲突（不同字段）", state.conflicts.length === 0);
  check("3 条操作均 applied", results.every((r) => r.type === "applied") && results.length === 3);
}

console.log("\n[2] 同一字段：后同步方登记冲突，展示新旧值，可人工选择");
{
  const base = { households: [h("h1")], tasks: [] };
  const remote = [op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.field", recordId: "h1", field: "address", value: "2栋2单元（甲）" })];
  const local = [op({ deviceId: "dev-B", deviceLabel: "平板-乙", type: "household.field", recordId: "h1", field: "address", value: "2幢2单元（乙）" })];
  const { state } = mergeBatches(base, local, remote);
  check("恰好 1 个冲突", state.conflicts.length === 1);
  const c = state.conflicts[0];
  check("旧值=先同步的甲", c.currentValue === "2栋2单元（甲）");
  check("新值=后同步的乙", c.incomingValue === "2幢2单元（乙）");
  check("当前生效仍为旧值（不静默覆盖）", state.households[0].address === "2栋2单元（甲）");
  check("记录了双方来源设备", c.winnerDevice.includes("甲") && c.loserDevice.includes("乙"));
  resolveConflict(state, c.id, "采用新值", new Date().toISOString());
  check("采用新值后地址更新为乙", state.households[0].address === "2幢2单元（乙）");
  check("冲突状态已闭环", state.conflicts[0].status === "采用新值");
}

console.log("\n[3] 重复登记合并：任务转到保留记录；任务全部完成前家庭不能结为已完成");
{
  const base = {
    households: [h("h1", { status: "待复核" }), h("h3", { address: "河湾路18号2幢2单元", note: "疑似重复", status: "待评估" })],
    tasks: [t("k2", "h3", { title: "送药", status: "进行中" })]
  };
  const local = [op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.merge", sourceId: "h3", targetId: "h1" })];
  const { state } = mergeBatches(base, local, []);
  check("源记录已删除", !state.households.some((x) => x.id === "h3"));
  check("保留记录 h1 存在", state.households.some((x) => x.id === "h1"));
  const moved = state.tasks.find((x) => x.id === "k2")!;
  check("源记录任务已转到保留记录 h1", moved && moved.householdId === "h1");
  check("尚有未完成任务 → 家庭状态为已分派而非已完成", state.households[0].status === "已分派");
  // 完成最后一个任务
  replay(state, [op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "task.field", taskId: "k2", field: "status", value: "已完成" })]);
  check("全部任务完成 → 家庭状态才结为已完成", state.households[0].status === "已完成");
  // 合并后再到的、指向旧源记录的任务流转也跟随重定向
  const base2 = {
    households: [h("h1"), h("h3")],
    tasks: [t("k2", "h3")]
  };
  const mergeOp = op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.merge", sourceId: "h3", targetId: "h1" });
  const late = op({ deviceId: "dev-B", deviceLabel: "平板-乙", type: "household.field", recordId: "h3", field: "note", value: "乙离线补充" });
  const { state: s2 } = mergeBatches(base2, [mergeOp, late], []);
  check("合并后指向旧记录的字段修改落到保留记录（重定向）", s2.households[0].note.includes("乙离线补充"));
}

console.log("\n[4] 旧版待同步数据可接续");
{
  const base = { households: [h("h1")], tasks: [] };
  const legacy = [op({ deviceId: "legacy-tablet", deviceLabel: "旧版平板", type: "legacy.carried" })];
  const { state, results } = mergeBatches(base, legacy, []);
  check("旧版操作标记 applied 接续", results[0].type === "applied");
  check("记录中保留旧版来源设备", results[0].deviceId === "legacy-tablet");
  check("本地实体未被破坏", state.households[0].id === "h1");
}

console.log("\n[5] 失败重试幂等：同一批操作绝不执行两次");
{
  const base = { households: [h("h1")], tasks: [] };
  const state: EngineState = emptyState(base.households, base.tasks);
  const ops = [
    op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.field", recordId: "h1", field: "note", value: "第一次写入" }),
    op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.field", recordId: "h1", field: "members", value: 9 })
  ];
  const first = replay(state, ops);
  const v = state.households[0].version;
  // 服务端实际已生效，但响应丢失，客户端整批重试
  const second = replay(state, ops);
  check("首轮全部 applied", first.every((r) => r.type === "applied"));
  check("重试全部判为 duplicate", second.every((r) => r.type === "duplicate") && second.length === 2);
  check("重试不重复加版本", state.households[0].version === v);
  check("值未被二次执行污染", state.households[0].members === 9 && state.households[0].note === "第一次写入");
}

console.log("\n[6] 中断后续传：未送达的操作下一轮只执行一次");
{
  const state: EngineState = emptyState([h("h1")], []);
  const o1 = op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.field", recordId: "h1", field: "note", value: "已送达" });
  const o2 = op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.field", recordId: "h1", field: "address", value: "未送达", simulateUndelivered: true });
  const ordered = orderByArrival([o1, o2], []);
  replay(state, ordered);
  check("未送达操作保持未处理（不在 processed）", !state.processed.includes(o2.id));
  check("已送达操作已处理", state.processed.includes(o1.id));
  // 网络恢复，整批重投
  const retry = replay(state, ordered.map((x) => ({ ...x, simulateUndelivered: false })));
  const o2res = retry.find((r) => r.opId === o2.id);
  const o1res = retry.find((r) => r.opId === o1.id);
  check("原未送达操作这次 applied 一次", o2res?.type === "applied");
  check("原已送达操作重试只判 duplicate", o1res?.type === "duplicate");
}

console.log("\n[7] 性能：200 条修改恢复网络后 2 秒内完成归并");
{
  const households = Array.from({ length: 20 }, (_, i) => h(`h${i}`, { head: `户${i}` }));
  const fields = ["address", "note", "needLevel", "members", "head", "community"] as const;
  const ops: Op[] = Array.from({ length: 200 }, (_, i) =>
    op({
      deviceId: `dev-${i % 4}`,
      deviceLabel: `平板-${i % 4}`,
      type: "household.field",
      recordId: `h${i % 20}`,
      field: fields[i % fields.length],
      value: `${fields[i % fields.length]}-值-${i}`,
      clientTime: new Date(Date.now() + i).toISOString()
    })
  );
  const t0 = performance.now();
  const { state, results } = mergeBatches({ households, tasks: [] }, ops.slice(0, 100), ops.slice(100));
  const ms = performance.now() - t0;
  console.log(`    200 条归并耗时 ${ms.toFixed(1)} ms（冲突 ${state.conflicts.length}，结果 ${results.length}）`);
  check("耗时 < 2000 ms", ms < 2000, `实际 ${ms.toFixed(1)}ms`);
  check("200 条全部有处理结果", results.length === 200);
}

console.log("\n[8] 操作记录保留来源设备、顺序与处理结果");
{
  const base = { households: [h("h1")], tasks: [] };
  const remote = [op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.field", recordId: "h1", field: "address", value: "甲" })];
  const local = [op({ deviceId: "dev-B", deviceLabel: "平板-乙", type: "household.field", recordId: "h1", field: "note", value: "乙" })];
  const { results } = mergeBatches(base, local, remote);
  check("arrivalSeq 连续且从 1 开始", results.map((r) => r.arrivalSeq).join() === "1,2");
  check("先到达的甲序号为 1", results.find((r) => r.deviceId === "dev-A")!.arrivalSeq === 1);
  check("每条结果都含来源设备与处理结果类型", results.every((r) => r.deviceId && r.type && typeof r.detail === "string"));
}

console.log("\n[9] 同设备连续改同字段不冲突；跨设备改同字段才冲突");
{
  const base = { households: [h("h1", { address: "原址" })], tasks: [] };
  // 乙设备连续两次改地址（自己的正常编辑，最新值覆盖），再与甲竞争同一字段
  // 场景：乙两次自编辑（无甲）→ 不产生任何冲突
  {
    const { state } = mergeBatches(base, [
      op({ deviceId: "dev-B", deviceLabel: "平板-乙", type: "household.field", recordId: "h1", field: "address", value: "乙的地址-初稿" }),
      op({ deviceId: "dev-B", deviceLabel: "平板-乙", type: "household.field", recordId: "h1", field: "address", value: "乙的地址-定稿" })
    ], []);
    check("乙两次自编辑无冲突，定稿生效", state.conflicts.length === 0 && state.households[0].address === "乙的地址-定稿");
  }
  // 场景：甲先到，乙一次跨设备修改 → 恰好 1 个冲突且完整留痕
  const remote: Op[] = [op({ deviceId: "dev-A", deviceLabel: "平板-甲", type: "household.field", recordId: "h1", field: "address", value: "甲的地址" })];
  const local: Op[] = [op({ deviceId: "dev-B", deviceLabel: "平板-乙", type: "household.field", recordId: "h1", field: "address", value: "乙的地址-定稿" })];
  const { state } = mergeBatches(base, local, remote);
  check("恰好 1 个跨设备冲突", state.conflicts.length === 1, `实际 ${state.conflicts.length}`);
  check("当前生效为甲（先到方），乙定稿挂起", state.households[0].address === "甲的地址");
  check("冲突新值是乙的定稿", state.conflicts[0].incomingValue === "乙的地址-定稿");
  resolveConflict(state, state.conflicts[0].id, "采用新值", new Date().toISOString());
  check("裁决后乙定稿生效", state.households[0].address === "乙的地址-定稿");
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
