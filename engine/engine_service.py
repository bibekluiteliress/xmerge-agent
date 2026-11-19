"""XMerge engine service: the Word-file side of XMerge Studio.

The TypeScript server (agents, workflow, validator, XWord, XPLAN calls) calls this on 127.0.0.1 with a
shared token. It uses only the standard library.

    POST /docx    {"template": "..."}      -> {"docx_b64"}          (the template packed as a Word document)
    POST /scan    {"file_b64", "format"}   -> {"errors", "note"}    (Err markers in a report merged by XPLAN)

There is no preview here: templates are tested with Run in XPLAN on a test client.
"""

import argparse
import base64
import http.server
import json
import logging
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
AI = os.environ.get("XMS_AI_DOCS", os.path.join(REPO, "docs", "markdown", "xmerge", "ai"))
MAX_BODY = 48 * 1024 * 1024  # a merged report, base64, can be tens of MB

sys.path.insert(0, os.path.join(AI, "demo"))
import staging_render  # noqa: E402  (docx packing and the Err scan; standard library only)

log = logging.getLogger("xms-engine")


def docx(body):
    text = str(body.get("template", ""))
    lines = text.replace("\r\n", "\n").rstrip("\n").split("\n")
    return {"docx_b64": base64.b64encode(staging_render.build_docx(lines)).decode("ascii")}


def scan(body):
    data = base64.b64decode(str(body.get("file_b64", "")))
    if body.get("format") == "pdf":
        return {"errors": [], "note": "A PDF is not checked for Err markers. Choose Word to check it."}
    errors, note = staging_render.scan_output(data, "doc")
    return {"errors": errors[:50], "note": note}


class Handler(http.server.BaseHTTPRequestHandler):
    token = None
    routes = {"/docx": docx, "/scan": scan}

    def log_message(self, fmt, *args):  # paths only, never bodies
        log.info("%s %s", self.command, self.path)

    def _send(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.headers.get("X-Engine-Token") != self.token:
            return self._send(403, {"error": "forbidden"})
        fn = self.routes.get(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        if not fn:
            return self._send(404, {"error": "no such route"})
        if n > MAX_BODY:
            return self._send(413, {"error": "request too large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            return self._send(200, fn(body))
        except Exception as ex:
            log.exception("engine service failure")
            return self._send(500, {"error": "%s: %s" % (ex.__class__.__name__, ex)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("XMS_ENGINE_PORT", "8766")))
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s engine %(message)s")
    Handler.token = os.environ.get("XMS_ENGINE_TOKEN")
    if not Handler.token:
        sys.exit("Set XMS_ENGINE_TOKEN (run.sh does this).")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print("XMerge engine on http://127.0.0.1:%d" % a.port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
