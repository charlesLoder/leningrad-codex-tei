"""Show one batch result.jsonl file in a form a human can read.

A result.jsonl file holds one JSON object per line:
{"key": "<folio>", "response": {...}} or {"key": "<folio>", "error": {...}}.

The problem: response parts mix code, tool output, base64 images, and
final text. The base64 images make the raw file unreadable (many MB).
This script prints a short summary per folio and never prints base64
unless --save-images writes image bytes to files.

Usage:
    python3 view_result.py data/alignments/batch/<ts>/result.jsonl
    python3 view_result.py <result.jsonl> --folio 031B --save-images /tmp/imgs
    python3 view_result.py <result.jsonl> --text-only
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

CB_RE = re.compile(r'<cb\s+n="(\d+)"\s*/>')
LB_RE = re.compile(r'<lb\s+n="(\d+)"\s*/>')

CODE_PREVIEW_LINES = 12

# Batch rates, USD per 1M tokens, Global, Gemini 3.8 Flash
# through 2026-12-31 (Flex/Batch table). Output price covers
# response + thinking tokens. Used only for a cost estimate.
BATCH_RATES = {"input": 0.375, "cached": 0.0375, "output": 1.875}
BATCH_RATES_LABEL = "gemini-3.8-flash batch global"


def _num(value: object) -> int | None:
    return value if isinstance(value, int) else None


def _details_str(details: object) -> str:
    if not isinstance(details, list) or not details:
        return ""
    parts = []
    for d in details:
        if isinstance(d, dict) and "modality" in d and "tokenCount" in d:
            parts.append(f"{d['modality']}={d['tokenCount']}")
    return " ".join(parts)


def _estimate_cost(usage: dict) -> str:
    prompt = _num(usage.get("promptTokenCount"))
    tool = _num(usage.get("toolUsePromptTokenCount"))
    cached = _num(usage.get("cachedContentTokenCount"))
    cands = _num(usage.get("candidatesTokenCount"))
    thoughts = _num(usage.get("thoughtsTokenCount")) or 0
    if prompt is None or cands is None:
        return ""
    tool = tool or 0
    cached = cached or 0
    uncached = max(0, prompt + tool - cached)
    cost = (
        uncached * BATCH_RATES["input"]
        + cached * BATCH_RATES["cached"]
        + (cands + thoughts) * BATCH_RATES["output"]
    ) / 1_000_000
    return f"${cost:.4f}"


def usage_lines(usage: dict) -> list[str]:
    """Full token breakdown: tool use, cache, thinking, image split, cost."""
    if not usage:
        return ["  tokens: (no usageMetadata)"]
    total = usage.get("totalTokenCount", "?")
    prompt = usage.get("promptTokenCount", "?")
    cands = usage.get("candidatesTokenCount", "?")
    tool = usage.get("toolUsePromptTokenCount", "?")
    cached = usage.get("cachedContentTokenCount", "?")
    thoughts = usage.get("thoughtsTokenCount", "?")
    lines = [
        f"  tokens: total={total} prompt={prompt} tool={tool} "
        f"out={cands} cached={cached} thoughts={thoughts}"
    ]
    for label, key in (
        ("prompt", "promptTokensDetails"),
        ("tool", "toolUsePromptTokensDetails"),
        ("cache", "cacheTokensDetails"),
    ):
        text = _details_str(usage.get(key))
        if text:
            lines.append(f"  tokens-{label}: {text}")
    cost = _estimate_cost(usage) if isinstance(usage, dict) else ""
    if cost:
        lines.append(f"  est. cost ({BATCH_RATES_LABEL}): {cost}")
    return lines


def b64_bytes(s: str) -> int:
    """Size of decoded base64 without keeping decoded bytes."""
    n = len(s.strip())
    pad = s.count("=") if s.endswith("=") else 0
    return max(0, n * 3 // 4 - pad)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("result", type=Path, help="Path to result.jsonl")
    p.add_argument("--folio", default=None, help="Show only this folio key (e.g. 031B)")
    p.add_argument(
        "--save-images",
        type=Path,
        default=None,
        metavar="DIR",
        help="Write model images to DIR as <folio>-<n>.<ext>",
    )
    p.add_argument(
        "--full-code",
        action="store_true",
        help="Show full code blocks, not first lines",
    )
    p.add_argument(
        "--text-only",
        action="store_true",
        help="Show only the final text part per folio",
    )
    return p.parse_args(argv)


def render_final_text(text: str) -> list[str]:
    """Render final TEI text as one line per column/line: 'c1 l5: words'."""
    out: list[str] = []
    col = "?"
    line = "?"
    buf: list[str] = []

    def flush() -> None:
        if buf or line != "?":
            out.append(f"c{col} l{line}: {' '.join(buf) if buf else '(blank)'}")
            buf.clear()

    for raw in text.splitlines():
        s = raw.strip()
        m = CB_RE.fullmatch(s)
        if m:
            flush()
            col = m.group(1)
            line = "?"
            buf.clear()
            # A cb with no lb yet: do not emit until first lb arrives.
            line = "?"
            # Mark pending so flush does not emit empty line before first lb.
            buf.clear()
            out.append(f"--- column {col} ---")
            continue
        m = LB_RE.fullmatch(s)
        if m:
            # Skip flush on the very first lb of a column (nothing to flush).
            if line != "?" or buf:
                flush()
            line = m.group(1)
            continue
        if s:
            buf.append(s)
    flush()
    return out


def show_part(
    part: dict,
    idx: int,
    args: argparse.Namespace,
    img_counter: list[int],
    folio: str,
    saved: list[Path],
) -> list[str]:
    out: list[str] = []
    if "text" in part:
        t = part["text"]
        if args.text_only:
            out.append(t.rstrip() or "(empty text)")
        else:
            out.append(f"[step {idx}] final text ({len(t)} chars):")
            for rl in render_final_text(t):
                out.append(f"  {rl}")
        return out
    if "executableCode" in part:
        code = part["executableCode"].get("code", "")
        lang = part["executableCode"].get("language", "?")
        lines = code.splitlines()
        out.append(f"[step {idx}] run {lang} ({len(lines)} lines):")
        show = lines if args.full_code else lines[:CODE_PREVIEW_LINES]
        out.extend(f"    {ln}" for ln in show)
        if not args.full_code and len(lines) > CODE_PREVIEW_LINES:
            out.append(
                f"    ... ({len(lines) - CODE_PREVIEW_LINES} more, use --full-code)"
            )
        return out
    if "codeExecutionResult" in part:
        r = part["codeExecutionResult"]
        outcome = r.get("outcome", "?")
        output = (r.get("output", "") or "").rstrip()
        out.append(f"[step {idx}] tool -> {outcome}")
        if output:
            for ln in output.splitlines()[:10]:
                out.append(f"    {ln}")
        return out
    if "inlineData" in part:
        mime = part["inlineData"].get("mimeType", "?")
        data = part["inlineData"].get("data", "")
        kb = b64_bytes(data) / 1024
        n = img_counter[0]
        img_counter[0] += 1
        msg = f"[step {idx}] image {n}: {mime}, ~{kb:.0f} KB (not shown)"
        if args.save_images:
            ext = "jpg" if "jpeg" in mime else mime.split("/")[-1].split("+")[0]
            dest = args.save_images / f"{folio}-{n}.{ext}"
            try:
                dest.write_bytes(base64.b64decode(data))
                saved.append(dest)
                msg += f" -> {dest}"
            except Exception as exc:  # noqa: BLE001 - report, keep going
                msg += f" (save failed: {exc})"
        out.append(msg)
        return out
    keys = ",".join(part.keys())
    out.append(f"[step {idx}] other part ({keys})")
    return out


def show_line(obj: dict, args: argparse.Namespace, saved: list[Path]) -> list[str]:
    out: list[str] = []
    key = obj.get("key", "?")
    if obj.get("error"):
        out.append(f"== {key}: API ERROR ==")
        out.append(json.dumps(obj["error"], indent=1)[:1000])
        return out
    resp = obj.get("response", {})
    cands = resp.get("candidates", [])
    if not cands:
        out.append(f"== {key}: no candidates (empty response) ==")
        return out
    cand = cands[0]
    finish = cand.get("finishReason", "?")
    parts = cand.get("content", {}).get("parts", [])
    n_code = sum(1 for p in parts if "executableCode" in p)
    n_tool = sum(1 for p in parts if "codeExecutionResult" in p)
    n_img = sum(1 for p in parts if "inlineData" in p)
    n_text = sum(1 for p in parts if "text" in p)
    usage = resp.get("usageMetadata", {})
    model = resp.get("modelVersion", "?")
    out.append(
        f"== {key}: finish={finish} steps={len(parts)} "
        f"(code={n_code} tool={n_tool} img={n_img} text={n_text}) "
        f"model={model} =="
    )
    out.extend(usage_lines(usage))
    if args.text_only:
        for i, p in enumerate(parts):
            if "text" in p:
                out.extend(show_part(p, i, args, [0], key, saved))
        return out
    img_counter = [0]
    for i, p in enumerate(parts):
        # Skip thought signatures: they carry no readable info.
        p = {k: v for k, v in p.items() if k != "thoughtSignature"}
        out.extend(show_part(p, i, args, img_counter, key, saved))
    return out


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if not args.result.is_file():
        print(f"No file: {args.result}", file=sys.stderr)
        return 2
    if args.save_images:
        args.save_images.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    n_ok = n_err = 0
    with args.result.open(encoding="utf-8") as f:
        for ln_no, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"-- line {ln_no}: bad JSON ({exc})")
                n_err += 1
                continue
            key = obj.get("key") if isinstance(obj, dict) else None
            if not key:
                print(f"-- line {ln_no}: no key, skip")
                n_err += 1
                continue
            if args.folio and key != args.folio:
                continue
            if obj.get("error"):
                n_err += 1
            else:
                n_ok += 1
            for ln in show_line(obj, args, saved):
                print(ln)
            print()
    print(f"Done: {n_ok} ok, {n_err} error.")
    if saved:
        print(f"Saved {len(saved)} images to {args.save_images}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
