"""Bounded read-only adapter for the official Ollama model library.

Ollama has no published registry search API. Its official search/tag pages
supply real names, never guessed tags. Changed markup fails closed.
Registration verifies a manifest has local weights, without fetching blobs
or accessing the local runtime. Only public model queries leave this PC.
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from ollama_utils import is_cloud_ollama_model

SOURCE = "https://ollama.com"
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")
_TAG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")
_MAX_FAMILIES = 3
_MAX_RESULTS = 16
_MAX_TAGS_PER_FAMILY = 8


class CatalogUnavailableError(Exception):
    """The official source could not be safely read."""


class CatalogSelectionError(ValueError):
    """Not a verified local text-generation model."""


class _OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != "https" or target.netloc not in {"ollama.com", "registry.ollama.ai"}:
            raise CatalogUnavailableError("Unexpected catalog redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _read(url: str, deadline: float, *, json_document: bool = False) -> str:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CatalogUnavailableError("Catalog request timed out")
    request = urllib.request.Request(url, headers={
        "User-Agent": "LMO-model-catalog/1.0",
        "Accept": "application/vnd.docker.distribution.manifest.v2+json" if json_document else "text/html",
    })
    limit = 256_000 if json_document else 2_000_000
    try:
        with urllib.request.build_opener(_OfficialRedirects()).open(request, timeout=min(5.0, remaining)) as response:
            chunks = []
            length = 0
            while True:
                if time.monotonic() >= deadline:
                    raise CatalogUnavailableError("Catalog request timed out")
                chunk = response.read1(min(65_536, limit + 1 - length))
                if not chunk:
                    break
                chunks.append(chunk)
                length += len(chunk)
                if length > limit:
                    raise CatalogUnavailableError("Catalog response too large")
        return b"".join(chunks).decode("utf-8")
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise CatalogUnavailableError("Could not read official catalog") from exc


class _SearchParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.families = []
        self.result_count = None
        self.has_more = False
        self._card = None
        self._span = None
        self._recognized_cards = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "data-result-count" in attrs:
            count = attrs["data-result-count"]
            self.result_count = int(count) if count and count.isdigit() else None
            self.has_more = attrs.get("data-has-more") == "true"
        if tag == "li":
            self._card = {"family": "", "description": "", "capabilities": set()}
        if self._card is None:
            return
        if tag == "h2":
            self._recognized_cards += 1
        if tag == "a":
            match = re.fullmatch(r"/library/([A-Za-z0-9][A-Za-z0-9._-]{0,79})", attrs.get("href", ""))
            if match:
                self._card["family"] = match[1]
        elif tag == "p" and attrs.get("title") and not self._card["description"]:
            self._card["description"] = " ".join(attrs["title"].split())[:240]
        elif tag == "span":
            self._span = []

    def handle_data(self, data):
        if self._span is not None:
            self._span.append(data)

    def handle_endtag(self, tag):
        if tag == "span" and self._span is not None:
            if self._card is not None:
                self._card["capabilities"].add("".join(self._span).strip().lower())
            self._span = None
        elif tag == "li" and self._card is not None:
            if self._card["family"]:
                self.families.append(self._card)
            self._card = None


class _TagsParser(HTMLParser):
    def __init__(self, family: str):
        super().__init__(convert_charrefs=True)
        self.family = family
        self.tags = {}
        self._model = ""
        self._parts = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        href = dict(attrs).get("href", "")
        prefix = f"/library/{self.family}:"
        if href.startswith(prefix) and _TAG.fullmatch(href[len(prefix):]):
            self._model = href[len("/library/"):]
            self._parts = []

    def handle_data(self, data):
        if self._model:
            self._parts.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._model:
            text = " ".join(" ".join(self._parts).split())
            size = re.search(r"\b\d+(?:\.\d+)?\s*(?:[KMGT]B)\b", text)
            existing = self.tags.get(self._model, {})
            self.tags[self._model] = {
                "model": self._model,
                "size": size[0] if size else existing.get("size", ""),
                "cloud": bool(re.search(r"\bcloud\b", text, re.I)) or existing.get("cloud", False),
            }
            self._model = ""


def _search_families(query: str, deadline: float) -> tuple[list[dict], bool]:
    parser = _SearchParser()
    parser.feed(_read(f"{SOURCE}/search?{urllib.parse.urlencode({'q': query, 'c': 'local'})}", deadline))
    if parser.result_count is None or (parser.result_count > 0 and not parser._recognized_cards):
        raise CatalogUnavailableError("Unrecognized search response")
    families = [item for item in parser.families if not item["capabilities"] & {"embedding", "decision", "image"}]
    return families, parser.has_more


def _family_tags(family: str, deadline: float) -> list[dict]:
    parser = _TagsParser(family)
    parser.feed(_read(f"{SOURCE}/library/{family}/tags", deadline))
    if not parser.tags:
        raise CatalogUnavailableError("Unrecognized tag response")
    return [item for item in parser.tags.values() if len(item["model"]) <= 128 and not item["cloud"] and not is_cloud_ollama_model(item["model"])]


def _split_query(query: str, *, require_tag: bool = False) -> tuple[str, str]:
    parts = query.strip().split(":")
    if len(parts) > 2 or not _NAME.fullmatch(parts[0]) or (len(parts) == 2 and not _TAG.fullmatch(parts[1])):
        raise CatalogSelectionError("Search with an official model name")
    if require_tag and len(parts) != 2:
        raise CatalogSelectionError("An explicit model tag is required")
    return parts[0], parts[1] if len(parts) == 2 else ""


def search_summary_models(query: str) -> dict:
    family_query, tag_query = _split_query(query)
    deadline = time.monotonic() + 18
    families, has_more = _search_families(family_query, deadline)
    if tag_query:
        families = [item for item in families if item["family"] == family_query]
        has_more = False
    results = []
    has_more = has_more or len(families) > _MAX_FAMILIES
    for family in families[:_MAX_FAMILIES]:
        tags = _family_tags(family["family"], deadline)
        if tag_query:
            tags = [item for item in tags if item["model"].split(":", 1)[1] == tag_query]
        else:
            tags.sort(key=lambda item: (item["model"].endswith(":latest"), "-" in item["model"].split(":", 1)[1]))
        has_more = has_more or len(tags) > _MAX_TAGS_PER_FAMILY
        for item in tags[:_MAX_TAGS_PER_FAMILY]:
            results.append({"model": item["model"], "label": item["model"],
                            "description": family["description"], "size": item["size"]})
    return {"models": results[:_MAX_RESULTS], "has_more": has_more or len(results) > _MAX_RESULTS, "source": SOURCE}


def verify_summary_catalog_model(model: str) -> None:
    family, tag = _split_query(model, require_tag=True)
    if is_cloud_ollama_model(model):
        raise CatalogSelectionError("Cloud models cannot be registered")
    deadline = time.monotonic() + 18
    families, _ = _search_families(family, deadline)
    if not any(item["family"] == family for item in families):
        raise CatalogSelectionError("Not an official local text model")
    if not any(item["model"] == model for item in _family_tags(family, deadline)):
        raise CatalogSelectionError("Model tag is not available locally")
    manifest_url = f"https://registry.ollama.ai/v2/library/{family}/manifests/{tag}"
    try:
        manifest = json.loads(_read(manifest_url, deadline, json_document=True))
    except (ValueError, TypeError) as exc:
        raise CatalogUnavailableError("Unrecognized registry manifest") from exc
    if not isinstance(manifest, dict) or not isinstance(manifest.get("layers"), list):
        raise CatalogUnavailableError("Unrecognized registry manifest")
    if not any(isinstance(layer, dict) and layer.get("mediaType") == "application/vnd.ollama.image.model"
               and isinstance(layer.get("size"), int) and layer["size"] > 0 for layer in manifest["layers"]):
        raise CatalogSelectionError("Model has no local weights")
