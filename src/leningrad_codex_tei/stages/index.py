"""build-index stage: emit a minimal index over the generated folio TEI files."""

from __future__ import annotations

from pathlib import Path

from lxml import etree


def _local(el: etree._Element) -> str:
    return el.tag.rsplit("}", 1)[-1] if isinstance(el.tag, str) else ""


def build_index(output_dir: Path) -> str:
    """Scan ``output_dir/*.xml`` (excluding index.xml) and produce the index."""
    root = etree.Element("index")
    for path in sorted(output_dir.glob("*.xml")):
        if path.stem == "index":
            continue
        tree = etree.parse(str(path))
        root_element = tree.getroot()
        folio: str = path.stem
        pb = next((el for el in root_element.iter() if _local(el) == "pb"), None)
        if pb is not None:
            n = pb.get("n")
            if n:
                folio = n
        title = next((el.text or "" for el in root_element.iter() if _local(el) == "title" and el.text), "folio")
        entry = etree.SubElement(root, "entry")
        entry.set("folio", folio)
        entry.set("href", path.name)
        title_el = etree.SubElement(entry, "title")
        title_el.text = title
    return etree.tostring(root, pretty_print=True, encoding="unicode")