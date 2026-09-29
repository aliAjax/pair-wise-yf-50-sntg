<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore } from "~/stores/assessment";
import type { Household, MergedField, NeedLevel, OpResultType } from "~/utils/sync";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed<Household | undefined>(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);

const editableFields: { key: MergedField; label: string }[] = [
  { key: "head", label: "户主" },
  { key: "community", label: "社区" },
  { key: "address", label: "地址" },
  { key: "members", label: "人数" },
  { key: "needLevel", label: "需求等级" },
  { key: "note", label: "现场说明" }
];
const editForm = reactive<Record<MergedField, string>>({ head: "", community: "", address: "", members: "1", vulnerable: "", needLevel: "一般", needs: "", note: "" });
watch(
  selected,
  (h) => {
    if (!h) return;
    editForm.head = h.head;
    editForm.community = h.community;
    editForm.address = h.address;
    editForm.members = String(h.members);
    editForm.needLevel = h.needLevel;
    editForm.note = h.note;
    editForm.needs = h.needs.join("，");
    editForm.vulnerable = h.vulnerable.join("，");
  },
  { immediate: true }
);
function saveFields() {
  if (!selected.value) return;
  const patch: Partial<Pick<Household, MergedField>> = {};
  const cur = selected.value;
  if (editForm.address !== cur.address) patch.address = editForm.address;
  if (editForm.note !== cur.note) patch.note = editForm.note;
  if (editForm.head !== cur.head) patch.head = editForm.head;
  if (editForm.community !== cur.community) patch.community = editForm.community;
  if (Number(editForm.members) !== cur.members && Number(editForm.members) > 0) patch.members = Number(editForm.members);
  if (editForm.needLevel !== cur.needLevel) patch.needLevel = editForm.needLevel as NeedLevel;
  if (editForm.needs !== cur.needs.join("，")) patch.needs = editForm.needs.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  if (Object.keys(patch).length) {
    store.updateHouseholdFields(cur.id, patch);
    syncMessage.value = `已按字段记录 ${Object.keys(patch).length} 项修改到待发队列，不会整条覆盖。`;
  }
}

const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
async function sync() {
  if (!store.online) {
    syncMessage.value = "仍在弱网状态，操作日志保留在设备中；联网后按到达顺序归并。";
    return;
  }
  syncMessage.value = "正在按到达顺序重放归并…";
  const report = await store.synchronize();
  syncMessage.value = report.partial
    ? `同步中途失败：${report.merged} 条已生效，${report.failed} 条未送达保留待重试（已生效部分不会重复执行）。`
    : `归并完成：生效 ${report.merged} 条，字段冲突 ${report.conflicts} 个，重试去重 ${report.duplicates} 条，耗时 ${report.elapsedMs} ms。`;
}
async function runBenchmark() {
  syncMessage.value = "离线灌入 200 条字段修改并立即归并…";
  const report = await store.benchmark();
  syncMessage.value = `200 条归并耗时 ${report.elapsedMs} ms（预算 2000 ms），冲突 ${report.conflicts} 个，可在「操作留痕」核对来源设备与顺序。`;
}

