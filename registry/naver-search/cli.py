#!/usr/bin/env python3
import argparse
import html
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, urljoin
from urllib.request import Request, urlopen

EXIT_SUCCESS = 0
EXIT_ERROR = 1
EXIT_AUTH_NEEDED = 2
EXIT_API_CHANGED = 3

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
]

SEARCH_ENDPOINTS = {
    "web": "https://search.naver.com/search.naver?where=m&query={query}",
    "news": "https://search.naver.com/search.naver?where=news&query={query}",
    "shop": "https://search.shopping.naver.com/search/all?query={query}",
}


def log(message: str) -> None:
    print(message, file=sys.stderr)


def strip_tags(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(value))).strip()


def make_request(url: str, timeout: float = 10.0) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": random.choice(USER_AGENTS),
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": "https://www.naver.com/",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def parse_anchor_results(raw_html: str, base_url: str, limit: int, search_type: str) -> List[Dict[str, Optional[str]]]:
    results: List[Dict[str, Optional[str]]] = []
    seen = set()
    anchor_pattern = re.compile(r"<a\b([^>]+)>(.*?)</a>", re.IGNORECASE | re.DOTALL)
    href_pattern = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
    title_pattern = re.compile(r'title=["\']([^"\']+)["\']', re.IGNORECASE)
    for match in anchor_pattern.finditer(raw_html):
        attrs = match.group(1)
        anchor_html = match.group(2)
        href_match = href_pattern.search(attrs)
        if not href_match:
            continue
        href = html.unescape(href_match.group(1)).strip()
        if not href or href.startswith("#") or href.startswith("javascript:"):
            continue
        absolute_url = urljoin(base_url, href)
        if absolute_url in seen:
            continue
        title_match = title_pattern.search(attrs)
        title = strip_tags(title_match.group(1) if title_match else anchor_html)
        if len(title) < 2:
            continue
        lowered = absolute_url.lower()
        if search_type in {"web", "news"} and "naver.com" in lowered and "news.naver.com" not in lowered:
            continue
        if search_type == "shop" and not re.search(r"(shopping\.naver|adcr\.naver|cr\.shopping)", lowered):
            continue
        surrounding = raw_html[max(0, match.start() - 250): min(len(raw_html), match.end() + 400)]
        price_match = re.search(r"([0-9][0-9,]{1,12})\s*원", surrounding)
        source_match = re.search(r'>([^<>]{2,40})<', surrounding)
        results.append({
            "title": title,
            "url": absolute_url,
            "snippet": strip_tags(surrounding)[:240] or None,
            "price": price_match.group(1) + "원" if price_match else None,
            "source": strip_tags(source_match.group(1)) if source_match else None,
        })
        seen.add(absolute_url)
        if len(results) >= limit:
            break
    return results


def search(query: str, search_type: str, limit: int) -> Dict[str, object]:
    encoded_query = quote_plus(query)
    url = SEARCH_ENDPOINTS[search_type].format(query=encoded_query)
    time.sleep(0.35)
    raw_html = make_request(url)
    results = parse_anchor_results(raw_html, url, limit, search_type)
    if not results:
        raise RuntimeError(f"No structured results parsed for search type '{search_type}'")
    return {
        "query": query,
        "type": search_type,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "count": len(results),
        "results": results,
    }


def health() -> Dict[str, object]:
    started = time.time()
    try:
        raw_html = make_request("https://search.naver.com/search.naver?where=m&query=test", timeout=8.0)
    except HTTPError as error:
        status = {
            "ok": False,
            "status": "http_error",
            "code": error.code,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.time() - started) * 1000),
        }
        if error.code in {401, 403}:
            raise SystemExit(EXIT_AUTH_NEEDED)
        return status
    except URLError as error:
        return {
            "ok": False,
            "status": "network_error",
            "error": str(error.reason),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": int((time.time() - started) * 1000),
        }
    return {
        "ok": "naver" in raw_html.lower(),
        "status": "ok" if "naver" in raw_html.lower() else "unexpected_response",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": int((time.time() - started) * 1000),
    }


def capabilities() -> Dict[str, object]:
    return {
        "name": "naver-search",
        "capabilities": ["web-search", "news-search", "shop-search"],
        "commands": ["search", "health", "capabilities", "status"],
    }


def status() -> Dict[str, object]:
    return {
        "name": "naver-search",
        "python": sys.version.split()[0],
        "cwd": ".",
        "time": datetime.now(timezone.utc).isoformat(),
        "healthy": health().get("ok", False),
    }


def emit(payload: Dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Naver search CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("query")
    search_parser.add_argument("--type", choices=["web", "news", "shop"], default="web")
    search_parser.add_argument("--limit", type=int, default=10)
    search_parser.add_argument("--json", action="store_true")

    for name in ["health", "capabilities", "status"]:
        command_parser = subparsers.add_parser(name)
        command_parser.add_argument("--json", action="store_true")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "search":
            payload = search(args.query, args.type, max(1, min(args.limit, 25)))
            emit(payload, args.json)
            return EXIT_SUCCESS
        if args.command == "health":
            payload = health()
            emit(payload, args.json)
            return EXIT_SUCCESS if payload.get("ok") else EXIT_API_CHANGED
        if args.command == "capabilities":
            emit(capabilities(), args.json)
            return EXIT_SUCCESS
        if args.command == "status":
            emit(status(), args.json)
            return EXIT_SUCCESS
    except SystemExit as error:
        return int(str(error)) if str(error).isdigit() else EXIT_ERROR
    except HTTPError as error:
        log(f"HTTP error: {error.code} {error.reason}")
        return EXIT_AUTH_NEEDED if error.code in {401, 403} else EXIT_API_CHANGED
    except URLError as error:
        log(f"Network error: {error.reason}")
        return EXIT_ERROR
    except Exception as error:
        log(f"Unhandled error: {error}")
        return EXIT_API_CHANGED if args.command == "search" else EXIT_ERROR
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
