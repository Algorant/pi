#!/usr/bin/env python3
"""Read a bounded X List feed and render its attributed Markdown with Leaf."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from typing import Any


class FeedError(Exception):
    """A safe, user-facing feed error that contains no raw xurl diagnostics."""


def parse_count(value: str) -> int:
    try:
        count = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("count must be an integer from 1 to 100") from exc
    if not 1 <= count <= 100:
        raise argparse.ArgumentTypeError("count must be from 1 to 100")
    return count


def parse_list_id(target: str) -> str:
    if re.fullmatch(r"\d{1,30}", target):
        return target

    try:
        parsed = urlsplit(target)
    except ValueError as exc:
        raise FeedError("provide a numeric X List ID or an x.com/twitter.com List URL") from exc
    hostname = (parsed.hostname or "").lower().removeprefix("www.")
    if parsed.username is not None or parsed.password is not None:
        raise FeedError("provide a numeric X List ID or an x.com/twitter.com List URL")
    if parsed.scheme not in {"http", "https"} or hostname not in {"x.com", "twitter.com"}:
        raise FeedError("provide a numeric X List ID or an x.com/twitter.com List URL")
    match = re.fullmatch(r"/(?:i/lists|[^/]+/lists)/(\d+)/?", parsed.path)
    if not match:
        raise FeedError("the X URL does not contain a supported List ID")
    return match.group(1)


XURL_MANIFEST = Path.home() / ".config" / "fnox" / "manifests" / "xurl.toml"
OPERATOR_HINT = (
    "operator: sign in to pass-cli / restore the xurl fnox manifest "
    "(~/.config/fnox/manifests/xurl.toml). Nothing was retried and bare xurl was not used."
)


def xurl_argv(*args: str) -> list[str]:
    """xurl only through the fnox manifest (argv, no shell), so it can refresh its OAuth2 token."""
    fnox = shutil.which("fnox")
    if not fnox:
        raise FeedError(f"fnox is not installed or not on PATH. {OPERATOR_HINT}")
    if not XURL_MANIFEST.is_file():
        raise FeedError(f"missing {XURL_MANIFEST}. {OPERATOR_HINT}")
    return [fnox, "--non-interactive", "-c", str(XURL_MANIFEST), "exec", "--", "xurl", *args]


def read_auth_status() -> None:
    """Check auth presence only; xurl's raw status output can expose a client ID."""
    try:
        result = subprocess.run(
            xurl_argv("auth", "status"), capture_output=True, text=True, timeout=10, check=False
        )
    except subprocess.TimeoutExpired as exc:
        raise FeedError("xurl auth status timed out; no X request or login was attempted") from exc
    except OSError as exc:
        raise FeedError("could not run xurl auth status") from exc
    if result.returncode != 0:
        raise FeedError(f"xurl auth status failed (exit {result.returncode}); diagnostics were suppressed")

    lines = result.stdout.splitlines()
    oauth_present = any("oauth2:" in line and "(none)" not in line for line in lines)
    app_present = any("bearer:" in line and "✓" in line for line in lines)
    if not (oauth_present or app_present):
        raise FeedError("xurl reports no OAuth2 or app-only auth; establish xurl auth separately (no login was attempted)")


def request_path(list_id: str, count: int) -> str:
    # X's list-tweets endpoint has a minimum page size of five. Display no more
    # than requested, even when a smaller request needs a five-item API page.
    page_size = max(5, count)
    return (
        f"/2/lists/{list_id}/tweets?max_results={page_size}"
        "&tweet.fields=created_at,author_id,referenced_tweets"
        "&expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id&user.fields=username,name"
    )


def _error_status(payload: Any) -> int | None:
    if not isinstance(payload, dict):
        return None
    errors = payload.get("errors")
    if not isinstance(errors, list):
        errors = [payload.get("error", payload)]
    for error in errors:
        if isinstance(error, dict):
            for key in ("status", "status_code"):
                status = error.get(key)
                if isinstance(status, int):
                    return status
    return None


