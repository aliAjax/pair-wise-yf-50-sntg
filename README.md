# pair-wise-yf-50 灾后需求评估与任务分派离线前端

评估员在弱网环境离线记录家庭需求、特殊照护和现场说明，团队负责人合并重复记录、分派复核任务并追踪进展。多人修改同一记录时按**字段级**留痕与合并，不做整条覆盖。

## 离线冲突归并模型

- **字段级操作日志（oplog）**：每次修改按「记录 + 字段」生成一条不可变操作（`utils/sync.ts` 的 `Op`），含来源设备、设备端时间，不再整条保存/覆盖记录。
- **到达顺序重放**：联网后异地（先到达服务端）与本机（后同步）操作按到达顺序统一编号（`arrivalSeq`）逐条重放。
  - **不同字段**：自动合并；
  - **同一字段、不同设备、值不同**：先到方保留，后到方挂起为字段冲突，界面展示新旧值与双方设备，人工选择采用旧值/新值；
  - **同一设备**对同一字段的连续编辑视为正常修改（最后写入即最新），不产生伪冲突。
- **重复登记合并**：先把源记录上的任务转到保留记录，再删除源记录（任务不丢）；之后到达、仍指向旧记录的操作按重定向落到保留记录。
- **家庭状态派生**：`deriveHouseholdStatus` 由任务完成度派生——无任务=待评估，尚有未完成任务=已分派，全部完成才可结为已完成。任务全部完成前不能结掉家庭状态。
- **旧版数据接续**：检测到旧版（整条覆盖时代）缓存里的 `queue` 时，实体沿用为基线、旧改动迁移为 `legacy.carried` 操作，同步时接续为已生效并留痕。
- **失败重试幂等**：每条操作有全局 id 与服务端幂等集合 `processed`；响应中断时已送达未确认的操作（`pendingAck`）下一轮原样重发，只判 `duplicate` 不执行第二次，未送达的补送一次。
- **性能**：200 条字段修改的归并在纯引擎中约 1ms（预算 2000ms），界面有「压测：离线 200 条修改」按钮实测。
- **操作留痕**：审计记录每条操作的来源设备、到达顺序与处理结果（已生效 / 冲突挂起 / 重试去重 / 规则拦截 / 未执行）。

## 技术栈

Nuxt3（SPA）、TypeScript、Naive UI、Pinia、Axios、VueUse、VeeValidate、Zod、Vue I18n。

## 本地运行

```bash
npm install
npm run dev      # 端口 62015
npm run build
```

## 验证脚本

```bash
# 纯归并/重放引擎用例（41 项）：字段合并、冲突新旧值、合并转任务、结单规则、
# 旧版接续、失败重试幂等、200 条性能、来源设备/顺序/结果留痕
npx tsc utils/sync.ts scripts/verify.ts --outDir /tmp/v --target es2022 \
  --module commonjs --moduleResolution node --skipLibCheck
node /tmp/v/scripts/verify.js

# 真实 Pinia store 集成用例（39 项，Node + 内存 localStorage）
npx esbuild scripts/store-test.ts --bundle --platform=node --format=esm \
  --alias:~=. --outfile=/tmp/store.test.mjs
node /tmp/store.test.mjs

# Vue SFC 模板/脚本编译检查
npx esbuild scripts/sfc-check.ts --platform=node --format=esm \
  --outfile scripts/.sfc-check.mjs --packages=external
node scripts/.sfc-check.mjs && rm scripts/.sfc-check.mjs
```

## 界面操作路径

1. 「需求记录」里逐字段编辑（每字段一条待发操作）或新增记录；
2. 用侧栏开关切到离线制造修改；「同步队列」可勾选「模拟下次同步中途失败」；
3. 「联网归并」按到达顺序重放，报告显示生效/冲突/重试去重/未送达条数与耗时；
4. 「冲突处理」对同字段冲突查看新旧值并选择；「重复合并」转移任务并取需求并集；
5. 「操作留痕」按 `#顺序 · 来源设备 · 处理结果 · 说明` 审计每条操作。
