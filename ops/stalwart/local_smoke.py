#!/usr/bin/env python3
"""Local SMTP and IMAP smoke test, independent of public MX delivery."""

import hashlib
import imaplib
import pathlib
import smtplib
import ssl
import sys
import time
import uuid
from email.message import EmailMessage


ADDRESS = "stacy@igoutbound.com"
ROOT = pathlib.Path("/opt/stalwart")
SECRET = ROOT / "secrets/values" / hashlib.sha256(f"mailbox:{ADDRESS}".encode()).hexdigest()


def main():
    password = SECRET.read_text()
    subject = "local-stalwart-smoke-" + uuid.uuid4().hex
    message = EmailMessage()
    message["From"] = "local-probe@example.invalid"
    message["To"] = ADDRESS
    message["Subject"] = subject
    message.set_content("Local delivery smoke test.")

    # This test deliberately uses loopback. Public TLS is checked separately.
    context = ssl._create_unverified_context()
    with imaplib.IMAP4_SSL("127.0.0.1", 1993, ssl_context=context, timeout=15) as imap:
        status, _ = imap.login(ADDRESS, password)
        assert status == "OK", "IMAP authentication failed"
        print("IMAP authentication: OK")
        if len(sys.argv) > 1 and sys.argv[1] == "folders":
            status, folders = imap.list()
            print("Folders:", [folder.decode(errors="replace") for folder in folders or []])
            return

    with smtplib.SMTP("127.0.0.1", 25, timeout=15) as smtp:
        smtp.ehlo("localhost")
        smtp.mail("local-probe@example.invalid")
        code, _ = smtp.rcpt("foreign-recipient@example.net")
        assert code >= 500, f"Relay unexpectedly accepted with code {code}"
        print("Unauthenticated foreign relay: rejected")

    with smtplib.SMTP("127.0.0.1", 25, timeout=15) as smtp:
        smtp.send_message(message)
        print("Local SMTP delivery: accepted")

    found = False
    for _ in range(12):
        with imaplib.IMAP4_SSL("127.0.0.1", 1993, ssl_context=context, timeout=15) as imap:
            imap.login(ADDRESS, password)
            for folder in ("INBOX", "Junk Mail"):
                status, _ = imap.select(f'"{folder}"')
                if status != "OK":
                    continue
                status, data = imap.search(None, "HEADER", "Subject", subject)
                if status == "OK" and data and data[0]:
                    print("Local message folder:", folder)
                    found = True
                    break
            if found:
                break
        time.sleep(2)
    assert found, "Local message missing from Stacy mailbox"
    print("Local message visible over IMAP: OK")


if __name__ == "__main__":
    main()
