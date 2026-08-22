#!/usr/bin/env node
/**
 * zotero.mjs — Zotero 操作层（zotnote skill）
 *
 * 提供: 配置验证 / 条目搜索 / 条目详情 / 本地或网络 PDF 定位 / collection 树
 *
 * 用法:
 *   node scripts/zotero.mjs --mode verify
 *   node scripts/zotero.mjs --mode search --query "white light flare" [--limit 10]
 *   node scripts/zotero.mjs --mode info --key KMF4PVSJ
 *   node scripts/zotero.mjs --mode tree
 *   node scripts/zotero.mjs --mode pdf --key KMF4PVSJ --out <dir> [--attachment <key>]
 *   node scripts/zotero.mjs --mode config --show
 *   node scripts/zotero.mjs --mode config --init   # 生成 config.json 模板
 *
 * 配置 (~/.config/zotnote/config.json):
 *   {
 *     "installDir": "...",
 *     "zotero": { "apiKey": "…", "userID": 15651072,
 *                 "storagePath": "E:/software/Zotero/Zotero/storage" },
 *     "obsidian": { "vaultRoot": "C:/Users/.../Obsidian Vault",
 *                   "notesRoot": "Zotero Notes",
 *                   "preferredCollection": null },
 *     "pythonCmd": "python"
 *   }
 */
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'https://api.zotero.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchRetry = async (url, opts, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
};

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function fail(msg) { console.error(`错误: ${msg}`); process.exit(1); }

const DEFAULT_CONFIG_SAMPLE = {
  installDir: '<本仓库绝对路径>',
  zotero: {
    apiKey: '<Zotero API key, https://www.zotero.org/settings/keys>',
    userID: 0,
    storagePath: '<Zotero 数据目录下的 storage, 如 E:/software/Zotero/Zotero/storage>',
  },
  obsidian: {
    vaultRoot: '<Obsidian Vault 绝对路径>',
    notesRoot: 'Zotero Notes',
    preferredCollection: null,
  },
  pythonCmd: 'python',
};

function configPath() {
  return path.join(os.homedir(), '.config', 'zotnote', 'config.json');
}

function sanitize(s, max = 150) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || '(untitled)';
}

function headers(cfg) {
  if (!cfg?.zotero?.apiKey) fail('缺少 zotero.apiKey（Zotero 设置 → 密钥 → 创建 API key）');
  return {
    'Zotero-API-Key': cfg.zotero.apiKey,
    'Zotero-API-Version': '3',
    'User-Agent': 'zotnote/0.1',
  };
}

async function getJson(cfg, url) {
  const res = await fetchRetry(url, { headers: headers(cfg) });
  return res.json();
}

/** 全量 collections: [{key,name,parentCollection}]，parentCollection 归一化 null */
async function allCollections(cfg) {
  const uid = cfg.zotero.userID;
  const out = [];
  let start = 0;
  for (;;) {
    const arr = await getJson(cfg, `${BASE}/users/${uid}/collections?start=${start}&limit=100&format=json`);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const c of arr) out.push({ key: c.key, name: c.data.name, parentCollection: c.data.parentCollection || null });
    start += 100;
    if (arr.length < 100) break;
    await sleep(200);
  }
  return out;
}

function buildTree(cols) {
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const pathOf = (key) => {
    const segs = [];
    let cur = key ? byKey.get(key) : null;
    while (cur) {
      segs.unshift(cur.name);
      cur = cur.parentCollection ? byKey.get(cur.parentCollection) : null;
    }
    return segs;
  };
  return { byKey, pathOf };
}

/** 找条目的 collection 路径: 多 collection 时取最深的, 可被 preferredCollection 覆盖 */
function pickCollectionPath(keys, tree, preferred) {
  if (!keys || keys.length === 0) return { path: [], keys: [] };
  const paths = keys.map((k) => tree.pathOf(k));
  let chosen = paths[0];
  if (preferred) {
    const hit = paths.find((p) => p[0] === preferred || p.some((s) => s === preferred));
    if (hit) chosen = hit;
    else if (paths.some((p) => p[0] === preferred)) chosen = paths.find((p) => p[0] === preferred);
  } else {
    chosen = paths.reduce((a, b) => (b.length > a.length ? b : a)); // 最深
  }
  return { path: chosen, keys };
}

function authorsOf(d) {
  return (d.creators ?? []).filter((c) => c.creatorType === 'author');
}
function yearOf(d) {
  const m = String(d.date ?? '').match(/(\d{4})/);
  return m ? m[1] : '';
}

function fmtItem(d, tree) {
  const { path } = pickCollectionPath(d.collections ?? [], tree, null);
  const auth = authorsOf(d).map((c) => c.name ?? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim());
  return {
    key: d.key,
    title: d.title,
    itemType: d.itemType,
    year: yearOf(d),
    authors: auth,
    journal: d.publicationTitle || d.repository || d.journalAbbreviation || '',
    doi: d.DOI || '',
    collections: path,
    citation: `${d.citationKey || ''}`,
  };
}

