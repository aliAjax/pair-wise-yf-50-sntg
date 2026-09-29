/**
 * 真实 Pinia store 集成验证（Node 环境）：
 *   esbuild scripts/store-test.ts --bundle --platform=node --format=cjs --alias:~=. --outfile=/tmp/store.test.cjs
 *   node /tmp/store.test.cjs
 *
 * 通过内存版 localStorage 桩在 Node 中驱动真实 store，覆盖离线字段留痕、
 * 联网归并、冲突裁决、失败重试幂等、合并转任务/结单规则、旧版迁移、200 条性能。
 */
function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear()
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;
  return storage;
}
installStorage();

import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useAssessmentStore } from "~/stores/assessment";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshStore(initialStorage?: Record<string, string>) {
  installStorage(initialStorage);
  setActivePinia(createPinia());
  return useAssessmentStore();
}

console.log("\n[1] 离线按字段修改 → 联网按到达顺序归并：异字段合并、同字段冲突新旧值裁决");
{
  const store = freshStore();
  const h1before = store.households.find((h) => h.id === "h1")!;
  check("初始 h1 人数 4（种子）", h1before.members === 4);
  // 乙离线改地址（与甲 inbox 冲突）与说明（与甲 inbox 冲突）
  store.updateHouseholdFields("h1", { address: "河湾路18号2幢2单元（乙复核）", note: "乙现场说明：需保暖物资" });
  check("两条字段操作进入 outbox", store.outbox.length === 2);
  const report = await store.synchronize();
  check("归并产生 2 个同字段冲突", report.conflicts === 2, `conflicts=${report.conflicts}`);
  const pending = store.conflicts.filter((c) => c.status === "待处理");
  check("2 个冲突待处理", pending.length === 2);
  const addrConflict = store.conflicts.find((c) => c.field === "address")!;
  check("旧值为先到方甲", String(addrConflict.currentValue).includes("2栋2单元"));
  check("新值为后到方乙", String(addrConflict.incomingValue).includes("乙复核"));
  check("记录双方来源设备", addrConflict.winnerDevice.includes("甲") && addrConflict.loserDevice.includes("乙"));
  // 裁决前：地址仍为甲的旧值，未静默覆盖
  check("裁决前仍是旧值（不静默覆盖）", store.households.find((h) => h.id === "h1")!.address === "河湾路18号2栋2单元");
  store.resolveFieldConflict(addrConflict.id, "采用新值");
  const h1 = store.households.find((h) => h.id === "h1")!;
  check("裁决采用乙新值", h1.address.includes("乙复核"));
  check("未被整条覆盖：人数仍 4", h1.members === 4);
  check("未被整条覆盖：需求保留", h1.needs.includes("慢病用药"));
  // 另一个说明冲突保留旧值
  const noteConflict = store.conflicts.find((c) => c.field === "note")!;
  store.resolveFieldConflict(noteConflict.id, "采用旧值");
  check("保留旧值后说明为甲版本", store.households.find((h) => h.id === "h1")!.note.includes("折叠担架"));
}

console.log("\n[2] 操作留痕：来源设备、到达顺序、处理结果");
{
  const store = freshStore();
  store.updateHouseholdFields("h1", { address: "乙地址X", note: "乙说明Y" });
  await store.synchronize();
  const seq = store.audit.map((r) => r.arrivalSeq);
  check("到达顺序 1..4 连续", seq.join() === "1,2,3,4", seq.join());
  check("含异地来源设备（甲）", store.audit.some((r) => r.deviceLabel.includes("甲")));
  check("含本机来源设备（乙）", store.audit.some((r) => r.deviceLabel.includes("乙")));
  check("含处理结果类型", new Set(store.audit.map((r) => r.type)).has("conflict"));
  check("每条有中文结果说明", store.audit.every((r) => typeof r.detail === "string" && r.detail.length > 0));
}

console.log("\n[3] 同步中途失败 → 重试：已生效不执行两次（幂等），未送达补送一次");
{
  const store = freshStore();
  const tasksBefore = store.tasks.length;
  store.addTask({ householdId: "h1", title: "送棉被", assignee: "救援一组", priority: "高", due: "2026-09-30 12:00" });
  check("任务本地乐观生效", store.tasks.some((t) => t.title === "送棉被"));
  store.failNextSync = true;
  const first = await store.synchronize();
  check("首次部分失败", first.partial === true);
  check("首次有未送达", first.failed > 0, `failed=${first.failed}`);
  const taskStillOnce = store.tasks.filter((t) => t.title === "送棉被").length;
  check("任务不会因失败重复出现", taskStillOnce === 1, `count=${taskStillOnce}`);

  const second = await store.synchronize();
  check("重试全部送达（未送达=0）", second.failed === 0, `failed=${second.failed}`);
  check("重试识别已处理操作（去重≥1）", second.duplicates >= 1, `dup=${second.duplicates}`);
  check("重试不是部分失败", second.partial === false);
  const finalTaskCount = store.tasks.filter((t) => t.title === "送棉被").length;
  check("归并后任务仍恰好 1 个（未重复执行）", finalTaskCount === 1, `count=${finalTaskCount}`);
  check("服务端任务总数只新增 1", store.tasks.length === tasksBefore + 1, `total=${store.tasks.length}`);
  void tasksBefore;
}

