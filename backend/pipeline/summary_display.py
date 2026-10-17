"""Summary fields shared by the screen and every export format."""


def get_display_topics(summary: dict | None) -> list[str]:
    """Topics listed under "주요 주제".

    Topic section titles supersede summary keywords: generating topic sections appends their
    titles to ``topics``, so listing both repeats near-identical items next to the
    topic-section block. Mirrors ``getDisplayTopics`` in desktop-app/src/meetingGeneration.ts.
    """
    summary = summary or {}
    section_topics = [
        str(section.get("topic") or "").strip()
        for section in summary.get("topic_sections") or []
        if isinstance(section, dict)
    ]
    section_topics = [topic for topic in section_topics if topic]
    source = section_topics or [
        topic.strip() for topic in summary.get("topics") or [] if isinstance(topic, str) and topic.strip()
    ]
    seen: set[str] = set()
    topics: list[str] = []
    for topic in source:
        key = topic.casefold()
        if key in seen:
            continue
        seen.add(key)
        topics.append(topic)
    return topics
