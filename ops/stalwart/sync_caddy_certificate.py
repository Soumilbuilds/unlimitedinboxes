#!/usr/bin/env python3
"""Install Caddy's renewed mail certificate in Stalwart without printing secrets.

Run as root on the VPS after Caddy has issued mail.igoutbound.com. A systemd
timer may run this repeatedly; unchanged certificates cause no API mutation.
"""

import hashlib
import os
import pathlib
import subprocess
import tempfile

from manage import call


HOST = "mail.igoutbound.com"
SOURCE = pathlib.Path(
    "/var/lib/caddy/.local/share/caddy/certificates/"
    "acme-v02.api.letsencrypt.org-directory/mail.igoutbound.com"
)
TARGET = pathlib.Path("/opt/stalwart/config/tls")


def run(*args, input_data=None):
    return subprocess.run(args, input=input_data, capture_output=True, check=True).stdout


def fingerprint(path):
    return hashlib.sha256(path.read_bytes()).digest()


def validate(cert, key):
    run("openssl", "x509", "-in", str(cert), "-noout", "-checkend", "604800", "-checkhost", HOST)
    cert_public = run("openssl", "x509", "-in", str(cert), "-pubkey", "-noout")
    key_public = run("openssl", "pkey", "-in", str(key), "-pubout")
    if cert_public != key_public:
        raise RuntimeError("Certificate and private key do not match")


def copy_private(source, destination):
    descriptor, temporary = tempfile.mkstemp(prefix=".cert-", dir=TARGET)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, 2000, 2000)
        with os.fdopen(descriptor, "wb") as output:
            output.write(source.read_bytes())
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run as root on the Stalwart VPS")
    source_cert = SOURCE / f"{HOST}.crt"
    source_key = SOURCE / f"{HOST}.key"
    if not source_cert.is_file() or not source_key.is_file():
        raise SystemExit("Caddy mail certificate is not available yet")
    validate(source_cert, source_key)
    TARGET.mkdir(mode=0o700, exist_ok=True)
    os.chown(TARGET, 2000, 2000)
    target_cert = TARGET / "fullchain.pem"
    target_key = TARGET / "privkey.pem"
    changed = not (target_cert.is_file() and target_key.is_file() and
                   fingerprint(source_cert) == fingerprint(target_cert) and
                   fingerprint(source_key) == fingerprint(target_key))
    if changed:
        copy_private(source_cert, target_cert)
        copy_private(source_key, target_key)

    certificate_ids = call("x:Certificate/query", {
        "filter": {"subjectAlternativeNames": HOST}, "limit": 100,
    }).get("ids", [])
    if len(certificate_ids) > 1:
        raise RuntimeError("Multiple certificates match the mail hostname")
    cert_object = {
        "certificate": {"@type": "File", "filePath": "/etc/stalwart/tls/fullchain.pem"},
        "privateKey": {"@type": "File", "filePath": "/etc/stalwart/tls/privkey.pem"},
    }
    if certificate_ids:
        cert_id = certificate_ids[0]
        if changed:
            result = call("x:Certificate/set", {"update": {cert_id: cert_object}})
            if cert_id not in result.get("updated", {}):
                raise RuntimeError("Certificate update failed")
    else:
        result = call("x:Certificate/set", {"create": {"mail": cert_object}})
        cert_id = result.get("created", {}).get("mail", {}).get("id")
        if not cert_id:
            raise RuntimeError("Certificate creation failed")
        changed = True

    settings = call("x:SystemSettings/get", {"ids": ["singleton"]}).get("list", [])
    if len(settings) != 1:
        raise RuntimeError("SystemSettings singleton missing")
    if settings[0].get("defaultCertificateId") != cert_id:
        result = call("x:SystemSettings/set", {
            "update": {"singleton": {"defaultCertificateId": cert_id}},
        })
        if "singleton" not in result.get("updated", {}):
            raise RuntimeError("Default certificate setting failed")
        changed = True
    if changed:
        result = call("x:Action/set", {
            "create": {"reload": {"@type": "ReloadTlsCertificates"}},
        })
        if not result.get("created", {}).get("reload", {}).get("id"):
            raise RuntimeError("TLS reload failed")
    print("Stalwart certificate synchronized" if changed else "Stalwart certificate unchanged")


if __name__ == "__main__":
    main()
