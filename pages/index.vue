<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore } from "~/stores/assessment";
import type { NeedLevel } from "~/utils/sync";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");

const FIELD_LABELS: Record<string, string> = {
  head: "户主", community: "社区", address: "地址", members: "家庭人数",
  vulnerable: "特殊照护", needLevel: "需求等级", needs: "需求", status: "家庭状态", note: "现场说明"
};
const ACTION_LABELS: Record<string, string> = {
  "create-household": "新增家庭", "update-field": "字段修改", "merge-household": "重复合并",
  "create-task": "分派任务", "advance-task": "任务流转"
};
const EFFECT_TYPE: Record<string, "default" | "success" | "warning" | "error" | "info"> = {
  "已应用": "success", "自动合并": "info", "冲突": "warning",
  "幂等忽略": "default", "转单应用": "success", "拒绝": "error"
};
const needOptions = ["紧急", "高", "一般"].map((v) => ({ value: v, label: v }));
const statusOptions = ["待评估", "待复核", "已分派", "已完成"].map((v) => ({ value: v, label: v }));
const fieldOptions = Object.keys(FIELD_LABELS).map((v) => ({ value: v, label: FIELD_LABELS[v] }));

const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");

const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

// 字段级单字段修改
const editField = ref<string>("address");
const editValue = ref("");
const editMessage = ref("");
function startFieldEdit() {
  if (!selected.value) return;
  const raw = (selected.value as unknown as Record<string, unknown>)[editField.value];
  editValue.value = Array.isArray(raw) ? raw.join("，") : String(raw ?? "");
  editMessage.value = "";
}
function saveFieldEdit() {
  if (!selected.value) return;
  let value: unknown = editValue.value;
  if (editField.value === "members") value = Number(editValue.value);
  if (editField.value === "needs" || editField.value === "vulnerable") {
    value = editValue.value.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  }
  const r = store.updateField(selected.value.id, editField.value, value);
  editMessage.value = r.ok ? `已按字段留痕（处理结果：${r.effect}），可在“操作记录”查看来源与顺序。` : `被拒绝：${r.reason}`;
}

const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
function tryClose(id: string) {
  const r = store.closeHouseholdById(id);
  editMessage.value = r.ok ? "结案成功。" : `结案被拒绝：${r.reason}`;
}

function simulatePeer() {
  if (!selected.value) return;
  const n = store.stagePeerEdits(selected.value.id);
  store.lastMessage = `已模拟平板-B 离线修改同一户的 ${n} 条字段操作（1 条不同字段、1 条与本机同字段），等联网后到达。`;
}
function doSync() {
  if (!store.online) { store.lastMessage = "仍在弱网状态，队列保留在设备中。"; return; }
  store.syncNow();
}
function doStress() {
  if (!selected.value) return;
  store.stressMerge(selected.value.id);
}

const auditFilter = ref<"全部" | string>("全部");
const auditList = computed(() => store.ops.filter((o) => auditFilter.value === "全部" || o.effect === auditFilter.value));
const percentage = computed(() => Math.max(4, 100 - store.stats.queued * 6));
const devices = ["平板-A", "平板-B", "平板-C", "平板-D"];

onMounted(() => {
  store.online = browserOnline.value;
  startFieldEdit();
});
</script>

