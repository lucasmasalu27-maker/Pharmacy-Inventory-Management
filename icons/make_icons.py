"""Regenerate the PNG app icons (pure Python, no dependencies)."""
import struct, zlib, pathlib

GREEN, WHITE = (11, 122, 95), (255, 255, 255)


def icon(size):
    rows = []
    arm, half = size * 0.13, size * 0.30  # cross arm half-width and half-length
    c = size / 2
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = abs(x + 0.5 - c), abs(y + 0.5 - c)
            cross = (dx <= arm and dy <= half) or (dy <= arm and dx <= half)
            row += bytes(WHITE if cross else GREEN)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


here = pathlib.Path(__file__).parent
for s in (192, 512):
    (here / f"icon-{s}.png").write_bytes(icon(s))
