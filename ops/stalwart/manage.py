#!/usr/bin/env python3
"""Local-only Stalwart v0.16 management helper; never displays credentials."""

import base64
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


ROOT = pathlib.Path("/opt/stalwart")
BASE = "http://127.0.0.1:18080"
CAPABILITIES = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]


def admin_header():
    account = json.loads((ROOT / "secrets/admin.json").read_text())
    credential = f"{account['username']}:{account['secret']}"
    return "Basic " + base64.b64encode(credential.encode()).decode()


def provisioning_header():
    key = "stalwart:provisioning-api-key"
    filename = ROOT / "secrets/values" / hashlib.sha256(key.encode()).hexdigest()
    return "Bearer " + filename.read_text().strip()


def request(path, payload=None, auth=None):
    headers = {"Authorization": auth or admin_header()}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request_obj = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request_obj, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code} at {path}") from None


def call(method, arguments, auth=None):
    response = request("/jmap/", {
        "using": CAPABILITIES,
        "methodCalls": [[method, arguments, "c1"]],
    }, auth=auth)
    result = response["methodResponses"][0]
    if result[0] != method or result[1].get("type"):
        raise RuntimeError(f"JMAP {method} failed: {result[1].get('type', 'unknown')}")
    return result[1]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "session"
    if mode == "session":
        session = request("/.well-known/jmap")
        print("apiUrl:", session.get("apiUrl"))
        print("capabilities:", sorted(session.get("capabilities", {}).keys()))
    elif mode == "inspect":
        for object_type in ("Domain", "NetworkListener", "ApiKey", "Account"):
            result = call(f"x:{object_type}/query", {"filter": {}, "position": 0, "limit": 100})
            print(object_type, "count:", result.get("total"), "ids:", result.get("ids"))
            if object_type in ("Domain", "NetworkListener") and result.get("ids"):
                fetched = call(f"x:{object_type}/get", {"ids": result["ids"]})
                for item in fetched.get("list", []):
                    print(object_type, {key: item.get(key) for key in ("id", "name", "protocol", "port", "bind", "allowRelaying", "isEnabled") if key in item})
            if object_type == "ApiKey" and result.get("ids"):
                fetched = call("x:ApiKey/get", {"ids": result["ids"]})
                for item in fetched.get("list", []):
                    print("ApiKey permissions:", sorted(item.get("permissions", {}).get("permissions", {}).keys()))
        result = call("x:MtaStageRcpt/get", {"ids": ["singleton"]})
        for item in result.get("list", []):
            print("MtaStageRcpt allowRelaying:", item.get("allowRelaying"))
    elif mode == "restrict-relay":
        result = call("x:MtaStageRcpt/set", {"update": {"singleton": {"allowRelaying": {"else": "false"}}}})
        if "singleton" not in result.get("updated", {}):
            raise RuntimeError("Relay restriction failed")
        print("Relay restriction updated")
    elif mode == "create-key":
        store = ROOT / "secrets/values"
        secret_key = "stalwart:provisioning-api-key"
        target = store / hashlib.sha256(secret_key.encode()).hexdigest()
        if target.exists():
            raise SystemExit("Provisioning key already stored")
        existing = call("x:ApiKey/query", {"filter": {}})
        if existing.get("ids"):
            raise SystemExit("Existing API key requires inspection")
        permissions = {name: True for name in (
            "authenticate", "sysDomainGet", "sysDomainQuery", "sysDomainCreate",
            "sysAccountGet", "sysAccountQuery", "sysAccountCreate", "sysAccountUpdate",
        )}
        result = call("x:ApiKey/set", {"create": {"provisioning": {
            "description": "Unlimited Inboxes Provisioning",
            "permissions": {"@type": "Replace", "permissions": permissions},
            "allowedIps": {},
        }}})
        created = result.get("created", {}).get("provisioning")
        if not created or not created.get("secret"):
            raise RuntimeError("API key creation failed or did not return a secret")
        store.mkdir(mode=0o700)
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(created["secret"])
        print("Provisioning API key stored; id:", created.get("id"))
    elif mode == "grant-user-role-to-key":
        keys = call("x:ApiKey/query", {"filter": {}}).get("ids", [])
        if len(keys) != 1:
            raise RuntimeError("Expected exactly one API key")
        role_ids = call("x:Role/query", {"filter": {}, "limit": 100}).get("ids", [])
        roles = call("x:Role/get", {"ids": role_ids}).get("list", [])
        user_roles = [role for role in roles if role.get("description") == "User"]
        if len(user_roles) != 1:
            raise RuntimeError("Expected exactly one built-in User role")
        role = user_roles[0]
        key = call("x:ApiKey/get", {"ids": keys}).get("list", [])[0]
        permissions = dict(key["permissions"]["permissions"])
        permissions.update(role["enabledPermissions"])
        result = call("x:ApiKey/set", {"update": {keys[0]: {
            "permissions": {"@type": "Replace", "permissions": permissions},
        }}})
        if keys[0] not in result.get("updated", {}):
            raise RuntimeError("API key permission update failed")
        print("Provisioning key permissions:", len(permissions))
    elif mode == "provision-stacy":
        auth = provisioning_header()
        domains = call("x:Domain/query", {"filter": {"name": "igoutbound.com"}}, auth)
        if len(domains.get("ids", [])) != 1:
            raise RuntimeError("Expected exactly one domain")
        domain_id = domains["ids"][0]
        accounts = call("x:Account/query", {"filter": {}}, auth)
        fetched = call("x:Account/get", {"ids": accounts.get("ids", [])}, auth)
        for account in fetched.get("list", []):
            if account.get("domainId") == domain_id and account.get("name") == "stacy":
                print("Stacy mailbox already exists")
                return
        email = "stacy@igoutbound.com"
        target = ROOT / "secrets/values" / hashlib.sha256(f"mailbox:{email}".encode()).hexdigest()
        if target.exists():
            password = target.read_text()
        else:
            password = "M" + os.urandom(32).hex()
            descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w") as file:
                file.write(password)
        result = call("x:Account/set", {"create": {"stacy": {
            "@type": "User", "name": "stacy", "domainId": domain_id,
            "credentials": {"0": {"@type": "Password", "secret": password}},
            "roles": {"@type": "User"}, "permissions": {"@type": "Inherit"},
            "aliases": {}, "quotas": {}, "memberGroupIds": {},
            "encryptionAtRest": {"@type": "Disabled"},
        } }}, auth)
        if not result.get("created", {}).get("stacy", {}).get("id"):
            print("Creation error metadata:", [
                {"type": item.get("type"), "properties": item.get("properties"),
                 "description": str(item.get("description", "")).replace(password, "[redacted]")[:300]}
                for item in result.get("notCreated", {}).values()
            ])
            raise RuntimeError("Stacy mailbox creation failed")
        print("Stacy mailbox created")
    else:
        raise SystemExit("Use session or inspect")


if __name__ == "__main__":
    main()
