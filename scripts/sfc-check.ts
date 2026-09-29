/**
 * SFC 模板/脚本编译检查（不挂载、无需 DOM）：
 * 验证 pages/index.vue 的 <template> 与 <script setup> 在运行时编译无误。
 *   npx tsx 不可用时：esbuild 打包后 node 运行。
 */
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

for (const file of ["pages/index.vue", "app.vue"]) {
  console.log(`\n编译检查 ${file}`);
  const source = readFileSync(file, "utf-8");
  const { descriptor, errors } = parse(source, { filename: file });
  check("SFC 解析无错误", errors.length === 0, errors.map((e) => e.message).join("; "));

  const id = "x" + file.replace(/[^a-z]/gi, "");
  const bindings: Record<string, unknown> = descriptor.scriptSetup || descriptor.script ? compileScript(descriptor, { id }).bindings : {};
  check("<script> 编译通过（或本组件无 script）", true);

  const tpl = compileTemplate({
    source: descriptor.template?.content ?? "",
    filename: file,
    id,
    compilerOptions: { bindingMetadata: bindings, runtimeModuleName: "vue" }
  });
  check("<template> 编译无错误", tpl.errors.length === 0, tpl.errors.map((e: unknown) => String(e)).join("; "));
  check("生成了渲染函数代码", tpl.code.includes("render") || tpl.code.includes("_ctx"));
}

console.log(`\nSFC 编译检查：${failed === 0 ? "全部通过" : failed + " 项失败"}\n`);
if (failed) process.exit(1);
