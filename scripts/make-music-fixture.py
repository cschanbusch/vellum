"""Writes the music test fixture: a tiny SoundFont and three MIDI files, all synthesized here.

    python scripts/make-music-fixture.py [out dir]
    (default: tests/fixtures/dev-plugins/skins/music-test/music)

test.sf2 has three presets: 0 "Saw Lead" and 1 "Soft Pad" (bank 0), and a drum kit (bank 128)
with a kick on 36, a snare on 38 and a hat on 42. The MIDI files are 120 bpm in 4/4, with the
lead on channel 0, the pad on 1 and drums on 9 (the convention scenes share, so layers carry over):
title.mid and garage.mid (4 bars each, in different keys) and sting.mid (one bar).
"""

import math
import random
import struct
import sys
from pathlib import Path

SR = 44100


def pcm(samples):
    return b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples)


def chunk(cid, data):
    pad = b"\0" if len(data) % 2 else b""
    return cid + struct.pack("<I", len(data)) + data + pad


def riff_list(kind, *chunks):
    data = kind + b"".join(chunks)
    return b"LIST" + struct.pack("<I", len(data)) + data


def name20(s):
    return s.encode("ascii")[:19].ljust(20, b"\0")


def soundfont():
    random.seed(7)
    period = 100  # 441 Hz at 44.1 kHz: A4 a little sharp, close enough for a test
    cycles = 40
    saw = [((i % period) / period) * 2 - 1 for i in range(period * cycles)]
    sine = [math.sin(2 * math.pi * i / period) * 0.8 for i in range(period * cycles)]
    kick = [math.sin(2 * math.pi * (55 + 90 * math.exp(-i / 900)) * i / SR) * math.exp(-i / 6000) for i in range(int(SR * 0.3))]
    snare = [(random.uniform(-1, 1) * 0.7 + math.sin(2 * math.pi * 190 * i / SR) * 0.3) * math.exp(-i / 2600) for i in range(int(SR * 0.22))]
    hat = []
    last = 0.0
    for i in range(int(SR * 0.06)):
        n = random.uniform(-1, 1)
        hat.append((n - last) * 0.6 * math.exp(-i / 700))
        last = n
    samples = [("saw", saw, True), ("sine", sine, True), ("kick", kick, False), ("snare", snare, False), ("hat", hat, False)]

    smpl = b""
    headers = []
    pos = 0
    for name, data, loop in samples:
        start = pos
        smpl += pcm(data) + b"\0\0" * 46
        end = start + len(data)
        headers.append((name, start, end, start + period * 2 if loop else start, end - period * 2 if loop else end))
        pos = end + 46

    # Instruments: zones of (generator list). sampleID (53) must come last in each zone.
    # 43 keyRange, 54 sampleModes, 58 overridingRootKey, 34 attackVolEnv, 38 releaseVolEnv,
    # 36 sustainVolEnv (centibels of attenuation), 48 initialAttenuation.
    def key_range(lo, hi):
        return (43, lo | (hi << 8))

    instruments = [
        ("Saw", [[key_range(0, 127), (54, 1), (58, 69), (34, -7973 + 3000), (38, -1200), (48, 60), (53, 0)]]),
        ("Pad", [[key_range(0, 127), (54, 1), (58, 69), (34, 0), (38, 600), (48, 40), (53, 1)]]),
        (
            "Kit",
            [
                [key_range(36, 36), (58, 36), (38, -1200), (53, 2)],
                [key_range(38, 38), (58, 38), (38, -1200), (53, 3)],
                [key_range(42, 42), (58, 42), (38, -2400), (48, 30), (53, 4)],
            ],
        ),
    ]
    presets = [("Saw Lead", 0, 0, 0), ("Soft Pad", 1, 0, 1), ("Standard", 0, 128, 2)]

    inst = b""
    ibag = b""
    igen = b""
    gen_i = 0
    bag_i = 0
    for name, zones in instruments:
        inst += name20(name) + struct.pack("<H", bag_i)
        for zone in zones:
            ibag += struct.pack("<HH", gen_i, 0)
            for oper, amount in zone:
                igen += struct.pack("<Hh", oper, amount) if amount < 0 else struct.pack("<HH", oper, amount)
                gen_i += 1
            bag_i += 1
    inst += name20("EOI") + struct.pack("<H", bag_i)
    ibag += struct.pack("<HH", gen_i, 0)
    igen += struct.pack("<HH", 0, 0)
    imod = b"\0" * 10

    phdr = b""
    pbag = b""
    pgen = b""
    for i, (name, program, bank, instrument) in enumerate(presets):
        phdr += name20(name) + struct.pack("<HHHIII", program, bank, i, 0, 0, 0)
        pbag += struct.pack("<HH", i, 0)
        pgen += struct.pack("<HH", 41, instrument)
    phdr += name20("EOP") + struct.pack("<HHHIII", 0, 0, len(presets), 0, 0, 0)
    pbag += struct.pack("<HH", len(presets), 0)
    pgen += struct.pack("<HH", 0, 0)
    pmod = b"\0" * 10

    shdr = b""
    for name, start, end, ls, le in headers:
        root = {"saw": 69, "sine": 69, "kick": 36, "snare": 38, "hat": 42}[name]
        shdr += name20(name) + struct.pack("<IIIIIBbHH", start, end, ls, le, SR, root, 0, 0, 1)
    shdr += name20("EOS") + struct.pack("<IIIIIBbHH", 0, 0, 0, 0, 0, 0, 0, 0, 0)

    info = riff_list(b"INFO", chunk(b"ifil", struct.pack("<HH", 2, 1)), chunk(b"isng", b"EMU8000\0"), chunk(b"INAM", b"Vellum music test\0"))
    sdta = riff_list(b"sdta", chunk(b"smpl", smpl))
    pdta = riff_list(
        b"pdta",
        chunk(b"phdr", phdr),
        chunk(b"pbag", pbag),
        chunk(b"pmod", pmod),
        chunk(b"pgen", pgen),
        chunk(b"inst", inst),
        chunk(b"ibag", ibag),
        chunk(b"imod", imod),
        chunk(b"igen", igen),
        chunk(b"shdr", shdr),
    )
    body = b"sfbk" + info + sdta + pdta
    return b"RIFF" + struct.pack("<I", len(body)) + body


