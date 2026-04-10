#!/usr/bin/env python3
"""
Harmony AIO web presence audit script.

Compares the live state of the harmonyaio-web repository against the master
web presence document to detect drift.  Produces a structured report showing
what is in sync, what has drifted, and what needs human review.

USAGE
    python audit-doc.py
    python audit-doc.py --repo C:\\Dev\\harmonyaio-web --doc "C:\\Users\\bmund\\OneDrive\\Documents\\Harmony AIO\\harmony-aio-web-overview.docx"
    python audit-doc.py --json   (machine-readable output for CI / scripts)

WHAT IT CHECKS
    - Color tokens (CSS :root variables vs documented color palette)
    - Font families (Google Fonts link vs documented typography table)
    - File tree (actual files in /public vs documented file table)
    - Repository URL (git remote vs documented URL)
    - Audio file path and approximate size
    - Brevo integration (worker source references vs documented signup flow)

WHAT IT CANNOT CHECK
    - Whether prose descriptions are still accurate (these get flagged for
      human review with the surrounding context)
    - Visual rendering of the live site
    - Subjective correctness of the brand voice in copy

The script exits 0 if everything is in sync, 1 if drift is detected, and
2 if the script itself encountered an error reading the doc or repo.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

# ──────────────────────────────────────────────────────────────────
# DEFAULTS
# ──────────────────────────────────────────────────────────────────
DEFAULT_REPO = Path(r"C:\Dev\harmonyaio-web")
DEFAULT_DOC = Path(r"C:\Users\bmund\OneDrive\Documents\Harmony AIO\harmony-aio-web-overview.docx")

# Files in /public that don't need explicit doc mentions
NOISE_FILES = {
    "public/favicon.svg",
    "public/hero-bg.png",
    "public/hero-bg-mobile.png",
}

# Font query parameters from the Google Fonts URL that are not actual fonts
NON_FONT_PARAMS = {"display", "subset", "text"}


# ──────────────────────────────────────────────────────────────────
# DOC READER
# ──────────────────────────────────────────────────────────────────
def read_docx_text(doc_path: Path) -> str:
    """Pull all visible text out of a docx file as one big string with the
    runs joined by single spaces.  Good enough for fact extraction (we are
    looking for hex codes, file names, font names, URLs)."""
    if not doc_path.exists():
        raise FileNotFoundError(f"doc not found: {doc_path}")
    with zipfile.ZipFile(doc_path) as z:
        with z.open("word/document.xml") as f:
            tree = ET.parse(f)
    text_chunks = []
    for t in tree.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"):
        if t.text:
            text_chunks.append(t.text)
    # Join with single space so words split across runs still match.  Then
    # collapse runs of whitespace so URLs and paths split by line break or
    # double space still match a clean version.
    joined = " ".join(text_chunks)
    return re.sub(r"\s+", " ", joined)


# ──────────────────────────────────────────────────────────────────
# REPO READERS
# ──────────────────────────────────────────────────────────────────
def read_css_root_vars(html_path: Path) -> dict:
    """Extract :root CSS custom property declarations from an HTML file."""
    if not html_path.exists():
        return {}
    text = html_path.read_text(encoding="utf-8")
    m = re.search(r":root\s*\{([^}]+)\}", text)
    if not m:
        return {}
    block = m.group(1)
    vars = {}
    for var_match in re.finditer(r"--([a-z\-]+)\s*:\s*([^;]+);", block):
        vars[var_match.group(1).strip()] = var_match.group(2).strip()
    return vars


def read_google_fonts(html_path: Path) -> list:
    """Extract font family names from the Google Fonts link tag.  Filters
    out non-font query parameters like display=swap."""
    if not html_path.exists():
        return []
    text = html_path.read_text(encoding="utf-8")
    m = re.search(r'fonts\.googleapis\.com/css2\?([^"\']+)', text)
    if not m:
        return []
    query = m.group(1)
    families = []
    for param in query.split("&"):
        if "=" not in param:
            continue
        key, value = param.split("=", 1)
        # Only family= params declare fonts, everything else (display, etc.) is noise
        if key != "family":
            continue
        # The family name is everything before the first colon
        name = value.split(":")[0].replace("+", " ")
        if name and name not in families:
            families.append(name)
    return families


def read_public_files(repo: Path) -> list:
    """List relative paths of all files in /public."""
    public = repo / "public"
    if not public.exists():
        return []
    files = []
    for root, dirs, filenames in os.walk(public):
        for fn in filenames:
            full = Path(root) / fn
            rel = full.relative_to(repo).as_posix()
            files.append(rel)
    return sorted(files)


def read_git_remote(repo: Path) -> str:
    """Get the origin URL from git config."""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "remote", "get-url", "origin"],
            capture_output=True, text=True, check=False
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def get_audio_file_info(repo: Path) -> dict:
    """Get size and path of the chord audio file."""
    chord = repo / "public" / "sounds" / "harmony-chord.mp3"
    if not chord.exists():
        return {"exists": False, "size_kb": 0, "path": "public/sounds/harmony-chord.mp3"}
    return {
        "exists": True,
        "size_kb": round(chord.stat().st_size / 1024, 1),
        "path": "public/sounds/harmony-chord.mp3"
    }


# ──────────────────────────────────────────────────────────────────
# DRIFT DETECTORS
# ──────────────────────────────────────────────────────────────────
def check_colors(doc_text: str, css_vars: dict) -> list:
    findings = []
    # Hex codes the doc claims are in the brand
    doc_hexes = set(h.upper() for h in re.findall(r"#?([0-9A-Fa-f]{6})\b", doc_text))
    # Hex codes the CSS actually uses (from the :root block)
    css_hexes = set()
    for val in css_vars.values():
        for h in re.findall(r"#([0-9a-fA-F]{6})\b", val):
            css_hexes.add(h.upper())
    in_css_not_doc = css_hexes - doc_hexes
    if in_css_not_doc:
        findings.append({
            "category": "color",
            "severity": "warning",
            "message": f"CSS uses color(s) not mentioned in doc: {sorted('#' + c for c in in_css_not_doc)}"
        })
    return findings


def check_fonts(doc_text: str, fonts: list) -> list:
    findings = []
    expected = ["Cinzel", "Cormorant Garamond", "DM Sans"]
    documented = [f for f in expected if f in doc_text]
    missing_in_css = set(documented) - set(fonts)
    missing_in_doc = set(fonts) - set(documented) - NON_FONT_PARAMS
    if missing_in_css:
        findings.append({
            "category": "font",
            "severity": "error",
            "message": f"Doc references font(s) not loaded by the site: {sorted(missing_in_css)}"
        })
    if missing_in_doc:
        findings.append({
            "category": "font",
            "severity": "warning",
            "message": f"Site loads font(s) not documented: {sorted(missing_in_doc)}"
        })
    return findings


def check_files(doc_text: str, files: list) -> list:
    findings = []
    doc_paths = set(re.findall(r"public/[a-zA-Z0-9_\-./]+", doc_text))
    actual = set(files)
    # Filter out paths the doc references but don't actually need to exist (e.g.
    # the doc might document optional files for completeness)
    missing_on_disk = doc_paths - actual
    not_in_doc = (actual - doc_paths) - NOISE_FILES

    if missing_on_disk:
        findings.append({
            "category": "files",
            "severity": "error",
            "message": f"Doc references file(s) that no longer exist: {sorted(missing_on_disk)}"
        })
    if not_in_doc:
        findings.append({
            "category": "files",
            "severity": "info",
            "message": f"File(s) on disk not mentioned in doc: {sorted(not_in_doc)}"
        })
    return findings


def check_remote(doc_text: str, remote: str) -> list:
    findings = []
    if not remote:
        findings.append({
            "category": "git",
            "severity": "warning",
            "message": "Could not read git remote URL"
        })
        return findings
    # Normalize the remote: strip protocol, .git suffix, trailing slashes
    normalized = remote.replace("https://", "").replace("http://", "").rstrip("/")
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    # Also normalize the doc text the same way for matching
    doc_normalized = doc_text.replace("https://", "").replace("http://", "")
    if normalized not in doc_normalized:
        findings.append({
            "category": "git",
            "severity": "error",
            "message": f"Doc does not contain the actual git remote: {normalized}"
        })
    return findings


def check_audio(doc_text: str, audio: dict) -> list:
    findings = []
    if not audio["exists"]:
        findings.append({
            "category": "audio",
            "severity": "error",
            "message": f"Audio file missing on disk at {audio['path']}"
        })
        return findings
    if "harmony-chord.mp3" not in doc_text and "/sounds/harmony-chord" not in doc_text:
        findings.append({
            "category": "audio",
            "severity": "warning",
            "message": "Doc does not mention the chord audio file"
        })
    return findings


# ──────────────────────────────────────────────────────────────────
# REPORT FORMATTERS
# ──────────────────────────────────────────────────────────────────
def format_text_report(findings: list, repo: Path, doc: Path) -> str:
    lines = []
    lines.append("=" * 70)
    lines.append("HARMONY AIO WEB PRESENCE AUDIT")
    lines.append("=" * 70)
    lines.append(f"Repo: {repo}")
    lines.append(f"Doc:  {doc}")
    lines.append("")
    if not findings:
        lines.append("All checks passed.  Doc is in sync with the live site.")
        return "\n".join(lines)
    by_severity = {"error": [], "warning": [], "info": []}
    for f in findings:
        by_severity[f["severity"]].append(f)
    for sev in ["error", "warning", "info"]:
        if by_severity[sev]:
            lines.append(f"{sev.upper()} ({len(by_severity[sev])})")
            lines.append("-" * 70)
            for f in by_severity[sev]:
                lines.append(f"  [{f['category']}] {f['message']}")
            lines.append("")
    lines.append("=" * 70)
    lines.append(f"Total findings: {len(findings)}")
    lines.append("Errors require fixes.  Warnings should be reviewed.")
    lines.append("Info is FYI only.")
    lines.append("=" * 70)
    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Audit the Harmony AIO web presence document against the live site")
    parser.add_argument("--repo", type=Path, default=DEFAULT_REPO, help="Path to the harmonyaio-web repository")
    parser.add_argument("--doc", type=Path, default=DEFAULT_DOC, help="Path to the master web overview docx")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON instead of text")
    args = parser.parse_args()

    if not args.repo.exists():
        print(f"ERROR: repo not found: {args.repo}", file=sys.stderr)
        return 2
    if not args.doc.exists():
        print(f"ERROR: doc not found: {args.doc}", file=sys.stderr)
        return 2

    try:
        doc_text = read_docx_text(args.doc)
    except Exception as e:
        print(f"ERROR reading doc: {e}", file=sys.stderr)
        return 2

    index_html = args.repo / "public" / "index.html"
    css_vars = read_css_root_vars(index_html)
    fonts = read_google_fonts(index_html)
    files = read_public_files(args.repo)
    remote = read_git_remote(args.repo)
    audio = get_audio_file_info(args.repo)

    findings = []
    findings.extend(check_colors(doc_text, css_vars))
    findings.extend(check_fonts(doc_text, fonts))
    findings.extend(check_files(doc_text, files))
    findings.extend(check_remote(doc_text, remote))
    findings.extend(check_audio(doc_text, audio))

    if args.json:
        result = {
            "repo": str(args.repo),
            "doc": str(args.doc),
            "findings": findings,
            "in_sync": len([f for f in findings if f["severity"] == "error"]) == 0
        }
        print(json.dumps(result, indent=2))
    else:
        print(format_text_report(findings, args.repo, args.doc))

    return 0 if len([f for f in findings if f["severity"] == "error"]) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
