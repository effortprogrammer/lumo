# naver-search

Python CLI for Naver web, news, and shopping search using public search pages and `urllib.request`.

Examples:

```bash
python3 cli.py search "에어팟 프로" --type shop --limit 10 --json
python3 cli.py search "최신 뉴스" --type news --limit 5 --json
python3 cli.py health --json
python3 cli.py capabilities --json
python3 cli.py status --json
```

Notes:

- No external dependencies.
- Uses realistic browser user-agent rotation.
- Writes logs/errors to stderr and data to stdout.
