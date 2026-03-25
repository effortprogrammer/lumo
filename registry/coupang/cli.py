#!/usr/bin/env python3
import argparse
import html
import json
import os
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


def log(message: str) -> None:
    print(message, file=sys.stderr)


def strip_tags(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(value))).strip()


def make_request(url: str, timeout: float = 10.0) -> str:
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.coupang.com/",
    }
    cookie = os.getenv("COUPANG_COOKIE", "").strip()
    if cookie:
        headers["Cookie"] = cookie
    request = Request(url, headers=headers)
    with urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def parse_search_results(raw_html: str, base_url: str, limit: int) -> List[Dict[str, Optional[str]]]:
    results: List[Dict[str, Optional[str]]] = []
    seen = set()
    pattern = re.compile(r'<a\b([^>]+href=["\']([^"\']*/vp/products/(\d+)[^"\']*)["\'][^>]*)>(.*?)</a>', re.IGNORECASE | re.DOTALL)
    title_pattern = re.compile(r'title=["\']([^"\']+)["\']', re.IGNORECASE)
    for match in pattern.finditer(raw_html):
        attrs, href, product_id, anchor_html = match.groups()
        absolute_url = urljoin(base_url, html.unescape(href))
        if product_id in seen:
            continue
        title_match = title_pattern.search(attrs)
        title = strip_tags(title_match.group(1) if title_match else anchor_html)
        if len(title) < 2:
            continue
        surrounding = raw_html[max(0, match.start() - 250): min(len(raw_html), match.end() + 500)]
        price_match = re.search(r"([0-9][0-9,]{1,12})\s*원", surrounding)
        rating_match = re.search(r"([0-9]\.[0-9])", surrounding)
        results.append({
            "product_id": product_id,
            "title": title,
            "url": absolute_url,
            "price": price_match.group(1) + "원" if price_match else None,
            "rating": rating_match.group(1) if rating_match else None,
            "snippet": strip_tags(surrounding)[:240] or None,
        })
        seen.add(product_id)
        if len(results) >= limit:
            break
    return results


def search(query: str, limit: int) -> Dict[str, object]:
    url = f"https://www.coupang.com/np/search?component=&q={quote_plus(query)}&channel=user"
    time.sleep(0.35)
    raw_html = make_request(url)
    results = parse_search_results(raw_html, url, limit)
    if not results:
        raise RuntimeError("No structured Coupang search results parsed")
    return {
        "query": query,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "count": len(results),
        "results": results,
    }


def extract_ld_json(raw_html: str) -> Optional[Dict[str, object]]:
    for match in re.finditer(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', raw_html, re.IGNORECASE | re.DOTALL):
        body = match.group(1).strip()
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("@type") in {"Product", "ItemPage"}:
            return payload
    return None


def get_product(product_id: str) -> Dict[str, object]:
    url = f"https://www.coupang.com/vp/products/{product_id}"
    time.sleep(0.35)
    raw_html = make_request(url)
    ld_json = extract_ld_json(raw_html) or {}
    offers = ld_json.get("offers", {}) if isinstance(ld_json, dict) else {}
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    title_match = re.search(r"<title>(.*?)</title>", raw_html, re.IGNORECASE | re.DOTALL)
    price_match = re.search(r"([0-9][0-9,]{1,12})\s*원", raw_html)
    return {
        "product_id": product_id,
        "url": url,
        "title": strip_tags(str(ld_json.get("name") or (title_match.group(1) if title_match else ""))),
        "description": strip_tags(str(ld_json.get("description", ""))) or None,
        "brand": ld_json.get("brand", {}).get("name") if isinstance(ld_json.get("brand"), dict) else None,
        "price": offers.get("price") if isinstance(offers, dict) else (price_match.group(1) if price_match else None),
        "currency": offers.get("priceCurrency") if isinstance(offers, dict) else None,
        "availability": offers.get("availability") if isinstance(offers, dict) else None,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def health() -> Dict[str, object]:
    started = time.time()
    try:
        raw_html = make_request("https://www.coupang.com/np/search?component=&q=test&channel=user", timeout=8.0)
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
        "ok": "coupang" in raw_html.lower(),
        "status": "ok" if "coupang" in raw_html.lower() else "unexpected_response",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": int((time.time() - started) * 1000),
    }


def capabilities() -> Dict[str, object]:
    return {
        "name": "coupang",
        "capabilities": ["search", "product-detail", "price"],
        "commands": ["search", "get", "health", "capabilities", "status"],
    }


def status() -> Dict[str, object]:
    return {
        "name": "coupang",
        "python": sys.version.split()[0],
        "cookie_configured": bool(os.getenv("COUPANG_COOKIE", "").strip()),
        "time": datetime.now(timezone.utc).isoformat(),
        "healthy": health().get("ok", False),
    }


def emit(payload: Dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Coupang search CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("query")
    search_parser.add_argument("--limit", type=int, default=10)
    search_parser.add_argument("--json", action="store_true")

    get_parser = subparsers.add_parser("get")
    get_parser.add_argument("product_id")
    get_parser.add_argument("--json", action="store_true")

    for name in ["health", "capabilities", "status"]:
        command_parser = subparsers.add_parser(name)
        command_parser.add_argument("--json", action="store_true")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "search":
            emit(search(args.query, max(1, min(args.limit, 25))), args.json)
            return EXIT_SUCCESS
        if args.command == "get":
            emit(get_product(args.product_id), args.json)
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
        return EXIT_API_CHANGED if args.command in {"search", "get"} else EXIT_ERROR
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