<template>
  <ClientOnly>
  <div class="shell">
    <aside class="side">
      <div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div>
      <nav>
        <button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理', '操作记录']" :key="item" :class="{ active: panel === item }" @click="panel = item">
          {{ item }}
          <span v-if="item === '同步队列' && store.stats.queued">({{ store.stats.queued }})</span>
          <span v-else-if="item === '冲突处理' && store.stats.openConflicts" class="badge">{{ store.stats.openConflicts }}</span>
        </button>
      </nav>
      <div class="network">
        <small>当前设备（可切换模拟多台平板）</small>
        <select v-model="store.deviceId" @change="store.setDevice(($event.target as HTMLSelectElement).value)" style="width:100%;margin:6px 0;padding:6px;border-radius:6px">
          <option v-for="d in devices" :key="d" :value="d">{{ d }}</option>
        </select>
        <small>设备与网络</small>
        <b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b>
        <NSwitch v-model:value="store.online" />
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px;color:#abc4c5">
          <NSwitch v-model:value="store.simulateFailure" size="small" /><small>弱网：推送随机丢 ACK（重试幂等演示）</small>
        </label>
        <small>最近同步 {{ store.lastSyncedAt ? new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') : '尚未同步' }}</small>
      </div>
    </aside>
    <main>
      <header>
        <div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>字段级留痕 · 到达顺序重放 · 不同字段自动合并、同字段人工选择，绝不整条覆盖。</p></div>
        <div class="status-chip"><NProgress type="circle" :percentage="percentage" :stroke-width="8" :width="42" /><span>{{ store.stats.queued ? `${store.stats.queued} 项待处理` : '数据已同步' }}</span></div>
      </header>
      <section class="metrics">
        <NCard><NStatistic label="评估家庭" :value="store.stats.households" /></NCard>
        <NCard><NStatistic label="紧急需求" :value="store.stats.urgent" /></NCard>
        <NCard><NStatistic label="待同步/待核对" :value="store.stats.queued" /></NCard>
        <NCard><NStatistic label="投递失败" :value="store.stats.failed" /></NCard>
      </section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon style="margin-bottom:14px">当前网络不可用。修改按记录+字段逐条写入本地日志（来源设备、设备序号、时间），恢复连接后按到达顺序重放。</NAlert>

      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false">
          <div class="households">
            <article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id; startFieldEdit()">
              <div>
                <b>{{ item.head }} · {{ item.members }}人</b>
                <small>{{ item.community }} / {{ item.address }}</small>
                <p>{{ item.needs.join('、') }} · {{ item.note }}</p>
              </div>
              <div class="h-meta">
                <NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag>
                <small>{{ item.status }} · 未完成任务 {{ store.openTaskCount(item.id) }}</small>
                <NButton size="tiny" :disabled="item.status === '已完成'" @click.stop="tryClose(item.id)">结案</NButton>
              </div>
            </article>
          </div>
        </NCard>
        <div class="side-stack">
          <NCard title="字段级修改（每字段一条留痕）">
            <p v-if="selected" class="sel-line">当前家庭：<b>{{ selected.head }}</b>（{{ selected.address }}）</p>
            <div class="field"><span>选择字段</span><NSelect v-model:value="editField" :options="fieldOptions" @update:value="startFieldEdit" /></div>
            <div class="field">
              <span>新值</span>
              <NSelect v-if="editField === 'needLevel'" v-model:value="editValue" :options="needOptions" />
              <NSelect v-else-if="editField === 'status'" v-model:value="editValue" :options="statusOptions" />
              <NInput v-else v-model:value="editValue" :type="editField === 'note' ? 'textarea' : 'text'" />
            </div>
            <div class="actions" style="margin-top:10px"><NButton type="primary" size="small" @click="saveFieldEdit">保存该字段</NButton><NButton size="small" @click="simulatePeer">模拟平板-B离线改同一户</NButton></div>
            <small v-if="editMessage" class="hint">{{ editMessage }}</small>
          </NCard>
          <NCard title="新增需求记录">
            <form class="field-grid" @submit.prevent="submit">
              <label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label>
              <label class="field"><span>社区</span><NInput v-model:value="community" /></label>
              <label class="field wide"><span>地址描述</span><NInput v-model:value="address" /><small>{{ errors.address }}</small></label>
              <label class="field"><span>家庭人数</span><NInput v-model:value="members" type="number" /></label>
              <label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="needOptions" /></label>
              <label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /></label>
              <label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label>
              <div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton></div>
            </form>
          </NCard>
        </div>
      </div>

      <NCard v-if="panel === '重复合并'" title="疑似重复记录">
        <div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate">
          <b>{{ group[0].head }} · {{ group[0].community }}</b>
          <p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p>
          <p class="hint">合并后：被合并记录上的任务全部转到保留记录；其后续到达的修改也自动落到保留记录。</p>
          <NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">保留「{{ group[0].address }}」，并入另一条并转移任务</NButton>
        </div>
        <p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p>
      </NCard>

      <div v-if="panel === '任务分派'" class="page-grid">
        <NCard title="任务列表">
          <div v-for="task in store.tasks" :key="task.id" class="task-row">
            <div>
              <b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b>
              <small>{{ store.householdById(task.householdId)?.head ?? '(已合并转单)' }} · 截止 {{ task.due }}</small>
            </div>
            <NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span>
            <NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton>
          </div>
          <p class="hint">任务完成不会自动结户；家庭状态必须在任务全部完成后显式结案。</p>
        </NCard>
        <NCard title="分派新任务">
          <p>当前家庭：<b>{{ selected?.head }}</b></p>
          <label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label>
          <label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label>
          <NButton type="primary" block style="margin-top:10px" :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton>
        </NCard>
      </div>

      <NCard v-if="panel === '同步队列'" title="待同步 / 到达归并">
        <div class="actions" style="margin-bottom:12px">
          <NButton type="primary" :loading="store.syncing" @click="doSync">联网后按到达顺序同步/重放</NButton>
          <NButton @click="doStress">压测：一键到达 200 条修改（目标 2 秒内）</NButton>
          <NButton @click="simulatePeer" :disabled="!selected">模拟平板-B离线改同一户</NButton>
        </div>
        <NAlert v-if="store.lastMessage" type="info" :show-icon="false" style="margin-bottom:12px">{{ store.lastMessage }}</NAlert>
        <div v-if="store.lastReport" class="report">
          上次归并：到达 {{ store.lastReport.total }} 条，生效 {{ store.lastReport.accepted }}，幂等重复 {{ store.lastReport.duplicate }}，冲突 {{ store.lastReport.conflicts }}，拒绝 {{ store.lastReport.rejected }}，引擎耗时 {{ store.lastReport.durationMs.toFixed(1) }}ms
          <b v-if="store.lastReport.durationMs < 2000">（满足 200 条 &lt; 2 秒）</b>
        </div>
        <h4>待发送（{{ store.pendingOps.length }}）</h4>
        <div v-for="item in store.pendingOps" :key="item.id" class="queue-row">
          <NTag>{{ ACTION_LABELS[item.action] ?? item.action }}</NTag>
          <span>{{ FIELD_LABELS[item.field ?? ''] ?? item.field ?? '' }} 来自 {{ item.deviceId }} #{{ item.deviceSeq }} · {{ item.resultNote ?? item.effect }}</span>
          <small>{{ new Date(item.opTime).toLocaleTimeString('zh-CN') }}</small>
        </div>
        <h4 v-if="store.failedOps.length">投递失败（{{ store.failedOps.length }}）——重试不会执行两次</h4>
        <div v-for="item in store.failedOps" :key="item.id" class="queue-row failed">
          <NTag type="error">投递失败</NTag><span>{{ ACTION_LABELS[item.action] ?? item.action }} · {{ item.field ?? '' }}（id={{ item.id.slice(0, 8) }}，effect 已执行 {{ item.appliedCount }} 次）</span><NButton size="tiny" @click="doSync">重试</NButton>
        </div>
        <h4 v-if="store.reviewOps.length">旧版待核对（{{ store.reviewOps.length }}）——不参与自动重放，人工核对后销项</h4>
        <div v-for="item in store.reviewOps" :key="item.id" class="queue-row">
          <NTag type="warning">待核对</NTag><span>{{ item.resultNote }}</span><NButton size="tiny" @click="store.markReviewed(item.id)">核对销项</NButton>
        </div>
        <p v-if="!store.pendingOps.length && !store.failedOps.length && !store.reviewOps.length" class="empty">待同步队列为空。</p>
      </NCard>

      <NCard v-if="panel === '冲突处理'" title="同一字段冲突：展示新旧值，人工选择">
        <div v-for="item in store.conflicts" :key="item.id" class="conflict">
          <b>{{ store.householdById(item.householdId)?.head ?? '(已合并家庭)' }} · {{ FIELD_LABELS[item.field] ?? item.field }}</b>
          <div class="conflict-values">
            <div v-for="(opt, i) in item.options" :key="i" :class="{ chosen: opt.chosen }">
              <small>候选 {{ i + 1 }} · 来源 {{ opt.deviceId }}（到达序号 {{ opt.arrivalSeq }}）</small>
              <span>{{ Array.isArray(opt.value) ? opt.value.join('、') : String(opt.value) }}</span>
            </div>
          </div>
          <div class="actions">
            <template v-if="item.status === '待选择'">
              <NButton v-for="(opt, i) in item.options" :key="i" size="small" :type="i === item.options.length - 1 ? 'primary' : 'default'" @click="store.resolveOne(item.id, i)">采用候选 {{ i + 1 }}</NButton>
            </template>
            <NTag v-else type="success">已解决（{{ item.resolvedBy }}，序号 {{ item.resolvedArrivalSeq }}）</NTag>
          </div>
        </div>
        <p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先在“同步队列”模拟平板-B离线修改后再同步。</p>
      </NCard>

      <NCard v-if="panel === '操作记录'" title="操作记录（来源设备 · 顺序 · 处理结果）">
        <div class="actions" style="margin-bottom:10px">
          <NButton v-for="f in ['全部', '已应用', '自动合并', '冲突', '幂等忽略', '转单应用', '拒绝']" :key="f" size="tiny" :type="auditFilter === f ? 'primary' : 'default'" @click="auditFilter = f">{{ f }}</NButton>
        </div>
        <div v-for="item in auditList.slice(0, 300)" :key="item.id" class="audit-row">
          <NTag size="small">#{{ item.arrivalSeq }}</NTag>
          <NTag size="small">{{ item.deviceId }}-{{ item.deviceSeq }}</NTag>
          <NTag size="small" :type="EFFECT_TYPE[item.effect] ?? 'default'">{{ item.effect }}</NTag>
          <span class="audit-main">{{ ACTION_LABELS[item.action] ?? item.action }} · 记录 {{ item.recordId }}<template v-if="item.mergedFromId"> ← 并入 {{ item.mergedFromId }}</template><template v-else-if="item.field"> · {{ FIELD_LABELS[item.field] ?? item.field }}</template></span>
          <small v-if="item.resultNote" class="hint">{{ item.resultNote }}</small>
          <small>{{ new Date(item.opTime).toLocaleTimeString('zh-CN') }}</small>
        </div>
      </NCard>
    </main>
  </div>
  <template #fallback><div style="padding:40px;color:#666">正在加载离线评估工作台…</div></template>
  </ClientOnly>
</template>
