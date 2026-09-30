#!/usr/bin/env python3
"""One-time Stalwart v0.16 bootstrap over the loopback JMAP endpoint."""

import base64
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


ROOT = pathlib.Path("/opt/stalwart")
SECRET = ROOT / "secrets/recovery.env"
RESULT = ROOT / "secrets/bootstrap-response.json"
BASE = "http://127.0.0.1:18080"


def auth_header():
    credential_line = SECRET.read_text().strip()
    assert credential_line.startswith("STALWART_RECOVERY_ADMIN=admin:")
    credential = credential_line.split("=", 1)[1]
    return "Basic " + base64.b64encode(credential.encode()).decode()


def call(method, arguments):
    payload = {
        "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
        "methodCalls": [[method, arguments, "bootstrap"]],
    }
    request = urllib.request.Request(
        BASE + "/jmap",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": auth_header(),
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}") from None


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "inspect"
    if mode == "inspect":
        request = urllib.request.Request(BASE + "/.well-known/jmap", headers={"Authorization": auth_header()})
        try:
            with urllib.request.urlopen(request, timeout=20) as result:
                session = json.load(result)
            print("session keys:", sorted(session.keys()))
            print("apiUrl:", session.get("apiUrl"))
        except urllib.error.HTTPError as error:
            print("session HTTP:", error.code)
        response = call("x:Bootstrap/get", {"ids": ["singleton"]})
        for name, body, _ in response.get("methodResponses", []):
            print("method:", name)
            print("fields:", sorted(body.get("list", [{}])[0].keys()) if body.get("list") else [])
            print("error:", body.get("type", "none"))
        return
    if mode != "apply":
        raise SystemExit("Use inspect or apply")
    if (ROOT / "config/config.json").exists() or RESULT.exists():
        raise SystemExit("Bootstrap already applied or result file exists")
    response = call(
        "x:Bootstrap/set",
        {
            "update": {
                "singleton": {
                    "serverHostname": "mail.igoutbound.com",
                    "defaultDomain": "igoutbound.com",
                    "requestTlsCertificate": False,
                    "generateDkimKeys": False,
                    "directory": {"@type": "Internal"},
                    "dnsServer": {"@type": "Manual"},
                    "tracer": {"@type": "Stdout"},
                }
            }
        },
    )
    descriptor = os.open(RESULT, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(response, file)
    for name, body, _ in response.get("methodResponses", []):
        print("method:", name)
        print("updated:", bool(body.get("updated")))
        print("error:", body.get("type", "none"))
        print("notUpdated types:", [item.get("type") for item in body.get("notUpdated", {}).values()])


if __name__ == "__main__":
    main()
