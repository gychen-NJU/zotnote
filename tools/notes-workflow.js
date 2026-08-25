/**
 * notes-workflow.js — zotnote 精读层 workflow 编排脚本体（DSH workflow 工具用）
 *
 * ⚠️ 不作为 node 脚本直接运行; 复制本文件内容作为 workflow 工具的 script 参数,
 *     args = scripts/prepare-workflow.mjs 生成的 workflow-input.json 内容。
 *
 * 流程:
 *   1. prepare-workflow.mjs 扫描 workdir + Vault → workflow-input.json（待精读项 + vaultTitles）
 *   2. 本脚本并行 fan-out: 每篇一个 subagent（BATCH=3/波, 失败自动重试 1 次）
 *   3. schema 强校验: { key, notePath, status=精读完成, checkOk=true } +
 *      subagent 内部必跑 check-note.mjs 自检
 *   4. 输出 manifest { passed, failed }
 *
 * 篇间一致性: vaultTitles 预注入每个 prompt, [[wikilink]] 只能链清单内精确标题。
 *
 * 真实运行（2026-08-24）: 第2批剩余 8 篇, 8/8 通过, 15-44KB, 0 占位, 全部图解说,
 * wikilink 正确接线。已知注意: schema 的 enum 必须带 type（仅 enum 会被拒）。
 */
const items = args.items ?? [];
const vaultTitles = args.vaultTitles ?? [];
if (!items.length) throw new Error('无待精读条目（先跑 prepare-workflow.mjs）');

function buildPrompt(it) {
  const available = vaultTitles.length
    ? vaultTitles.slice(0, 250).map((t) => `  - [[${t}]]`).join('\n')
    : '  - (无)';
  return `你是 zotnote 精读 agent, 为 Zotero 条目 ${it.key} 完成学术级精读笔记。

【入口】
- 骨架笔记: 在 Obsidian Vault 的 Zotero Notes/ 下找到 item-key = ${it.key} 的 .md（用 grep 或 python 扫 vault 定位; 若同 key 有带日期后缀的旧骨架, 精读"无日期后缀版"）
- 提取产物: ${it.extractDir}（fulltext.md 全文按页分段通读; sections.json 参考; figures.json+figures/ 图清单）
- 论文: ${it.title} | ${(it.authors || []).join(', ')} | ${it.year} | ${it.journal || '—'}
- 预期图/表: ${it.expectedFigures} 张（以 figures.json 为准, 可能与预期不同, 以实际为准）

【撰写要求(全部必须)】
1. 逐节填写骨架中的占位(主要内容/科学问题/方法/特征性质结论/研究价值/关键公式), 每项成段叙述(自然语言+学术规范), 禁止残留任何 <!-- … --> 注释;
2. 关键数学/物理公式用 LaTeX($…$ 行内, $$…$$ 行间): $ 必须成对, 单位用 \\,\\mathrm{}, 希腊字母用 \\Delta \\alpha 等命令, 公式后附 1-2 句含义;
3. 每张图/表写三组解说(图表内容/图内解说/科学内涵), 原题注用 [!quote] 引用块保留在图中上方;
4. [[wikilink]] 只能链下面"可用笔记标题"清单里的精确文件名(无日期后缀、无 .md 后缀、与清单一字不差), 选真正相关的 3-6 篇; 没有相关标题就写"暂无相关笔记";
5. 完成后把 frontmatter 的 status 改为 精读完成;
6. 必做自检(最后一步): 用工具执行 node "E:\\GalaxyC\\scholar\\zotnote\\scripts\\check-note.mjs" --note "<你写的笔记文件绝对路径>" --json
   若输出 ok=false, 按 issues 逐条修复后重跑, 直到 ok=true 才能返回。路径含空格必须加双引号。

【可用笔记标题(供 wikilink, 只能精确选这些)】
${available}

最后返回 JSON 对象: { key, notePath, status, figuresExplained, checkOk, summary }。`;
}

const schema = {
  type: 'object',
  required: ['key', 'notePath', 'status', 'checkOk'],
  properties: {
    key: { type: 'string' },
    notePath: { type: 'string' },
    status: { type: 'string' },
    figuresExplained: { type: 'number' },
    checkOk: { type: 'boolean' },
    summary: { type: 'string' },
  },
};

const BATCH = 3;
const passed = [];
const failed = [];
phase('并行精读');

for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);
  log(`批次 ${i / BATCH + 1}/${Math.ceil(items.length / BATCH)}: ${batch.map((b) => b.key).join(', ')}`);
  await parallel(batch.map((it) => () => (async () => {
    const run = async (attempt) => {
      const r = await agent(buildPrompt(it), { label: `精读 ${it.key}${attempt > 1 ? ' (重试)' : ''}`, schema });
      return { r, attempt };
    };
    try {
      let res = await run(1);
      if (!res.r || res.r.checkOk !== true || res.r.status !== '精读完成') {
        log(`  ${it.key} 第1次未过闸(ok=${res.r?.checkOk}, status=${res.r?.status}), 重试`);
        res = await run(2);
      }
      if (!res.r || res.r.checkOk !== true || res.r.status !== '精读完成') {
        failed.push({ key: it.key, title: it.title, error: `两次未通过(ok=${res.r?.checkOk}, status=${res.r?.status})` });
        return null;
      }
      passed.push({ key: it.key, title: it.title, notePath: res.r.notePath, figuresExplained: res.r.figuresExplained });
      log(`  ✓ ${it.key} 通过`);
      return { key: it.key, notePath: res.r.notePath };
    } catch (e) {
      failed.push({ key: it.key, title: it.title, error: e.message });
      return null;
    }
  })()));
}

return {
  summary: { ok: failed.length === 0, total: items.length, passed: passed.length, failed: failed.length, passedKeys: passed.map((p) => p.key), failedKeys: failed.map((f) => f.key), failedDetails: failed },
  manifest: { generatedAt: new Date().toISOString(), passed: passed.map((p) => p.key), failed: failed.map((f) => f.key) },
};
