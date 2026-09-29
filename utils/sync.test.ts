// 引擎验证脚本：npx tsc 编译后用 node 运行（见 package 脚本 test:engine）
declare const process: { exit(code: number): void };
import {
  migrateLegacy, replayIncoming, buildPeerBundle, buildStressBundle,
  commitLocal, flushOutbox, resolveConflict, closeHousehold, metrics,
  createId, type SyncState, type Household, type FieldTask, type ChangeOp
} from "./sync";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

const h1: Household = {
  id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元",
  members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"],
  status: "待复核", note: "一层受淹"
};
const h3: Household = {
  id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元",
  members: 4, vulnerable: ["孕妇"], needLevel: "紧急", needs: ["照明"],
  status: "待评估", note: "疑似重复登记"
};

function freshState(): SyncState {
  return migrateLegacy({ households: [JSON.parse(JSON.stringify(h1)), JSON.parse(JSON.stringify(h3))], tasks: [], queue: [], conflicts: [] }, "平板-A");
}

// 1. 不同字段自动合并；同一字段生成新旧值冲突
console.log("1) 多人改同一户：不同字段合并、同字段冲突展示新旧值");
{
  const s = freshState();
  // 本机先改了 members 与 address
  const r1 = commitLocal(s, { entity: "household", action: "update-field", recordId: "h1", field: "members", value: 5 });
  check("本机修改生效", r1.op?.effect !== "拒绝");
  commitLocal(s, { entity: "household", action: "update-field", recordId: "h1", field: "address", value: "河湾路18号2单元（本机校正）" });
  const res = replayIncoming(s, buildPeerBundle(s, "h1"));
  const after = s.households.find((h) => h.id === "h1")!;
  check("不同字段(note)自动合并", after.note.includes("B机补充"), after.note);
  check("同字段(address)未被静默覆盖", after.address === "河湾路18号2单元（本机校正）", after.address);
  check("本机 members 修改保留(字段级不整条覆盖)", after.members === 5);
  check("产生 1 个冲突", res.conflicts === 1, `got ${res.conflicts}`);
  const c = s.conflicts.find((x) => x.status === "待选择")!;
  check("冲突带旧值(base=本机值)", c.base === "河湾路18号2单元（本机校正）");
  check("冲突带两个设备新值候选", c.options.length === 2 && c.options.some((o) => o.value === "河湾路18号2栋2单元"));
  check("解决采用B机值", resolveConflict(s, c.id, 1) === true);
  check("落值为B机新值", s.households.find((h) => h.id === "h1")!.address === "河湾路18号2栋2单元");
  check("解决动作留痕", s.ops.some((o) => o.resultNote?.includes("冲突解决")));
}

// 2. 合并重复记录：任务转到保留记录
console.log("2) 重复登记合并：任务转到保留记录");
{
  const s = freshState();
  const task: FieldTask = { id: "k9", householdId: "h3", title: "送药", assignee: "一组", priority: "紧急", status: "进行中", due: "2026-09-30" };
  s.tasks.push(task);
  const r = commitLocal(s, { entity: "household", action: "merge-household", recordId: "h1", mergedFromId: "h3" });
  check("合并操作转单应用", r.op?.effect === "转单应用", r.op?.effect ?? "");
  check("任务 householdId 转到保留记录", task.householdId === "h1");
  check("源记录删除", !s.households.some((h) => h.id === "h3"));
  check("需求取并集", (s.households[0].needs.includes("照明")));
  check("特殊照护取并集", s.households[0].vulnerable.includes("孕妇") && s.households[0].vulnerable.includes("老人"));
  // 合并后到达的、指向旧 id 的修改自动落到保留记录
  const late = replayIncoming(s, [{
    id: createId(), entity: "household", action: "update-field", recordId: "h3",
    deviceId: "平板-B", deviceSeq: 9, arrivalSeq: s.nextArrivalSeq + 1, opTime: new Date().toISOString(),
    field: "note", value: "合并后迟到的修改", effect: "已应用" as const, delivery: "已确认" as const, appliedCount: 1
  }]);
  check("迟到修改经别名落到保留记录", s.households[0].note.includes("合并后迟到的修改"), `accepted=${late.accepted}`);
}

// 3. 任务未全部完成不能结案
console.log("3) 任务全部完成前不能结掉家庭状态");
{
  const s = freshState();
  s.tasks.push({ id: "k1", householdId: "h1", title: "复核", assignee: "一组", priority: "高", status: "进行中", due: "t" });
  const blocked = closeHousehold(s, "h1");
  check("有未完成任务时结案被拒绝", blocked.ok === false);
  check("家庭状态未被改成已完成", s.households[0].status !== "已完成");
  // 对端直接推 status=已完成 同样拦截
  const res = replayIncoming(s, [{
    id: createId(), entity: "household", action: "update-field", recordId: "h1",
    deviceId: "平板-B", deviceSeq: 1, arrivalSeq: s.nextArrivalSeq + 1, opTime: new Date().toISOString(),
    field: "status", value: "已完成", effect: "已应用" as const, delivery: "已确认" as const, appliedCount: 1
  }]);
  check("对端结户操作被拒绝", res.rejected === 1);
  // 任务完成后才能结案（且完成任务本身不自动结户）
  s.tasks[0].status = "已完成";
  const ok = closeHousehold(s, "h1");
  check("任务清零后结案成功", ok.ok === true, ok.reason ?? "");
  check("家庭状态为已完成", s.households[0].status === "已完成");
}