# ---- MIDI ----------------------------------------------------------------------------------

PPQ = 480


def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def track(events):
    """events: (tick, bytes) in any order; returns an MTrk chunk ending at the last tick."""
    events = sorted(events, key=lambda e: (e[0], 0 if e[1][0] & 0xF0 == 0x80 else 1))
    data = b""
    now = 0
    for tick, msg in events:
        data += vlq(tick - now) + msg
        now = tick
    data += vlq(0) + b"\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(data)) + data


def note(events, ch, key, start_beat, beats, vel=100):
    on = int(start_beat * PPQ)
    off = int((start_beat + beats) * PPQ) - 1
    events.append((on, bytes([0x90 | ch, key, vel])))
    events.append((off, bytes([0x80 | ch, key, 0])))


def song(root, bars=4, sting=False):
    ev = []
    beats = bars * 4
    # Tempo 120 bpm (500000 us per quarter), 4/4.
    ev.append((0, b"\xff\x51\x03" + (500000).to_bytes(3, "big")))
    ev.append((0, b"\xff\x58\x04\x04\x02\x18\x08"))
    ev.append((0, bytes([0xC0, 0])))  # lead: Saw Lead
    ev.append((0, bytes([0xC1, 1])))  # pad: Soft Pad
    ev.append((0, bytes([0xB9, 0, 1])))  # drums use channel 9's kit
    if sting:
        for i, k in enumerate([0, 4, 7, 12]):
            note(ev, 0, root + 12 + k, i * 0.5, 0.45, 110)
    else:
        scale = [0, 2, 4, 7, 9, 12, 9, 7]
        for b in range(beats * 2):
            note(ev, 0, root + 12 + scale[b % len(scale)], b * 0.5, 0.45, 96)
        for bar in range(bars):
            chord = [0, 4, 7] if bar % 2 == 0 else [5, 9, 12]
            for k in chord:
                note(ev, 1, root + k, bar * 4, 3.9, 70)
            for beat in range(4):
                at = bar * 4 + beat
                note(ev, 9, 36 if beat % 2 == 0 else 38, at, 0.25, 110)
                note(ev, 9, 42, at + 0.5, 0.2, 70)
    # End of the song: exactly on the bar line.
    end_tick = (1 if sting else bars) * 4 * PPQ
    t = track(ev)
    # Move End of Track to the bar line: rebuild with a final no-op delay.
    data = t[8:-4]
    last_tick = max(e[0] for e in ev)
    data += vlq(end_tick - last_tick) + b"\xff\x2f\x00"
    mtrk = b"MTrk" + struct.pack(">I", len(data)) + data
    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, PPQ)
    return header + mtrk


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/dev-plugins/skins/music-test/music")
    out.mkdir(parents=True, exist_ok=True)
    (out / "test.sf2").write_bytes(soundfont())
    (out / "title.mid").write_bytes(song(57))  # A minor-ish
    (out / "garage.mid").write_bytes(song(60))  # C
    (out / "sting.mid").write_bytes(song(64, sting=True))
    for f in sorted(out.iterdir()):
        print(f, f.stat().st_size, "bytes")


main()
