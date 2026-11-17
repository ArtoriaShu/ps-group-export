"""Build the standalone CEP installer archive from the current source tree."""
import hashlib
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
EXT = "com.shu.groupexport"

def build():
    version = ET.parse(ROOT / EXT / "CSXS/manifest.xml").getroot().attrib["ExtensionBundleVersion"]
    name = "ps-group-export-" + version
    target = ROOT / "dist" / (name + ".zip")
    target.parent.mkdir(exist_ok=True)
    files = sorted(p for p in (ROOT / EXT).rglob("*") if p.is_file() and not p.name.startswith("."))
    files += [ROOT / p for p in ("README.md", "install.bat", "install.ps1", "uninstall.bat", "uninstall.ps1", "install-mac.command", "uninstall-mac.command")]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            data = file.read_bytes()
            if file.suffix == ".bat":
                data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            info = zipfile.ZipInfo(name + "/" + file.relative_to(ROOT).as_posix())
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if file.suffix == ".command" else 0o100644) << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert name + "/" + EXT + "/host/host.jsx" in archive.namelist()
    print(target)
    print("SHA-256:", hashlib.sha256(target.read_bytes()).hexdigest())
    print("Bytes:", target.stat().st_size)

if __name__ == "__main__":
    build()