def _api_failure(returncode: int, stdout: str) -> FeedError:
    try:
        payload = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        payload = None
    status = _error_status(payload)
    if status == 429:
        return FeedError("X API rate limit (HTTP 429); do not retry automatically")
    if status in {401, 403}:
        return FeedError(f"X API auth/access error (HTTP {status}); stop and ask Algorant to resolve access; no login or retry was attempted")
    if status is not None:
        return FeedError(f"xurl List read failed (HTTP {status}); no feed was rendered")
    return FeedError(f"xurl List GET failed (exit {returncode}); diagnostics were suppressed")


def fetch_response(list_id: str, count: int) -> dict[str, Any]:
    try:
        result = subprocess.run(
            xurl_argv("-X", "GET", request_path(list_id, count)),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise FeedError("xurl List GET timed out; no retry was attempted") from exc
    except OSError as exc:
        raise FeedError("could not run xurl List GET") from exc
    if result.returncode != 0:
        raise _api_failure(result.returncode, result.stdout)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise FeedError("xurl returned a non-JSON response; no feed was rendered") from exc
    if not isinstance(payload, dict):
        raise FeedError("xurl returned an unexpected response shape; no feed was rendered")
    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        status = _error_status(payload)
        if status == 429:
            raise FeedError("X API rate limit (HTTP 429); do not retry automatically")
        if status in {401, 403}:
            raise FeedError(f"X API auth/access error (HTTP {status}); stop and ask Algorant to resolve access; no login or retry was attempted")
        raise FeedError("X API returned List read errors; no feed was rendered")
    data = payload.get("data")
    if data is None and isinstance(payload.get("meta"), dict) and payload["meta"].get("result_count") == 0:
        data = []
    if not isinstance(data, list):
        raise FeedError("xurl returned no post list or a malformed response; no feed was rendered")
    if any(not isinstance(post, dict) or not re.fullmatch(r"\d{1,30}", str(post.get("id", ""))) for post in data):
        raise FeedError("xurl returned a malformed post; no feed was rendered")
    return payload


def escape_text(value: str) -> str:
    # Escape HTML delimiters before Markdown punctuation so untrusted post text
    # remains text (including any heading, link, or quote-looking lines).
    value = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(r"([\\`*_{}\[\]()#+.!|~-])", r"\\\1", value)


def quoted_text(value: str) -> list[str]:
    lines = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return ["> " + escape_text(line) for line in lines]


def escape_label(value: str) -> str:
    return escape_text(value.replace("\r", " ").replace("\n", " "))


def display_author(user: Any) -> str:
    if not isinstance(user, dict):
        return "Author unavailable"
    name = user.get("name")
    username = user.get("username")
    if isinstance(name, str) and name and isinstance(username, str) and username:
        return f"{escape_label(name)} (@{escape_label(username)})"
    if isinstance(username, str) and username:
        return f"@{escape_label(username)}"
    if isinstance(name, str) and name:
        return escape_label(name)
    return "Author unavailable"


def permalink(post_id: str, user: Any) -> str:
    username = user.get("username") if isinstance(user, dict) else None
    if isinstance(username, str) and re.fullmatch(r"[A-Za-z0-9_]{1,15}", username):
        return f"https://x.com/{username}/status/{post_id}"
    return f"https://x.com/i/web/status/{post_id}"


def post_time(value: Any) -> str:
    if not isinstance(value, str):
        return "time unavailable"
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return "time unavailable"
        return stamp.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    except ValueError:
        return "time unavailable"


def render_feed(list_id: str, payload: dict[str, Any], count: int) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"### X List {list_id} · checked {now}", ""]
    data = payload.get("data")
    posts = data[:count] if isinstance(data, list) else []
    includes = payload.get("includes") if isinstance(payload.get("includes"), dict) else {}
    users = includes.get("users") if isinstance(includes.get("users"), list) else []
    users_by_id = {
        user.get("id"): user
        for user in users
        if isinstance(user, dict) and isinstance(user.get("id"), str)
    }
    referenced = includes.get("tweets") if isinstance(includes.get("tweets"), list) else []
    tweets_by_id = {
        tweet.get("id"): tweet
        for tweet in referenced
        if isinstance(tweet, dict) and isinstance(tweet.get("id"), str)
    }

    if not posts:
        lines.extend(["No posts returned in this bounded read; the List may be empty or inaccessible.", ""])
        return "\n".join(lines)

    for index, post in enumerate(posts):
        if index:
            lines.append("")
        author_id = post.get("author_id")
        author = users_by_id.get(author_id) if isinstance(author_id, str) else None
        refs = post.get("referenced_tweets") if isinstance(post.get("referenced_tweets"), list) else []
        ref = next((item for item in refs if isinstance(item, dict) and item.get("type") in {"quoted", "retweeted", "replied_to"}), None)
        kind_by_type = {"quoted": "quote", "retweeted": "repost", "replied_to": "reply"}
        kind = kind_by_type.get(ref.get("type"), "original") if ref else "original"
        lines.append(f"**{display_author(author)}** · {post_time(post.get('created_at'))} · {kind}")

        ref_id = ref.get("id") if ref else None
        referenced_post = tweets_by_id.get(ref_id) if isinstance(ref_id, str) else None
        # A repost's included source is its content; for other kinds, preserve
        # the wrapper's own text first and keep referenced content distinct.
        if kind == "repost" and isinstance(referenced_post, dict):
            lines.extend(["> Reposted post:", *quoted_text(str(referenced_post.get("text", "")))])
        else:
            text = post.get("text")
            lines.extend(quoted_text(text if isinstance(text, str) else "Post text unavailable"))

        lines.append(permalink(str(post["id"]), author))
        if ref:
            ref_id = ref.get("id")
            if isinstance(ref_id, str) and re.fullmatch(r"\d{1,30}", ref_id):
                context_post = referenced_post if isinstance(referenced_post, dict) else None
                context_author_id = context_post.get("author_id") if context_post else None
                context_author = users_by_id.get(context_author_id) if isinstance(context_author_id, str) else None
                context_kind = {"quoted": "Quoted post", "retweeted": "Reposted source", "replied_to": "Reply context"}[ref["type"]]
                if context_post and ref["type"] != "retweeted":
                    lines.append(f"> {context_kind} by {display_author(context_author)}:")
                    context_text = context_post.get("text")
                    lines.extend(quoted_text(context_text if isinstance(context_text, str) else "Referenced post text unavailable"))
                elif not context_post:
                    lines.append(f"> {context_kind} details unavailable")
                lines.append(permalink(ref_id, context_author))
            else:
                lines.append("> Referenced post ID unavailable")

    if len(posts) < count:
        lines.extend(["", f"The API returned {len(posts)} of {count} requested posts."])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read a bounded X List feed through xurl and render it with Leaf.")
    parser.add_argument("list", help="numeric X List ID or x.com/twitter.com List URL")
    parser.add_argument("count", type=parse_count, help="posts to show (1-100)")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--inline", action="store_true", help="render Leaf's non-interactive plain view (default)")
    modes.add_argument("--markdown", action="store_true", help="emit attributed Markdown without launching Leaf")
    args = parser.parse_args()

    try:
        list_id = parse_list_id(args.list)
        leaf = None if args.markdown else shutil.which("leaf")
        if not args.markdown and not leaf:
            raise FeedError("Leaf is not installed or not on PATH")
        read_auth_status()
        payload = fetch_response(list_id, args.count)
        markdown = render_feed(list_id, payload, args.count)
        if args.markdown:
            sys.stdout.write(markdown)
            return 0
        result = subprocess.run([leaf, "--inline", "plain:80"], input=markdown, text=True, check=False)
        if result.returncode != 0:
            raise FeedError(f"Leaf inline rendering failed (exit {result.returncode})")
        return 0
    except FeedError as exc:
        print(f"xurl-list-feed: {exc}", file=sys.stderr)
        return 1
    except OSError:
        print("xurl-list-feed: a required local command could not be run", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
