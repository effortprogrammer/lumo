#!/usr/bin/env python3
import json
import subprocess
import sys
import time


def run(*args):
    result = subprocess.run(
        [sys.executable, "cli.py", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(args)}\nstderr={result.stderr.strip()}")
    return json.loads(result.stdout)


def main():
    try:
        health = run("health", "--json")
        assert "ok" in health
        time.sleep(0.4)
        capabilities = run("capabilities", "--json")
        assert "product-detail" in capabilities["capabilities"]
        time.sleep(0.4)
        payload = run("search", "에어팟 프로", "--limit", "3", "--json")
        assert isinstance(payload["results"], list)
        if payload["results"]:
            product_id = payload["results"][0]["product_id"]
            time.sleep(0.4)
            detail = run("get", str(product_id), "--json")
            assert str(detail["product_id"]) == str(product_id)
        print("coupang smoke test passed")
    except Exception as error:
        print(f"coupang smoke test skipped/failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