console.log("\n[4] 重复登记合并：任务转保留记录；任务未全完成不能结单，全完成才结单");
{
  const store = freshStore();
  // 给源记录 h3 挂一个进行中任务
  store.addTask({ householdId: "h3", title: "上门送药", assignee: "医疗组", priority: "紧急", due: "2026-09-30 10:00" });
  await store.synchronize();
  const medTask = store.tasks.find((t) => t.title === "上门送药")!;
  check("合并前任务挂在 h3", medTask.householdId === "h3");

  store.mergeDuplicate("h3", "h1");
  await store.synchronize();
  const moved = store.tasks.find((t) => t.title === "上门送药")!;
  check("合并后任务转到保留记录 h1（任务不丢）", !!moved && moved.householdId === "h1");
  check("源记录 h3 已删除", !store.households.some((h) => h.id === "h3"));
  const h1 = store.households.find((h) => h.id === "h1")!;
  check("有未完成任务 → 家庭为已分派，不能结为已完成", h1.status === "已分派", h1.status);

  // 推进到完成（每次按 id 重新查找，避免引用同步前的旧对象）
  const movedId = moved.id;
  let guard = 0;
  while (store.tasks.find((t) => t.id === movedId)!.status !== "已完成" && guard < 5) {
    store.advanceTask(movedId);
    await store.synchronize();
    guard++;
  }
  const h1After = store.households.find((h) => h.id === "h1")!;
  // h1 可能还有其它未完成任务（种子里没有 h1 任务），这里只有这一个
  check("全部任务完成 → 家庭结为已完成", h1After.status === "已完成", h1After.status);
}

console.log("\n[5] 旧版待同步数据可接续（旧 queue 整条覆盖时代缓存迁移）");
{
  const legacyStorage = {
    "pair-wise-yf-50/assessment": JSON.stringify({
      households: [
        { id: "h9", head: "旧户", community: "河湾社区", address: "旧地址", members: 3, vulnerable: [], needLevel: "一般", needs: ["水"], status: "待复核", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "旧" }
      ],
      tasks: [],
      queue: [
        { id: "q1", entity: "家庭需求记录", action: "修改", detail: "旧版整条修改", time: new Date().toISOString() }
      ],
      conflicts: [],
      lastSyncedAt: new Date().toISOString()
    })
  };
  const store = freshStore(legacyStorage);
  check("旧实体保留", store.households.some((h) => h.id === "h9"));
  check("旧 queue 迁移为 outbox 的 legacy.carried", store.outbox.length === 1 && store.outbox[0].type === "legacy.carried");
  const report = await store.synchronize();
  check("旧版操作接续 applied", report.merged >= 1);
  check("审计中保留旧版来源标记", store.audit.some((r) => r.detail.includes("旧版")));
}

console.log("\n[6] 200 条修改恢复网络后 2 秒内归并");
{
  const store = freshStore();
  const t0 = performance.now();
  const report = await store.benchmark();
  const wall = performance.now() - t0;
  console.log(`    引擎归并 ${report.elapsedMs} ms，含 await 墙钟 ${wall.toFixed(1)} ms`);
  check("引擎归并耗时 < 2000 ms", report.elapsedMs < 2000, `${report.elapsedMs}ms`);
  check("200 条均被处理（生效+冲突 ≥ 200）", report.merged + report.conflicts >= 200, `${report.merged}+${report.conflicts}`);
}

console.log("\n[7] 持久化：刷新（重建 store）后状态接续，outbox 不丢");
{
  const storage = installStorage();
  setActivePinia(createPinia());
  const s1 = useAssessmentStore();
  s1.updateHouseholdFields("h2", { note: "离线备注待发" });
  const pendingId = s1.outbox[0].id;
  await nextTick(); // 等待持久化 watcher 写入 localStorage
  // 模拟刷新：新 pinia、同一 localStorage
  setActivePinia(createPinia());
  const s2 = useAssessmentStore();
  check("刷新后待发操作仍在", s2.outbox.some((o) => o.id === pendingId));
  check("刷新后界面已含离线修改（重放）", s2.households.find((h) => h.id === "h2")!.note === "离线备注待发");
}

console.log(`\n集成结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
