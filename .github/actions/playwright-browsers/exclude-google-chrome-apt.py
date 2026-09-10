"""Exclude the unrelated Chrome repository from Playwright's apt dependency install."""
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit


def chrome_uri(value):
    try:
        uri = urlsplit(value)
        return (
            uri.scheme in ("http", "https")
            and uri.netloc == "dl.google.com"
            and uri.path in ("/linux/chrome/deb", "/linux/chrome/deb/",
                             "/linux/chrome-stable/deb", "/linux/chrome-stable/deb/")
            and not uri.query
            and not uri.fragment
        )
    except ValueError:
        return False


def list_source(text):
    pattern = re.compile(r"^\s*deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?(\S+)")
    return "".join(
        "# Disabled for Playwright dependency install: " + line
        if (match := pattern.match(line)) and chrome_uri(match.group(1))
        else line
        for line in text.splitlines(keepends=True)
    )


def sources_stanza(stanza):
    lines = stanza.splitlines(keepends=True)
    fields = []
    for index, line in enumerate(lines):
        match = re.match(r"^([A-Za-z][A-Za-z0-9-]*):", line)
        if match:
            fields.append((match.group(1).lower(), index))
    for pos, (name, start) in enumerate(fields):
        if name != "uris":
            continue
        end = fields[pos + 1][1] if pos + 1 < len(fields) else len(lines)
        # Comments are not field values. Retain them byte-for-byte.
        values = []
        for index in range(start, end):
            line = lines[index]
            if line.lstrip().startswith("#"):
                continue
            content = line.split(":", 1)[1] if index == start else line
            values.extend(content.split())
        retained = [value for value in values if not chrome_uri(value)]
        if len(retained) == len(values):
            continue
        if not retained:
            # Disable just this stanza, preserving all its configuration.
            return "".join("# Disabled for Playwright: " + line if line.strip() else line for line in lines)
        result = lines[:start]
        newline = "\r\n" if lines[start].endswith("\r\n") else "\n"
        result.append(lines[start].split(":", 1)[0] + ": " + " ".join(retained) + newline)
        result.extend(line for line in lines[start + 1:end] if line.lstrip().startswith("#"))
        result.extend(lines[end:])
        return "".join(result)
    return stanza


def sources_file(text):
    return "".join(
        part if re.fullmatch(r"(?:[ \t]*\r?\n){2,}", part) else sources_stanza(part)
        for part in re.split(r"((?:[ \t]*\r?\n){2,})", text)
    )


def main(root):
    paths = [root / "sources.list", *sorted((root / "sources.list.d").glob("*.list")),
             *sorted((root / "sources.list.d").glob("*.sources"))]
    for path in paths:
        if not path.is_file():
            continue
        with path.open(newline="") as source:
            original = source.read()
        updated = sources_file(original) if path.suffix == ".sources" else list_source(original)
        if updated != original:
            with path.open("w", newline="") as source:
                source.write(updated)
            print("Excluded Google Chrome apt source:", path.name)


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/etc/apt"))
