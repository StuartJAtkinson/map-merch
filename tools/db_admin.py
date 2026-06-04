"""One-off prod DB admin helper (via Cloud SQL Auth Proxy on localhost).

Usage:
  python tools/db_admin.py list
  python tools/db_admin.py delete <email>

Connects to 127.0.0.1:5433 (proxy) -> heart_on_a_sleeve.
Credentials come from env: PGUSER, PGPASSWORD.
"""
import os
import sys

import pg8000.native

HOST = "127.0.0.1"
PORT = 5433
DB = "heart_on_a_sleeve"


def connect():
    return pg8000.native.Connection(
        host=HOST, port=PORT, database=DB,
        user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"],
    )


def list_users():
    conn = connect()
    try:
        rows = conn.run("SELECT id, email, created_at FROM users ORDER BY id")
        if not rows:
            print("(no rows in users table)")
        for r in rows:
            print(f"  id={r[0]:<4} email={r[1]:<40} created_at={r[2]}")
        print(f"total: {len(rows)}")
    finally:
        conn.close()


def delete_user(email: str):
    conn = connect()
    try:
        rows = conn.run("SELECT id, email FROM users WHERE email = :e", e=email)
        if not rows:
            print(f"NO MATCH for email={email!r} -- nothing deleted")
            return
        conn.run("DELETE FROM users WHERE id = :i", i=rows[0][0])
        print(f"DELETED id={rows[0][0]} email={rows[0][1]}")
    finally:
        conn.close()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        list_users()
    elif cmd == "delete":
        delete_user(sys.argv[2])
    else:
        print(f"unknown cmd: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