async function itemDetail(cfg, itemKey) {
  const d = (await getJson(cfg, `${BASE}/users/${cfg.zotero.userID}/items/${itemKey}?format=json`)).data;
  const kids = await getJson(cfg, `${BASE}/users/${cfg.zotero.userID}/items/${itemKey}/children?format=json&limit=100`).catch(() => []);
  let pdf = null;
  const attachments = (kids ?? []).map((k) => k.data).filter((x) => x.itemType === 'attachment');
  const pdfAtt = attachments.find((a) => (a.contentType || '').toLowerCase() === 'application/pdf') || attachments.find((a) => /\.pdf$/i.test(a.filename || ''));
  if (pdfAtt) {
    let local = null;
    const linkMode = pdfAtt.linkMode || '';
    if (linkMode === 'linked_file' && pdfAtt.path) {
      local = pdfAtt.path;
    } else {
      // imported_file / imported_url → storage/<attachmentKey>/<filename>
      const sp = cfg.zotero.storagePath;
      if (sp && pdfAtt.filename) {
        const cand = path.join(sp, pdfAtt.key, pdfAtt.filename);
        try { if ((await stat(cand)).isFile()) local = cand; } catch { /* 不存在 */ }
      }
    }
    pdf = {
      key: pdfAtt.key,
      filename: pdfAtt.filename || `attachment-${pdfAtt.key}.pdf`,
      localPath: local,
      webDownload: `${BASE}/users/${cfg.zotero.userID}/items/${pdfAtt.key}/file`,
      note: local ? null : '本地 storage 未命中, 需走 webDownload 下载',
    };
  }
  return { ...fmtItem(d, buildTree(await allCollections(cfg))), abstract: d.abstractNote || '', fullData: d, attachments: { list: attachments, pdf } };
}

async function cmdVerify(cfg) {
  const res = await fetchRetry(`${BASE}/keys/current`, { headers: headers(cfg) });
  const j = await res.json();
  console.log(JSON.stringify({ ok: true, username: j.username, userID: j.userID, access: j.access }, null, 2));
  if (!cfg.zotero.userID && j.userID) console.log(`提示: userID=${j.userID} 可写入 config.json（已自动使用）`);
  const uid = cfg.zotero.userID || j.userID;
  if (uid) {
    const cols = await allCollections({ ...cfg, zotero: { ...cfg.zotero, userID: uid } });
    console.log(`collections: ${cols.length} 个; 顶层: ${[...new Set(cols.filter((c) => !c.parentCollection).map((c) => c.name))].join(', ') || '(空)'}`);
  }
  const sp = cfg.zotero.storagePath;
  if (sp) {
    try { const n = (await stat(sp)).isDirectory() ? '✓' : '✗'; console.log(`storagePath: ${sp} ${n}`); } catch { console.log(`storagePath: ${sp} ✗ (不存在; 可留空, 走网络下载)`); }
  }
  const vr = cfg.obsidian?.vaultRoot;
  if (vr) {
    try { console.log(`vaultRoot: ${vr} ${(await stat(vr)).isDirectory() ? '✓' : '✗'}`); } catch { console.log(`vaultRoot: ${vr} ✗ (不存在)`); }
  }
}

async function cmdSearch(cfg, query, limit) {
  const q = encodeURIComponent(query);
  const arr = await getJson(cfg, `${BASE}/users/${cfg.zotero.userID}/items?q=${q}&qmode=titleCreatorYear&format=json&limit=${limit ?? 15}`);
  const tree = buildTree(await allCollections(cfg));
  const items = (Array.isArray(arr) ? arr : []).map((x) => fmtItem(x.data, tree));
  console.log(JSON.stringify({ count: items.length, items }, null, 2));
}

async function cmdInfo(cfg, key) {
  const info = await itemDetail(cfg, key);
  console.log(JSON.stringify(info, null, 2));
}

