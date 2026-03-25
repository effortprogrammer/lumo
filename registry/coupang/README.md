# coupang

Python CLI for Coupang product search and product detail retrieval using public web pages and `urllib.request`.

Examples:

```bash
python3 cli.py search "에어팟 프로" --limit 10 --json
python3 cli.py get 123456789 --json
python3 cli.py health --json
python3 cli.py capabilities --json
python3 cli.py status --json
```

Notes:

- Uses browser-like headers and conservative request pacing.
- Supports cookie injection via `COUPANG_COOKIE` when needed.
- Emits machine-readable JSON to stdout with `--json`.
