#!/usr/bin/env node
/**
 * check-note.mjs — zotnote 笔记完成度校验器（内容级, 供 workflow schema 与人工审计使用）
 *
 * 校验规则（返回 pass/fail 列表）:
 *   1. status-required  : frontmatter status == "精读完成"
 *   2. no-placeholder   : 正文无 <!-- … --> 占位符残留（可含公式示例注释, 只要写进笔记
 *                         就不应保留; 公式区模板注释已给出示例, 若未替换则为残留）
 *   3. dollar-balanced  : $ 数量为偶数（LaTeX 行内/行间公式配对）
 *   4. figures-explain  : 笔记引用的每张图都有「图表内容」「图内解说」「科学内涵」三段
 *                         （按 图引用数 与 三段标注数 对比）
 *   5. size-threshold   : 正文 >= 8KB（精读完成的基本规模, 骨架通常 < 2KB 会被拦截）
 *   6. no-bare-quote    : 无残留的 "> [!quote] 原题注" 空引用（题注已并入解说, 允许保留,
 *                         但全空说明未处理）——该项仅提示
 *
 * 用法:
 *   node scripts/check-note.mjs --note <path.md> [--figures <N预期图数>] [--json]
 *   退出码: 0=全部通过, 1=必检失败, 2=参数错误
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function fail(msg) { console.error(`错误: ${msg}`); process.exit(2); }

async function main() {
  const argv = process.argv.slice(2);
  const note = argOf(argv, '--note');
  const expectFigures = Number(argOf(argv, '--figures') ?? 0);
  const asJson = argv.includes('--json');
  if (!note || !existsSync(note)) fail(`笔记文件不存在: ${note}`);

  const src = await readFile(note, 'utf8');
  const body = src.includes('---\n') ? src.replace(/^---\n[\s\S]*?\n---\n?/, '') : src;
  const front = src.includes('---\n') ? src.slice(0, src.indexOf('\n---\n')) : '';
  const issues = [];
  const warns = [];

  // 1) status
  const st = (front.match(/^status:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
  if (st !== '精读完成') issues.push(`status 应为"精读完成", 实际为"${st || '(无)'}"`);

  // 2) 占位符残留（模板注释块）
  const placeholders = (body.match(/<!--\s*[\s\S]*?-->/g) ?? []).length;
  if (placeholders > 0) issues.push(`正文残留 ${placeholders} 处 <!-- … --> 占位注释`);

  // 3) $ 配对
  const dollars = (body.match(/\$/g) ?? []).length;
  if (dollars % 2 !== 0) issues.push(`美元符号 ${dollars} 个（奇数, LaTeX 公式未配对）`);

  // 4) 图表解说
  const imgRefs = (body.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length;
  const hintArr = (body.match(/\*\*图表内容\*\*/g) ?? []).length;
  const explArr = (body.match(/\*\*图内解说\*\*/g) ?? []).length;
  const sciArr = (body.match(/\*\*科学内涵\*\*/g) ?? []).length;
  if (imgRefs === 0) issues.push('正文无任何图片引用（图文并茂失效）');
  else {
    if (hintArr < imgRefs) issues.push(`图片引用 ${imgRefs} 处, 但图表内容标注只有 ${hintArr} 段——至少 ${imgRefs - hintArr} 张图未解说`);
    if (explArr < imgRefs) issues.push(`图片引用 ${imgRefs} 处, 图内解说只有 ${explArr} 段`);
    if (sciArr < imgRefs) issues.push(`图片引用 ${imgRefs} 处, 科学内涵只有 ${sciArr} 段`);
  }
  if (expectFigures > 0 && imgRefs < expectFigures) warns.push(`预期 ${expectFigures} 张图, 实际引用 ${imgRefs} 张（原图提取少于预期?）`);

  // 5) 规模
  if (Buffer.byteLength(body, 'utf8') < 8 * 1024) issues.push(`正文仅 ${(Buffer.byteLength(body, 'utf8') / 1024).toFixed(1)}KB, 疑似未完成骨架`);

  // 6) 空题注引用提示
  const emptyQuotes = (body.match(/\[!quote\] 原题注[^\n]*\n\s*\n/g) ?? []).length;
  if (emptyQuotes > 0) warns.push(`${emptyQuotes} 处原题注块后无内容（若解说在下方属正常, 仅提示）`);

  const ok = issues.length === 0;
  const out = {
    ok,
    note,
    issues,
    warns,
    stats: {
      bytes: Buffer.byteLength(body, 'utf8'),
      placeholders,
      dollars,
      images: imgRefs,
      sections: { hintArr, explArr, sciArr },
      status: st,
    },
  };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(ok ? `✅ 通过: ${note}` : `❌ 未通过: ${note}`);
    for (const i of issues) console.log(`   - ${i}`);
    for (const w of warns) console.log(`   ⚠ ${w}`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(`失败: ${e.message}`); process.exit(2); });
