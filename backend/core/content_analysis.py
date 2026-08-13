import textstat
from bs4 import BeautifulSoup


def _strip_html(html: str) -> str:
    return BeautifulSoup(html or "", "html.parser").get_text(separator=" ").strip()


def compute_readability(html_content: str) -> dict:
    """Synchronous readability analysis. Call via asyncio.to_thread."""
    soup = BeautifulSoup(html_content, "html.parser")
    text = soup.get_text(separator=" ")
    words = text.split()
    if len(words) < 20:
        return {"error": "Content too short to analyze"}
    return {
        "flesch_reading_ease": round(textstat.flesch_reading_ease(text), 1),
        "flesch_kincaid_grade": round(textstat.flesch_kincaid_grade(text), 1),
        "gunning_fog": round(textstat.gunning_fog(text), 1),
        "avg_sentence_length": round(textstat.avg_sentence_length(text), 1),
        "avg_syllables_per_word": round(textstat.avg_syllables_per_word(text), 2),
        "reading_time_minutes": round(len(words) / 200, 1),
        "word_count": len(words),
    }
