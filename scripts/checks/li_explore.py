#!/usr/bin/env python3
"""Ad-hoc exploration of the LinkedIn export in data/input.

Prints summary statistics (posting cadence, comment ratios, connection growth,
message direction) used as audit/insight evidence. Reads your private export
from data/input (never committed) and skips cleanly when it is absent.

"Me" detection for message direction uses $LIA_ME, falling back to git
`user.name`, so no personal name is hardcoded.

Usage (prefer the Makefile):  make explore
"""

import csv
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path


def _raise_csv_field_limit() -> None:
    """Lift csv's field size cap, backing off until the platform accepts the value."""
    limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(limit)
            return
        except OverflowError:
            limit //= 10


_raise_csv_field_limit()

BASE = Path(__file__).resolve().parents[2] / "data" / "input"
FILES = ["Shares.csv", "Comments.csv", "Connections.csv", "messages.csv"]


def detect_me() -> str:
    """Return the export owner's display name from $LIA_ME or git user.name."""
    env = os.environ.get("LIA_ME")
    if env:
        return env
    try:
        return subprocess.run(
            ["git", "config", "user.name"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def month(s: str) -> str | None:
    """Return the YYYY-MM prefix of a date string, or None when too short."""
    return s[:7] if s and len(s) >= 7 else None


def conn_month(r: dict[str, str]) -> str | None:
    """Return the YYYY-MM a connection was made, or None when unparseable."""
    d = r.get("Connected On")
    if not d:
        return None
    try:
        return datetime.strptime(d, "%d %b %Y").strftime("%Y-%m")
    except ValueError:
        return None


def _read_rows(name: str) -> list[dict[str, str]]:
    """Read one export file into rows keyed by its header."""
    with (BASE / name).open(encoding="utf-8", errors="replace") as f:
        return list(csv.DictReader(f))


def report_shares() -> Counter[str]:
    """Print the posting summary and return the number of posts per month."""
    shares = _read_rows("Shares.csv")
    s_months = Counter(m for r in shares if (m := month(r.get("Date") or "")))
    hashtags: Counter[str] = Counter()
    lengths: list[int] = []
    vis: Counter[str] = Counter()
    media = 0
    for r in shares:
        t = r.get("ShareCommentary") or ""
        hashtags.update(h.lower() for h in re.findall(r"#(\w+)", t))
        lengths.append(len(t))
        vis[r.get("Visibility") or "?"] += 1
        if r.get("MediaUrl"):
            media += 1
    dates = sorted(r["Date"] for r in shares if r.get("Date"))
    print("=== SHARES ===")
    print(f"posts={len(shares)} range={dates[0][:10]}..{dates[-1][:10]}")
    print(
        f"avg_len={sum(lengths) // max(len(lengths), 1)} with_media={media} visibility={dict(vis)}"
    )
    print("top_hashtags:", hashtags.most_common(10))
    print("busiest_months:", s_months.most_common(6))
    print("last_6_months:", sorted(s_months.items())[-6:])
    return s_months


def report_comments(s_months: Counter[str]) -> None:
    """Print the comment summary, including the monthly comment-to-post ratio."""
    comments = _read_rows("Comments.csv")
    c_months = Counter(m for r in comments if (m := month(r.get("Date") or "")))
    urns = Counter(r.get("Link") for r in comments if r.get("Link"))
    print("\n=== COMMENTS ===")
    print(f"comments={len(comments)} distinct_posts_commented={len(urns)}")
    print("last_6_months:", sorted(c_months.items())[-6:])
    print(f"max_comments_on_one_post={urns.most_common(1)[0][1] if urns else 0}")

    # comment-to-post ratio per month (engagement style)
    print(
        "comment_per_post_ratio(last 6m):",
        [(m, round(c_months.get(m, 0) / s, 1)) for m, s in sorted(s_months.items())[-6:]],
    )


def _read_connections() -> list[dict[str, str]]:
    """Read Connections.csv, skipping the notes LinkedIn writes above the header."""
    with (BASE / "Connections.csv").open(encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    hdr = next(i for i, ln in enumerate(lines) if ln.startswith("First Name"))
    return list(csv.DictReader(lines[hdr:]))


def report_connections() -> None:
    """Print the connection summary: contact details, companies, and growth."""
    conns = _read_connections()
    g_months = Counter(m for r in conns if (m := conn_month(r)))
    emails = sum(1 for r in conns if (r.get("Email Address") or "").strip())
    print("\n=== CONNECTIONS ===")
    print(
        f"connections={len(conns)} email_visible={emails} ({100 * emails // max(len(conns), 1)}%)"
    )
    companies: Counter[str] = Counter()
    positions: Counter[str] = Counter()
    for connection in conns:
        company = (connection.get("Company") or "").strip()
        position = (connection.get("Position") or "").strip()
        if company:
            companies[company] += 1
        if position:
            positions[position] += 1
    print("top_companies:", companies.most_common(8))
    print("top_positions:", positions.most_common(8))
    print("growth_last_8_months:", sorted(g_months.items())[-8:])
    print("peak_growth_months:", g_months.most_common(5))


def report_messages(me: str) -> None:
    """Print the message summary: direction, contacts, and who started each conversation."""
    sent = recv = 0
    m_months: Counter[str | None] = Counter()
    contacts_sent: Counter[str] = Counter()
    contacts_recv: Counter[str] = Counter()
    convs: set[str] = set()
    folders: Counter[str] = Counter()
    first_dir: dict[str, str] = {}
    # The file is reverse chronological, so the last row seen is the earliest message.
    with (BASE / "messages.csv").open(encoding="utf-8", errors="replace") as f:
        for r in csv.DictReader(f):
            convs.add(r["CONVERSATION ID"])
            frm = (r.get("FROM") or "").strip()
            to = (r.get("TO") or "").strip()
            m_months[month(r.get("DATE") or "")] += 1
            folders[r.get("FOLDER") or "?"] += 1
            if frm == me:
                sent += 1
                if to and "," not in to:
                    contacts_sent[to] += 1
            else:
                recv += 1
                if frm:
                    contacts_recv[frm] += 1
            first_dir[r["CONVERSATION ID"]] = frm  # last row seen per conv = earliest msg
    initiated_by_me = sum(1 for v in first_dir.values() if v == me)
    print("\n=== MESSAGES ===")
    print(f"me={me!r} messages={sent + recv} sent={sent} recv={recv} conversations={len(convs)}")
    print(f"conversations_initiated_by_me={initiated_by_me}/{len(first_dir)}")
    print("folders:", dict(folders))
    print("top_inbound_contacts:", contacts_recv.most_common(6))
    print("top_outbound_contacts:", contacts_sent.most_common(6))
    print("volume_last_8_months:", sorted((k, v) for k, v in m_months.items() if k)[-8:])

    # one-way: people I messaged who never replied, and inbound I never answered
    ghosts = sum(1 for c in contacts_sent if contacts_recv.get(c, 0) == 0)
    fans = sum(1 for c in contacts_recv if contacts_sent.get(c, 0) == 0)
    print(f"messaged_but_no_reply={ghosts} inbound_never_replied_by_me={fans}")


def main() -> int:
    """Print every section of the report, or skip when there is no local export."""
    me = detect_me()
    missing = [name for name in FILES if not (BASE / name).exists()]
    if missing:
        print(f"SKIP: no local export in data/input (missing: {', '.join(missing)}).")
        return 0

    s_months = report_shares()
    report_comments(s_months)
    report_connections()
    report_messages(me)
    return 0


if __name__ == "__main__":
    sys.exit(main())
