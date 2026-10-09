#!/usr/bin/env python3
"""Removes the custom email templates and security notices from a Supabase config.toml, in place.

Used only by .github/workflows/deploy-dev-db.yml on its throwaway checkout: Supabase refuses email template changes
on free projects that use its default email sender ("Email template modification is not available for free tier
projects using the default email provider"). Until TopStock has its own SMTP sender (Gate 1), the dev project keeps
Supabase's default emails, while CI's local stack keeps testing ours. Delete this script and its workflow step then.
"""
import re
import sys
import tomllib

path = sys.argv[1] if len(sys.argv) > 1 else "supabase/config.toml"
kept, skipping = [], False
with open(path, encoding="utf-8") as f:
    for line in f:
        header = re.match(r"\s*\[([^\]]+)\]\s*$", line)
        if header:
            skipping = header.group(1).startswith(("auth.email.template.", "auth.email.notification."))
        if not skipping:
            kept.append(line)
with open(path, "w", encoding="utf-8") as f:
    f.write("".join(kept))

email = tomllib.load(open(path, "rb"))["auth"]["email"]
assert "template" not in email and "notification" not in email, "templates still present"
print(f"{path}: custom email templates and notices left out for this push")