// 4. 旧版待同步数据接续
console.log("4) 旧版待同步数据接续（不整条覆盖、待人工核对）");
{
  const legacy = {
    households: [h1],
    tasks: [],
    queue: [
      { id: "q1", entity: "家庭需求记录", action: "修改", detail: "王建国：address", time: new Date().toISOString() },
      { id: "q2", entity: "任务", action: "状态流转", detail: "送药 → 已完成", time: new Date().toISOString() }
    ],
    conflicts: [{ id: "cf1", householdId: "h1", field: "address", localValue: "本机址", remoteValue: "远端址", status: "待处理" as const }]
  };
  const s = migrateLegacy(legacy, "平板-A");
  check("旧队列条目保留为待核对", metrics(s).pending === 2);
  const legacyOps = s.ops.filter((o) => o.delivery === "待核对");
  check("旧条目不参与自动重放(appliedCount=0)", legacyOps.every((o) => o.appliedCount === 0));
  check("旧数据未被覆盖", s.households[0].address === h1.address);
  check("旧冲突接续为新候选冲突", s.conflicts.length === 1 && s.conflicts[0].options.length === 2);
  // 重放新包后旧条目依然原样保留
  replayIncoming(s, buildPeerBundle(s, "h1"));
  check("重放后旧条目仍保留", s.ops.filter((o) => o.delivery === "待核对").length === 2);
}

// 5. 失败重试幂等：effect 绝不执行两次
console.log("5) 失败重试不能执行两次");
{
  const s = freshState();
  // 对端推送 5 条，第 3 条 ACK 失败
  const bundle: ChangeOp[] = [];
  for (let i = 0; i < 5; i++) {
    bundle.push({
      id: `peer-op-${i}`, entity: "household", action: "update-field", recordId: "h1",
      deviceId: "平板-B", deviceSeq: i + 1, arrivalSeq: s.nextArrivalSeq + 1 + i, opTime: new Date().toISOString(),
      field: "note", value: i === 0 ? `${h1.note}：v${i}` : `v${i}`, effect: "已应用" as const, delivery: "已确认" as const, appliedCount: 1
    });
  }
  const r1 = replayIncoming(s, bundle, 3);
  check("5 条全部产生 effect", r1.accepted === 5, `accepted=${r1.accepted}`);
  const failedOp = s.ops.find((o) => o.id === "peer-op-2")!;
  check("失败条目标记投递失败", failedOp.delivery === "投递失败");
  check("失败条目 effect 仅执行一次", failedOp.appliedCount === 1);
  // 整包重试（对端重发，含失败条目）
  const r2 = replayIncoming(s, bundle, 0);
  check("重试无新增 effect(全部幂等)", r2.accepted === 0 && r2.duplicate === 5, `accepted=${r2.accepted} dup=${r2.duplicate}`);
  const again = s.ops.find((o) => o.id === "peer-op-2")!;
  check("重试后 appliedCount 仍为 1", again.appliedCount === 1);
  check("重试后状态变已确认", again.delivery === "已确认");
  check("值未被重复应用(note 保持 v4)", s.households[0].note === "v4", s.households[0].note);

  // 本机 outbox 同理
  const s2 = freshState();
  commitLocal(s2, { entity: "household", action: "update-field", recordId: "h1", field: "note", value: "本机A" });
  commitLocal(s2, { entity: "household", action: "update-field", recordId: "h1", field: "note", value: "本机B" });
  const f1 = flushOutbox(s2, 2);
  check("本机首推第2条ACK失败", f1.failed === 1 && f1.confirmed === 1);
  const f2 = flushOutbox(s2, 0);
  check("重试只补推失败条", f2.confirmed === 1 && f2.failed === 0);
  check("重试不产生重复 effect", s2.ops.every((o) => o.appliedCount <= 1));
  check("最终值为本机B(顺序正确)", s2.households[0].note === "本机B");
}

// 6. 操作记录保留来源设备、顺序和处理结果
console.log("6) 审计：来源设备 / 顺序 / 处理结果");
{
  const s = freshState();
  commitLocal(s, { entity: "household", action: "update-field", recordId: "h1", field: "members", value: 6 });
  replayIncoming(s, buildPeerBundle(s, "h1"));
  check("每条记录有来源设备", s.ops.every((o) => !!o.deviceId));
  check("arrivalSeq 全局唯一递增", new Set(s.ops.map((o) => o.arrivalSeq)).size === s.ops.length);
  const ordered = s.ops.every((o, i, arr) => i === 0 || arr[i - 1].arrivalSeq <= o.arrivalSeq);
  check("日志按到达顺序排列", ordered);
  check("每条记录有处理结果", s.ops.every((o) => ["已应用", "自动合并", "冲突", "幂等忽略", "转单应用", "拒绝"].includes(o.effect)));
}

// 7. 性能：200 条 2 秒内归并
console.log("7) 性能：恢复网络后 200 条修改 2 秒内归并");
{
  const s = freshState();
  const bundle = buildStressBundle(s, "h1");
  check("压力包恰为 200 条", bundle.length === 200, `got ${bundle.length}`);
  const r = replayIncoming(s, bundle);
  check("归并耗时 < 2000ms", r.durationMs < 2000, `${r.durationMs.toFixed(1)}ms`);
  console.log(`     accepted=${r.accepted} duplicate=${r.duplicate} conflicts=${r.conflicts} rejected=${r.rejected} 耗时=${r.durationMs.toFixed(1)}ms`);
  // 幂等：再来一遍 200 条，应全部命中且同样 < 2s
  const r2 = replayIncoming(s, bundle);
  check("重复 200 条全部幂等", r2.duplicate === 200 && r2.accepted === 0);
  check("幂等重放耗时 < 2000ms", r2.durationMs < 2000, `${r2.durationMs.toFixed(1)}ms`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
