"""Summary fields shared by the screen and every export format."""

# Match JavaScript String.trim, including BOM but excluding Python-only whitespace (e.g. NEL).
_TOPIC_TRIM_CHARS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _clean_topic(value: object) -> str:
    return value.strip(_TOPIC_TRIM_CHARS) if isinstance(value, str) else ""


def get_display_topics(summary: dict | None) -> list[str]:
    """Topics listed under "주요 주제".

    Topic section titles supersede summary keywords: generating topic sections appends their
    titles to ``topics``, so listing both repeats near-identical items next to the
    topic-section block. Compare Unicode lowercase without locale-specific or case-fold
    expansion; retain the first spelling and never rewrite source data.
    Mirrors ``getDisplayTopics`` in desktop-app/src/meetingGeneration.ts.
    """
    summary = summary or {}
    section_topics = [
        _clean_topic(section.get("topic"))
        for section in summary.get("topic_sections") or []
        if isinstance(section, dict)
    ]
    section_topics = [topic for topic in section_topics if topic]
    source = section_topics or [topic for value in summary.get("topics") or [] if (topic := _clean_topic(value))]
    seen: set[str] = set()
    topics: list[str] = []
    for topic in source:
        key = topic.lower()
        if key in seen:
            continue
        seen.add(key)
        topics.append(topic)
    return topics
