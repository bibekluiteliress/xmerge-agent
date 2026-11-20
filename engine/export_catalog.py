"""Export the stock field catalog and field policy for the TypeScript server.

    python3 -I engine/export_catalog.py      # writes server/data/catalog.json

Re-run it after the catalog in the XMerge AI docs (ai/dev/) is regenerated. The data comes from the
same builder the earlier Python Studio used (tools/build_narrative_prototype.py), so it is identical.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# The XMerge AI docs: a copy in ai/ next to this app, or XMS_AI_DOCS (docs/markdown/xmerge/ai in the xplan repo).
AI = os.environ.get("XMS_AI_DOCS", os.path.join(HERE, "..", "ai"))
sys.path.insert(0, os.path.join(AI, "tools"))
import build_narrative_prototype as proto  # noqa: E402



def main():
    data = proto.data()
    out = os.path.join(HERE, "..", "server", "data", "catalog.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"catalog": data["catalog"], "policy": data["policy"]}, fh, separators=(",", ":"))
    n = sum(len(g) for g in data["catalog"].values())
    print("wrote %s: %d groups, %d fields" % (os.path.normpath(out), len(data["catalog"]), n))


if __name__ == "__main__":
    main()
