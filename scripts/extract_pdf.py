#!/usr/bin/env python3
"""
extract_pdf.py — zotnote 论文结构/图表提取器（PyMuPDF）

功能:
  1. 逐页提取文本, 输出 fulltext.md（含页码标记）
  2. 依据字号+编号模式识别章节标题, 输出 sections.json
  3. 依据图/表题注正则定位 Figure/Table, 裁剪图中区域为 PNG
     - 位图: 直接取嵌入图像 bbox 裁剪
     - 矢量/混合图: 取题注上方文本间隙区域整体裁剪
  4. 输出 figures.json（id/文件/页码/题注/来源）

用法:
  python extract_pdf.py extract <pdf> --out <dir> [--dpi 200]
  python extract_pdf.py crop <pdf> --out <png> --page 3 --rect "x0,y0,x1,y1" [--dpi 300]
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# Windows 控制台默认 GBK, 输出含 Å/希腊字母等会崩溃 — 强制 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("需要 PyMuPDF: pip install pymupdf  (当前机器已装 1.27.x)")

CAPTION_RE = re.compile(
    r"^\s*(?:Figure|Fig\.?|TABLE|Table|Box|Scheme|图|表|圖)\s*(\d+[A-Za-z]?)\s*[.:：)\-–·\s]",
    re.IGNORECASE,
)
HEADING_WORD_RE = re.compile(
    r"^\s*(Abstract|Introduction|Methods?|Results?|Discussion|Conclusion|Conclusions|"
    r"References|Acknowledg|Appendix|Summary|摘要|引言|方法|结果|讨论|结论|参考文献|致谢)\b",
    re.IGNORECASE,
)
# 明确排除的伪标题: 图内标注 (a)/(b)、时间戳 "01:45:39UT"、裸编号 "1."、"WL" 等
NOISE_RE = re.compile(
    r"^\s*(\(\s*[a-z]\s*\)|\([a-z]\)|\d{1,4}[:.]\d{2}(?::\d{2})?\s*(?:UT)?\s*$|"
        r"[A-Z]{1,3}\s*$|"
    r"arXiv:\s*\S+|"
    r"\d+[A-Z][A-Za-z]*(?:\s+[A-Za-z]+)*\s*(?:大学|Observatory|Institute|University|Department|Research|Laboratory)\s*.*$|"
    r"\w*\s*[\u2013\u2014]\s*\d+\s*[\u2013\u2014]\s*$|"
    r"\d{1,6}\s*$)"
)


def page_blocks(page):
    """按阅读顺序返回文本块: [{text, bbox, size}]"""
    d = page.get_text("dict")
    blocks = []
    for b in d.get("blocks", []):
        if b.get("type") != 0:
            continue
        lines = ["".join(sp.get("text", "") for sp in line.get("spans", [])) for line in b.get("lines", [])]
        raw = "\n".join(lines)
        if not raw.strip():
            continue
        sizes = [sp["size"] for line in b.get("lines", []) for sp in line.get("spans", []) if sp.get("text", "").strip()]
        blocks.append({"text": raw, "bbox": fitz.Rect(b["bbox"]), "size": max(sizes) if sizes else 0})
    blocks.sort(key=lambda bl: (round(bl["bbox"].y0, 1), bl["bbox"].x0))
    return blocks


def body_size(blocks, default=9.0):
    """正文主字号 = 文本量大的块中出现频率最高的字号"""
    sizes = [round(b["size"], 1) for b in blocks if b["text"].strip() and len(b["text"]) > 30]
    if not sizes:
        return default
    return Counter(sizes).most_common(1)[0][0]


def detect_headings(blocks, body, page_no):
    """检测章节标题: 标准章节词 / 编号模式 / 字号显著大于正文
    处理编号与标题分离的排版: "1." 与 "Introduction" 相邻块自动合并标题。
    """
    heads = []
    # 首页前置区: 跳过 ABSTRACT/摘要 之前的元信息块
    abstract_idx = None
    if page_no == 1:
        for j, bl in enumerate(blocks):
            first_j = bl["text"].strip().split("\n")[0].strip()
            if first_j.upper() in ("ABSTRACT", "SUMMARY") or first_j in ("摘要",):
                abstract_idx = j
                break

    for i, bl in enumerate(blocks):
        t = bl["text"].strip()
        if not t or len(t) > 120:
            continue
        line0 = t.split("\n")[0].strip()
        if len(line0) > 90:
            continue
        if NOISE_RE.match(line0):
            continue
        # 图题注/表题注不算章节
        if CAPTION_RE.match(line0):
            continue
        if page_no == 1 and abstract_idx is not None and i < abstract_idx:
            continue
        is_word = bool(HEADING_WORD_RE.match(line0))
        is_num = bool(re.match(r"^\s*\d+(\.\d+){0,3}\s*[.\s:A-Z\u4e00-\u9fff]", line0))
        bare_num = bool(re.match(r"^\s*\d+(\.\d+){1,3}\.?\s*$|^\s*\d+\.\s*$", line0))
        big = (
            bl["size"] >= body * 1.15
            and 5 <= len(line0) <= 90
            and re.search(r"[\u4e00-\u9fff]|[A-Za-z]{4,}", line0)
        )
        if not (is_word or is_num or bare_num or big):
            continue
        title = line0
        # 编号与标题分离处理:
        # 1) 本块内换行就是标题 ("1.\nIntroduction")
        all_lines = [ln.strip() for ln in t.split("\n") if ln.strip()]
        if bare_num and len(all_lines) > 1:
            nxt_title = all_lines[1]
            if len(nxt_title) < 120 and not NOISE_RE.match(nxt_title):
                title = f"{line0} {nxt_title}"
        # 2) 编号独立成块, 标题是紧随其后的相邻块
        elif bare_num and i + 1 < len(blocks):
            nxt = blocks[i + 1]
            gap = nxt["bbox"].y0 - bl["bbox"].y1
            if 0 < gap < 40:
                nxt_title = nxt["text"].strip().splitlines()[0].strip()
                if len(nxt_title) < 120 and not NOISE_RE.match(nxt_title) and not CAPTION_RE.match(nxt_title):
                    title = f"{line0} {nxt_title}"
        level = 1 if (big or is_word) else 2
        heads.append({"level": level, "title": title, "page": page_no, "y": round(bl["bbox"].y0, 1)})
    return heads


def find_captions(blocks, page_no):
    """识别题注块: 以 Figure/Table 起始"""
    caps = []
    for i, bl in enumerate(blocks):
        first = bl["text"].strip()
        m = CAPTION_RE.match(first)
        if m:
            kind = "table" if re.match(r"^\s*(Table|TABLE|表)", first) else "figure"
            caps.append(
                {
                    "label": m.group(1),
                    "kind": kind,
                    "caption": " ".join(first.split())[:500],
                    "bbox": fitz.Rect(bl["bbox"]),
                    "page": page_no,
                    "block_index": i,
                }
            )
    return caps


def raster_figures(page):
    """页内嵌入图像: [{xref, bbox, w, h}]，跳过小图标/水印"""
    out = []
    for info in page.get_image_info(xrefs=True):
        bbox = fitz.Rect(info["bbox"])
        if bbox.width < 45 or bbox.height < 35:
            continue
        out.append({"xref": info["xref"], "bbox": bbox, "w": info.get("width", 0) or 0, "h": info.get("height", 0) or 0})
    return out


def column_span(page, blocks, cap_bbox):
    """估算题注所在栏的 x 范围"""
    page_w = page.rect.width
    if (cap_bbox.x1 - cap_bbox.x0) > page_w * 0.55:
        return fitz.Rect(0, 0, page_w, page.rect.height)  # 全宽
    near = [
        b["bbox"]
        for b in blocks
        if abs(b["bbox"].y0 - cap_bbox.y0) < 400
        and b["bbox"].x0 > cap_bbox.x0 - 260
        and b["bbox"].x1 < cap_bbox.x1 + 260
    ]
    if near:
        return fitz.Rect(min(b.x0 for b in near), 0, max(b.x1 for b in near), page.rect.height)
    return fitz.Rect(max(0, cap_bbox.x0 - 30), 0, min(page_w, cap_bbox.x1 + 30), page.rect.height)


def crop_region(page, rect, out_path, dpi):
    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect, alpha=False)
    pix.save(out_path)
    return pix.width, pix.height


def main():
    ap = argparse.ArgumentParser(description="zotnote 论文提取器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_ext = sub.add_parser("extract", help="提取全文/章节/图表")
    p_ext.add_argument("pdf")
    p_ext.add_argument("--out", required=True)
    p_ext.add_argument("--dpi", type=int, default=200)
    p_ext.add_argument("--skip-figures", action="store_true", help="只提取文本")

    p_crop = sub.add_parser("crop", help="手工裁剪一页矩形区域")
    p_crop.add_argument("pdf")
    p_crop.add_argument("--out", required=True)
    p_crop.add_argument("--page", type=int, required=True)
    p_crop.add_argument("--rect", required=True, help="x0,y0,x1,y1 (PDF 坐标 pt)")
    p_crop.add_argument("--dpi", type=int, default=300)

    args = ap.parse_args()

    if args.cmd == "crop":
        doc = fitz.open(args.pdf)
        page = doc[args.page - 1]
        x0, y0, x1, y1 = [float(v) for v in args.rect.split(",")]
        w, h = crop_region(page, fitz.Rect(x0, y0, x1, y1), args.out, args.dpi)
        print(json.dumps({"ok": True, "out": args.out, "w": w, "h": h}))
        return

    # ---- extract ----
    doc = fitz.open(args.pdf)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fig_dir = out / "figures"
    if not args.skip_figures:
        fig_dir.mkdir(exist_ok=True)

    all_heads, all_caps, all_figs, md_pages = [], [], [], []

    for page in doc:
        blocks = page_blocks(page)
        body = body_size(blocks)
        pno = page.number + 1

        # 1) 全文
        lines = [ln.strip() for bl in blocks for ln in bl["text"].split("\n") if ln.strip()]
        md_pages.append(f"<!-- page {pno} -->\n\n" + "\n\n".join(lines) + "\n")

        # 2) 标题
        all_heads.extend(detect_headings(blocks, body, pno))

        # 3) 题注与图
        caps = find_captions(blocks, pno)
        imgs = raster_figures(page) if not args.skip_figures else []
        for cap in caps:
            page_col = column_span(page, blocks, cap["bbox"])
            chosen = None
            # a) 位图匹配: 题注上方的图像(窗口放宽到整页, 支持竖直堆叠多panel)
            cands = [
                im
                for im in imgs
                if im["bbox"].y1 <= cap["bbox"].y0 + 12
                and im["bbox"].y0 >= page_col.y0
                and im["bbox"].x0 >= page_col.x0 - 60
                and im["bbox"].x1 <= page_col.x1 + 60
            ]
            if cands:
                cands.sort(key=lambda im: (im["bbox"].y1, im["bbox"].x0), reverse=True)
                first = cands[0]["bbox"]
                top, bottom = first.y0, first.y1
                x0, x1 = first.x0, first.x1
                # 向上合并: 上方紧贴(间距<45pt)且水平有重叠的相邻 panel
                changed = True
                while changed:
                    changed = False
                    for im in cands:
                        ib = im["bbox"]
                        if ib.y1 >= top - 45 and ib.y1 <= top + 12:
                            if ib.x0 <= x1 + 40 and ib.x1 >= x0 - 40:
                                nt = min(top, ib.y0)
                                nx0, nx1 = min(x0, ib.x0), max(x1, ib.x1)
                                if (nt, nx0, nx1) != (top, x0, x1):
                                    top, x0, x1, changed = nt, nx0, nx1, True
                rect = fitz.Rect(page_col.x0, max(page_col.y0, top - 4), page_col.x1, min(page_col.y1, bottom + 4))
                chosen = {"kind": "raster", "rect": rect}
            elif not args.skip_figures:
                # b) 矢量图: 用页内矢量绘图(drawings)包围盒定位, 更精确
                drects = [
                    fitz.Rect(d_["rect"])
                    for d_ in page.get_drawings()
                    if fitz.Rect(d_["rect"]).y1 <= cap["bbox"].y0 + 6
                    and fitz.Rect(d_["rect"]).height > 4
                    and fitz.Rect(d_["rect"]).width > 4
                ]
                if drects:
                    union = drects[0]
                    for dr in drects[1:]:
                        union |= dr
                    if 25 < union.height < page.rect.height * 0.9 and union.width > 60:
                        rect = fitz.Rect(
                            max(page_col.x0, union.x0 - 6),
                            max(union.y0 - 6, 0),
                            min(page_col.x1, union.x1 + 6),
                            min(cap["bbox"].y0 - 2, union.y1 + 6),
                        )
                        chosen = {"kind": "vector", "rect": rect}
                if chosen is None:
                    # c) 兜底: 题注上方文本间隙区域
                    pre = [
                        b
                        for b in blocks
                        if b["bbox"].y1 <= cap["bbox"].y0 + 4
                        and b["bbox"].x0 >= page_col.x0 - 40
                        and b["bbox"].x1 <= page_col.x1 + 40
                    ]
                    top_y = max((b["bbox"].y1 for b in pre), default=page_col.y0)
                    gap = cap["bbox"].y0 - top_y
                    if 25 < gap < page.rect.height * 0.75:
                        rect = fitz.Rect(page_col.x0, top_y, page_col.x1, cap["bbox"].y0 - 2)
                        chosen = {"kind": "vector-gap", "rect": rect}
            if chosen:
                fname = f"{cap['kind']}-{cap['label'].lower()}-p{pno}.png"
                fpath = fig_dir / fname
                w, h = crop_region(page, chosen["rect"], str(fpath), args.dpi)
                all_figs.append(
                    {
                        "file": fname,
                        "page": pno,
                        "caption": cap["caption"],
                        "label": cap["label"],
                        "kind": cap["kind"],
                        "source": chosen["kind"],
                        "rect": [round(v, 1) for v in chosen["rect"]],
                        "size": [w, h],
                    }
                )
            all_caps.append(
                {
                    "page": pno,
                    "label": cap["label"],
                    "kind": cap["kind"],
                    "caption": cap["caption"],
                    "matched_figure": bool(chosen) if not args.skip_figures else None,
                }
            )

    (out / "fulltext.md").write_text("\n\n".join(md_pages), encoding="utf-8")
    (out / "sections.json").write_text(json.dumps(all_heads, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "figures.json").write_text(json.dumps(all_figs, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        "pdf": str(args.pdf),
        "pages": doc.page_count,
        "sections": len(all_heads),
        "captions": len(all_caps),
        "figures_extracted": len(all_figs),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"输出目录: {out}")
    print(f"题注 {len(all_caps)} 条, 其中成功提取图像 {len(all_figs)} 条 （未匹配的可用 crop 子命令手工补）")


if __name__ == "__main__":
    main()