/** 枚举 collection 下所有条目（递归子 collection, 自动分页） */
async function cmdCollection(cfg, coll, recursive, withMeta) {
  const cols = await allCollections(cfg);
  const byKey = new Map((cols ?? []).map((c) => [c.key, c]));
  const target = coll
    ? (byKey.get(coll) || (cols ?? []).find((c) => c.name === coll))
    : null;
  if (!target) fail(`找不到 collection "${coll}"。运行 --mode tree 查看清单。`);

  // 收集目标 key 集合（可递归）
  const collKeys = new Set([target.key]);
  if (recursive) {
    const stack = [target.key];
    while (stack.length) {
      const cur = stack.pop();
      for (const c of (cols ?? [])) {
        if (c.parentCollection === cur && !collKeys.has(c.key)) {
          collKeys.add(c.key);
          stack.push(c.key);
        }
      }
    }
  }

  const tree = buildTree(cols ?? []);
  const items = [];
  for (const ck of collKeys) {
    let start = 0;
    for (;;) {
      const arr = await getJson(cfg, `${BASE}/users/${cfg.zotero.userID}/collections/${ck}/items?start=${start}&limit=100&format=json`);
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const x of arr) {
        const d = x.data;
        if (['attachment', 'note'].includes(d.itemType)) continue;
        items.push(withMeta ? await itemDetail(cfg, d.key) : fmtItem(d, tree));
      }
      start += 100;
      if (arr.length < 100) break;
      await sleep(200);
    }
  }
  // 去重（同一条目可能挂在多个子 collection）
  const seen = new Set();
  const uniq = items.filter((it) => (seen.has(it.key) ? false : (seen.add(it.key), true)));
  console.log(JSON.stringify({ collection: target.name, key: target.key, recursive: !!recursive, count: uniq.length, items: uniq }, null, 2));
}

async function cmdTree(cfg) {
  const cols = await allCollections(cfg);
  const tree = buildTree(cols);
  const roots = cols.filter((c) => !c.parentCollection);
  const walk = (parent, depth) => {
    const kids = cols.filter((c) => c.parentCollection === (parent?.key ?? null));
    for (const k of kids) {
      console.log(`${'  '.repeat(depth)}- ${k.name} (${k.key})`);
      walk(k, depth + 1);
    }
  };
  console.log('collection 树:');
  for (const r of roots) { console.log(`- ${r.name} (${r.key})`); walk(r, 1); }
  console.log(`共 ${cols.length} 个 collection`);
}

async function cmdPdf(cfg, key, outDir, attachmentKey) {
  const info = await itemDetail(cfg, key);
  const pdf = info.attachments.pdf;
  if (!pdf) fail(`条目 ${key} 无 PDF 附件`);
  if (attachmentKey && pdf.key !== attachmentKey) fail(`附件 ${attachmentKey} 不是 PDF (命中: ${pdf.key})`);
  await mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, `${sanitize(info.title)}.pdf`);
  if (pdf.localPath && !attachmentKey) {
    await copyFile(pdf.localPath, dest);
    console.log(JSON.stringify({ pdf: dest, source: 'local', attachmentKey: pdf.key, item: info }, null, 2));
    return;
  }
  // 下载 (web API file endpoint)
  const res = await fetchRetry(`${BASE}/users/${cfg.zotero.userID}/items/${pdf.key}/file`, { headers: headers(cfg) });
  if (!res.ok) fail(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(JSON.stringify({ pdf: dest, source: 'web', attachmentKey: pdf.key, bytes: buf.length, item: info }, null, 2));
}

async function cmdConfig(action) {
  const p = configPath();
  if (action === '--show') {
    if (!existsSync(p)) { console.log('config.json 不存在。运行 `node scripts/zotero.mjs --mode config --init` 生成模板。'); return; }
    console.log(await readFile(p, 'utf8'));
    return;
  }
  if (action === '--init') {
    if (existsSync(p)) { console.log(`已存在: ${p}\n如需重置请手动删除。`); return; }
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(DEFAULT_CONFIG_SAMPLE, null, 2));
    console.log(`已生成模板: ${p}\n请填写真实值后运行 --mode verify 验证。`);
    return;
  }
  fail(`未知 config 动作 ${action}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argOf(argv, '--mode') ?? 'verify';
  const cf = argOf(argv, '--config');
  const cfg = await (async () => {
    if (cf) return JSON.parse(await readFile(cf, 'utf8'));
    const p = configPath();
    if (!existsSync(p)) return { zotero: {}, obsidian: {}, installDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..') };
    const j = JSON.parse(await readFile(p, 'utf8'));
    j.installDir ||= path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    return j;
  })();

  switch (mode) {
    case 'verify': return await cmdVerify(cfg);
    case 'search': return await cmdSearch(cfg, argOf(argv, '--query') ?? '', Number(argOf(argv, '--limit') ?? 15));
    case 'info': return await cmdInfo(cfg, argOf(argv, '--key'));
    case 'collection': return await cmdCollection(cfg, argOf(argv, '--collection'), argv.includes('--recursive'), argv.includes('--with-meta'));
    case 'tree': return await cmdTree(cfg);
    case 'pdf': return await cmdPdf(cfg, argOf(argv, '--key'), argOf(argv, '--out') ?? path.join(os.tmpdir(), 'zotnote'), argOf(argv, '--attachment'));
    case 'config': return await cmdConfig(argv.includes('--show') ? '--show' : argv.includes('--init') ? '--init' : null);
    default: fail(`未知 mode: ${mode}`);
  }
}

main().catch((e) => { console.error(`失败: ${e.message}`); process.exit(1); });