const resultTagType: Record<OpResultType, "success" | "warning" | "info" | "error" | "default"> = {
  applied: "success",
  conflict: "warning",
  duplicate: "info",
  "rule-blocked": "error",
  ignored: "default"
};
const resultLabel: Record<OpResultType, string> = {
  applied: "已生效",
  conflict: "冲突挂起",
  duplicate: "重试去重",
  "rule-blocked": "规则拦截",
  ignored: "未执行"
};
function householdName(id: string) {
  return store.households.find((h) => h.id === id)?.head ?? store.tasks.find((t) => t.householdId === id)?.householdId ?? id;
}
function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join("、");
  if (v === undefined || v === null || v === "") return "—";
  return String(v);
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理', '操作留痕']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.outbox.length">({{ store.outbox.length }})</span><span v-else-if="item === '冲突处理' && store.conflicts.filter((c) => c.status === '待处理').length" class="nav-dot">·{{ store.conflicts.filter((c) => c.status === '待处理').length }}</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>当前设备：{{ store.device.label }}</small><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>字段级操作日志 + 到达顺序重放：不同字段自动合并，同字段冲突人工选择，绝不整条覆盖。</p></div><div class="status-chip"><NProgress type="circle" :percentage="store.outbox.length ? Math.max(6, 100 - store.outbox.length * 4) : 100" :stroke-width="8" :width="42" /><span>{{ store.outbox.length ? `${store.outbox.length} 条待发` : '数据已归并' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="待发操作" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。所有修改按「记录 + 字段」写入本地操作日志，恢复连接后按到达顺序重放；失败重试有幂等保护。</NAlert>

      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div class="household-meta"><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><NTag :type="item.status === '已完成' ? 'success' : item.status === '已分派' ? 'warning' : 'default'">{{ item.status }}</NTag><small>v{{ item.version }}</small></div></article></div></NCard>
        <div class="side-stack">
          <NCard title="字段级编辑（按字段留痕）" :bordered="false">
            <p v-if="selected" class="selected-line">当前：<b>{{ selected.head }}</b>（家庭状态由任务完成度派生，任务未全完成不可结单）</p>
            <div class="field-grid edit-grid">
              <label class="field"><span>户主姓名</span><NInput v-model:value="editForm.head" /></label>
              <label class="field"><span>社区</span><NInput v-model:value="editForm.community" /></label>
              <label class="field wide"><span>地址</span><NInput v-model:value="editForm.address" /></label>
              <label class="field"><span>人数</span><NInput v-model:value="editForm.members" type="number" /></label>
              <label class="field"><span>需求等级</span><NSelect v-model:value="editForm.needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label>
              <label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="editForm.needs" /></label>
              <label class="field wide"><span>现场说明</span><NInput v-model:value="editForm.note" type="textarea" /></label>
            </div>
            <div class="actions"><NButton type="primary" :disabled="!selected" @click="saveFields">逐字段存入待发队列</NButton></div>
          </NCard>
          <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="members" type="number" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton></div></form></NCard>
        </div>
      </div>

      <NCard v-if="panel === '重复合并'" title="疑似重复记录（合并时任务先转到保留记录）"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><div class="merge-rows"><div v-for="item in group" :key="item.id"><NTag :type="item.id === group[0].id ? 'success' : 'warning'">{{ item.id === group[0].id ? '保留' : '合并转移' }}</NTag><span>{{ item.address }}</span><small>关联任务 {{ store.tasks.filter((t) => t.householdId === item.id).length }} 个</small></div></div><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并：任务转入保留记录、需求取并集</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>

      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表（家庭状态由任务完成度派生）"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ householdName(task.householdId) }} · 截止 {{ task.due }}</small></div><NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton></div><p class="empty" v-if="!store.tasks.length">暂无任务。</p></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并写入字段操作日志</NButton><small class="hint">最后一个任务完成前，家庭状态不会结为「已完成」。</small></NCard></div>

      <NCard v-if="panel === '同步队列'" title="待同步操作日志（每条修改按记录+字段留痕）">
        <p>{{ syncMessage || '恢复连接后按服务端到达顺序重放：不同字段自动合并，同字段挂起冲突。' }}</p>
        <div class="sync-controls">
          <NButton type="primary" :loading="store.syncing" @click="sync">联网归并</NButton>
          <NButton :loading="store.syncing" @click="runBenchmark">压测：离线 200 条修改</NButton>
          <label class="switch-line"><NSwitch v-model:value="store.failNextSync" /> 模拟下次同步中途失败（验证重试不执行两次）</label>
        </div>
        <div v-if="store.lastReport" class="report">
          上次归并：生效 <b>{{ store.lastReport.merged }}</b> · 冲突 <b>{{ store.lastReport.conflicts }}</b> · 重试去重 <b>{{ store.lastReport.duplicates }}</b> · 未送达 <b>{{ store.lastReport.failed }}</b> · 耗时 <b>{{ store.lastReport.elapsedMs }}ms</b>
          <NTag v-if="store.lastReport.partial" type="error" size="small">部分失败</NTag>
        </div>
        <div v-for="item in store.outbox" :key="item.id" class="queue-row"><NTag size="small">{{ item.type }}</NTag><span class="queue-main">{{ item.recordId || item.taskId }} · <b>{{ item.field || '—' }}</b> = {{ formatValue(item.value) }}</span><small>{{ item.deviceLabel }} · {{ new Date(item.clientTime).toLocaleTimeString('zh-CN') }}</small></div>
        <p v-if="!store.outbox.length" class="empty">待发队列为空，所有操作日志已归并到服务端。</p>
        <small v-if="cacheProbe"> 本地缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small>
      </NCard>

      <NCard v-if="panel === '冲突处理'" title="字段级冲突（展示新旧值，人工选择，不静默覆盖）"><div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ householdName(item.recordId) }} · {{ item.kind === 'task' ? '任务' : '家庭' }}字段「{{ item.field }}」 <NTag size="small" :type="item.status === '待处理' ? 'warning' : 'success'">{{ item.status }}</NTag></b><div class="conflict-values"><div><small>先到方（当前生效）· {{ item.winnerDevice }}</small><span>{{ formatValue(item.currentValue) }}</span></div><div><small>后到方（待选新值）· {{ item.loserDevice }}</small><span>{{ formatValue(item.incomingValue) }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveFieldConflict(item.id, '采用旧值')">保留旧值</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveFieldConflict(item.id, '采用新值')">采用新值</NButton><small>到达顺序 #{{ item.arrivalSeq }}</small></div></div><p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先离线改地址/说明，再点「联网归并」体验多人同字段合并。</p></NCard>

      <NCard v-if="panel === '操作留痕'" title="操作记录（来源设备 · 到达顺序 · 处理结果）">
        <div class="audit-head"><span>顺序</span><span>来源设备</span><span>处理结果</span><span class="audit-detail">说明</span></div>
        <div v-for="r in [...store.audit].reverse()" :key="r.opId + r.arrivalSeq + r.type" class="audit-row"><span>#{{ r.arrivalSeq }}</span><span>{{ r.deviceLabel }}</span><NTag size="small" :type="resultTagType[r.type]">{{ resultLabel[r.type] }}</NTag><span class="audit-detail">{{ r.detail }}</span></div>
        <p v-if="!store.audit.length" class="empty">尚无归并记录。执行一次「联网归并」或压测后这里会列出每条操作的来源设备、顺序与结果。</p>
      </NCard>
    </main>
  </div>
</template>
