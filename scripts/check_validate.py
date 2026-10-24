"""Fails CI on any `claude plugin validate --json` finding except the one this repo accepts.

Accepted:
- the warning that a root CLAUDE.md is not loaded as plugin context: it is the
  contributor guide, not context for users.
"""

import json
import sys

ACCEPTED = (
    "CLAUDE.md at the plugin root is not loaded as project context",
)


def reports(report):
    yield report["manifest"]
    yield from report.get("contents", [])


def main(path):
    with open(path) as f:
        report = json.load(f)
    problems = []
    for part in reports(report):
        for kind in ("errors", "warnings"):
            for finding in part.get(kind, []):
                if not finding["message"].startswith(ACCEPTED):
                    problems.append(f"{part['file']}: {kind[:-1]} at {finding['path']}: {finding['message']}")
    for part in reports(report):
        for note in part.get("notes", []):
            print(f"note: {note}")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print("validate: only the accepted findings")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
